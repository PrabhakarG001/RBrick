// Real isolated MQTT -> Express adapter -> Python -> MongoDB -> REST/Socket.IO.
// Use backend/scripts/verify-integration.js --phase=6; never use production DBs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import mqtt from 'mqtt';
import { io as ioc } from 'socket.io-client';
import { settings } from '../src/config/settings.js';
import { mongoose } from '../src/config/database.js';
import { createApp } from '../src/app.js';
import { ensureIndexes, SensorReading, Alert, Device, RiskAnalysis } from '../src/models/index.js';
import { startMqttV1 } from '../src/services/mqttServiceV1.js';
import { attachRealtime } from '../src/services/realtime.js';

const enabled = process.env.PIPELINE_TEST_URI && process.env.PIPELINE_TEST_MQTT_URL && process.env.PIPELINE_TEST_AI_URL;
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function wait(predicate, message) {
  const deadline = Date.now()+15000;
  while (!await predicate() && Date.now()<deadline) await pause(30);
  assert(await predicate(),message);
}

test('full Python pipeline: persistence, REST, sockets, dedup, AI failures and transaction recovery', {
  skip: !enabled, timeout: 90000,
}, async t => {
  const dbName = `resilliox_pipeline_test_${randomUUID().replaceAll('-','')}`;
  let server, proxy, realtime, subscriber, publisher, socket;
  await mongoose.connect(process.env.PIPELINE_TEST_URI,{ dbName, serverSelectionTimeoutMS:5000 });
  t.after(async () => {
    socket?.close();
    if (publisher) await publisher.endAsync(true);
    if (subscriber) await subscriber.endAsync(true);
    if (realtime) await new Promise(resolve => realtime.io.close(resolve));
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (proxy) { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); }
    assert(mongoose.connection.name.startsWith('resilliox_pipeline_test_'));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await ensureIndexes();
  let mode = 'normal';
  // Fault injection at the HTTP transport boundary; normal requests reach real Python.
  proxy = createServer(async (req,res) => {
    if (mode === 'timeout') { setTimeout(()=>res.end('{}'),500).unref(); return; }
    if (mode === 'unavailable') { res.writeHead(503); res.end('{}'); return; }
    if (mode === 'invalid') { res.end('{"risk_score":0}'); return; }
    try {
      const chunks=[]; for await (const chunk of req) chunks.push(chunk);
      const response=await fetch(process.env.PIPELINE_TEST_AI_URL+req.url,{ method:req.method,
        ...(req.method==='POST'?{headers:{'Content-Type':'application/json'},body:Buffer.concat(chunks)}:{}) });
      res.writeHead(response.status,{'Content-Type':'application/json'});
      res.end(await response.text());
    } catch { res.writeHead(503); res.end('{}'); }
  }).listen(0,'127.0.0.1');
  await once(proxy,'listening');
  const token='pipeline-test-token-'.repeat(2);
  const config=settings({ IOT_API_TOKEN:token, MQTT_ENABLED:'true', MQTT_PAYLOAD_FORMAT:'resilliox-v1',
    MQTT_URL:process.env.PIPELINE_TEST_MQTT_URL, MQTT_CLIENT_ID:`pipeline-${randomUUID()}`,
    MQTT_USERNAME:'backend',MQTT_PASSWORD:process.env.TEST_BACKEND_MQTT_PASSWORD,
    AI_SERVICE_URL:`http://127.0.0.1:${proxy.address().port}`,AI_TIMEOUT_MS:'200' });
  const status={ database:true,mqtt:false,persisted:0,rejected:0,persistenceFailures:0,socketClients:0 };
  server=createApp(config,status).listen(0,'127.0.0.1'); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  realtime=attachRealtime(server,config,status);
  subscriber=startMqttV1(config,status,{broadcast:realtime.broadcast});
  socket=ioc(base,{path:'/socket.io',auth:{token},transports:['websocket']});
  const received={sensor_update:[],risk_update:[],new_alert:[],device_status:[],sos_event:[]};
  for(const event of Object.keys(received)) socket.on(event,payload=>received[event].push(payload));
  await once(socket,'connect'); await wait(()=>status.mqtt,'MQTT subscription ready');
  publisher=mqtt.connect(config.mqttUrl,{ username:'simulator',password:process.env.TEST_SIMULATOR_MQTT_PASSWORD,
    reconnectPeriod:0 });
  await once(publisher,'connect');
  const deviceId='sim_node_01',root=`building/zoneA/${deviceId}`;
  const envelope=extra=>({schema_version:'1.0',message_id:randomUUID(),device_id:deviceId,
    building_id:'building01',zone_id:'zoneA',timestamp:new Date().toISOString(),source:'simulation',...extra});
  const telemetry=(sensors={},extra={})=>envelope({firmware_version:'sim-test',sensors:{temperature:24,
    humidity:50,mq2_raw:100,vibration_rms:0.05,sw420:false,pir:false,flame:false,sos:false,...sensors},health:{},...extra});
  const publish=(channel,data)=>publisher.publishAsync(`${root}/${channel}`,
    typeof data==='string'?data:JSON.stringify(data),{qos:1});
  const auth={Authorization:`Bearer ${token}`};
  const get=async(path,expected=200)=>{const response=await fetch(base+path,{headers:auth});
    assert.equal(response.status,expected,path);return response.json();};
  const reading=id=>SensorReading.findOne({eventId:id}).lean();
  const risk=id=>RiskAnalysis.findOne({messageId:id}).lean();

  const normal=telemetry(); await publish('telemetry',normal);
  await wait(()=>risk(normal.message_id),'Python analysis persisted');
  assert.equal((await risk(normal.message_id)).classification,'NORMAL');
  assert.equal((await risk(normal.message_id)).modelVersion,'python-rules-v1');
  assert.equal((await reading(normal.message_id)).analysisStatus,'complete');
  assert.equal((await get('/api/health')).ai,'available');
  assert.equal((await get('/api/devices')).items.length,1);
  assert.equal((await get('/api/readings/latest')).items.length,1);
  assert.equal((await get('/api/readings/history')).total,1);
  assert.equal((await get(`/api/devices/${deviceId}/latest`)).risk.modelVersion,'python-rules-v1');

  const emergency=telemetry({temperature:72,flame:true,sos:true});
  await publish('telemetry',emergency);
  await wait(async()=>await Alert.countDocuments()===3,'temperature/flame/SOS alerts');
  assert.equal((await risk(emergency.message_id)).classification,'CRITICAL');
  assert.equal((await get('/api/alerts/active')).total,3);
  const repeat=telemetry({temperature:72,flame:true,sos:true}); await publish('telemetry',repeat);
  await wait(()=>risk(repeat.message_id),'repeat risk stored');
  assert((await risk(repeat.message_id)).incidents.every(i=>i.recurrent));
  assert.equal(await Alert.countDocuments(),3,'persisted cooldown suppresses repeated incidents');
  const event=envelope({event:{kind:'sos',detail:'Clearly simulated integration SOS'}});
  await publish('events',event);await publish('events',event);
  await wait(async()=>await Alert.countDocuments()===4,'one explicit SOS event alert');
  await publish('telemetry',normal);
  await pause(200);
  assert.equal(await SensorReading.countDocuments({eventId:normal.message_id}),1);
  assert.equal(await RiskAnalysis.countDocuments({messageId:normal.message_id}),1);
  assert.equal(await SensorReading.countDocuments({eventId:event.message_id}),1);
  await publish('telemetry','not-json');
  await publish('telemetry',{...telemetry(),device_id:'other-device'});
  await wait(()=>status.rejected>=2,'invalid messages rejected');

  // No current risk or inferred alert is manufactured while Python fails.
  for(const [failure,code] of [['unavailable','unavailable'],['timeout','timeout'],['invalid','invalid_response']]) {
    mode=failure;
    const unavailable=telemetry();
    const before=await Alert.countDocuments(),riskEvents=received.risk_update.length;
    await publish('telemetry',unavailable);
    await wait(async()=>(await reading(unavailable.message_id))?.analysisStatus==='unavailable','telemetry durable without prediction');
    assert.equal((await reading(unavailable.message_id)).analysisError,code);
    assert.equal(await risk(unavailable.message_id),null);
    assert.equal(await Alert.countDocuments(),before);
    assert.equal(received.risk_update.length,riskEvents,'no fabricated risk broadcast');
    assert.equal((await get(`/api/devices/${deviceId}/latest`)).risk,null,'old prediction is not attached to latest reading');
    assert.equal((await get('/api/iot/summary')).risk.length,0,'summary omits outdated prediction during inference outage');
    assert.equal((await get('/api/health',503)).ai,'unavailable');
    mode='normal';
    // Reused IDs cannot overwrite the original durable telemetry on recovery.
    await publish('telemetry',{...unavailable,sensors:{...unavailable.sensors,temperature:75}});
    await wait(()=>risk(unavailable.message_id),'recovery prediction stored');
    assert.equal(await SensorReading.countDocuments({eventId:unavailable.message_id}),1);
    assert.equal(await RiskAnalysis.countDocuments({messageId:unavailable.message_id}),1);
    assert.equal((await risk(unavailable.message_id)).classification,'NORMAL');
    await wait(()=>received.risk_update.some(r=>r.messageId===unavailable.message_id),'recovery socket update');
    assert.equal(received.sensor_update.filter(r=>r.messageId===unavailable.message_id).at(-1).sensors.temperature,24);
  }

  // Real transaction rollback with an injected risk write failure, then broker retry.
  const rollback=telemetry();
  const originalCreate=RiskAnalysis.create;
  const beforeFailures=status.persistenceFailures;
  RiskAnalysis.create=async function(docs,...args) {
    if(docs[0].messageId===rollback.message_id) throw Error('injected risk write failure');
    return originalCreate.call(this,docs,...args);
  };
  try {
    await publish('telemetry',rollback);
    await wait(()=>status.persistenceFailures>beforeFailures,'database write failure reported');
    assert.equal(await reading(rollback.message_id),null,'transaction rolled back reading');
    assert(!received.sensor_update.some(r=>r.messageId===rollback.message_id),'no false success broadcast');
  } finally { RiskAnalysis.create=originalCreate; }
  await wait(()=>status.mqtt,'consumer reconnects after failed transaction');
  // MQTT 3.1.1 persistent-session QoS 1 redelivery must recover the same ID.
  await wait(()=>risk(rollback.message_id),'broker redelivery persisted after recovery');
  assert.equal(await SensorReading.countDocuments({eventId:rollback.message_id}),1);

  await publish('availability','offline');
  await wait(async()=>(await Device.findOne({deviceId}).lean())?.online===false,'offline state persisted');
  await wait(()=>received.device_status.some(m=>m.state==='offline'),'device_status socket event');
  assert.equal((await get('/api/devices')).items[0].online,false);
  assert.equal((await get('/api/iot/summary')).online,0);
  const system=await get('/api/system/status');
  assert.equal(system.online,0);assert.equal(system.ai.available,true);
  assert(system.counters.aiFailures>=3);
  for(const event of ['sensor_update','risk_update','new_alert','sos_event']) {
    assert(received[event].length>0,`${event} observed`);
    assert(received[event].every(m=>m.source==='simulation'),`${event} preserves simulation marker`);
  }
  const bad=ioc(base,{auth:{token:'wrong'},transports:['websocket'],reconnection:false});
  const denied=await new Promise(resolve=>{bad.on('connect',()=>resolve(false));bad.on('connect_error',()=>resolve(true));});
  bad.close();assert(denied,'bad socket token rejected');

  if(process.env.INTEGRATION_PYTHON){
    async function simulate(scenario,extra=[]){
      const child=spawn(process.env.INTEGRATION_PYTHON,['IoT/simulator/publish_test_data.py',
        '--host','127.0.0.1','--port',new URL(config.mqttUrl).port,
        '--zone-id','zoneA','--scenario',scenario,...(extra.length?extra:['--once'])],{
        cwd:new URL('../../',import.meta.url),windowsHide:true,
        env:{...process.env,MQTT_USERNAME:'simulator',MQTT_PASSWORD:process.env.TEST_SIMULATOR_MQTT_PASSWORD},stdio:['ignore','pipe','pipe'],
      });
      let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
      const [code]=await once(child,'exit');assert.equal(code,0,`simulator ${scenario}: ${output}`);
    }
    for(const [scenario,classification,factor] of [
      ['normal','NORMAL',null],['temperature','CRITICAL','temperature'],['mq2','CRITICAL','mq2_raw'],
      ['mpu6050','HIGH','vibration'],['sw420','LOW','sw420'],['pir','LOW','pir'],
      ['flame','CRITICAL','flame'],['sos','CRITICAL','sos'],['missing','LOW','fault'],
    ]){
      const before=await SensorReading.countDocuments();
      await simulate(scenario);
      await wait(async()=>await SensorReading.countDocuments()>before,`CLI ${scenario} reading stored`);
      const saved=await SensorReading.findOne({firmwareVersion:'sim-1.0.0'}).sort({receivedAt:-1}).lean();
      // Event records do not have firmwareVersion; select the actual telemetry.
      assert(saved,`CLI ${scenario} telemetry`);
      await wait(()=>risk(saved.eventId),`CLI ${scenario} Python result`);
      const result=await risk(saved.eventId);
      assert.equal(result.classification,classification,scenario);
      assert.equal(saved.source,'simulation');assert.equal(result.source,'simulation');
      assert.equal(result.zoneId,'zoneA');
      if(factor)assert(result.factors.some(item=>item.factor===factor),`${scenario} hazard explanation`);
      if(scenario==='missing')assert.equal(saved.sensors.temperature,null);
    }
    const rejected=status.rejected,beforeInvalid=await SensorReading.countDocuments();
    await simulate('invalid');await wait(()=>status.rejected>rejected,'CLI invalid reading rejected');
    assert.equal(await SensorReading.countDocuments(),beforeInvalid);
    await simulate('offline');await wait(async()=>(await Device.findOne({deviceId}).lean()).online===false,'CLI offline status');
    await simulate('online');
    assert(received.device_status.some(item=>item.state==='online'),'CLI online transition broadcast');
    const beforeContinuous=await SensorReading.find({firmwareVersion:'sim-1.0.0'}).distinct('_id');
    await simulate('sos',['--duration','0.3','--interval','0.1']);
    const continuousFilter={firmwareVersion:'sim-1.0.0',_id:mongoose.trusted({$nin:beforeContinuous})};
    await wait(async()=>await SensorReading.countDocuments(continuousFilter)>=3,'continuous simulator cycles stored');
    const cycles=await SensorReading.find(continuousFilter).lean();
    assert.equal(cycles.filter(item=>item.sensors.sos===true).length,1,'continuous SOS does not repeat by default');
    console.log('PASS actual Python simulator CLI: individual scenarios, missing/invalid, offline/online, continuous emergency fallback');
  }

  // Restart the Express app and MQTT adapter while retaining the same database.
  const savedCount=await SensorReading.countDocuments(),alertsCount=await Alert.countDocuments();
  socket.close();await subscriber.endAsync(true);
  await new Promise(resolve=>realtime.io.close(resolve));
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  server=createApp(config,status).listen(0,'127.0.0.1');await once(server,'listening');
  realtime=attachRealtime(server,config,status);status.mqtt=false;
  subscriber=startMqttV1(config,status,{broadcast:realtime.broadcast});
  await wait(()=>status.mqtt,'restarted Express MQTT consumer');
  const restarted=await fetch(`http://127.0.0.1:${server.address().port}/api/readings/history`,{headers:auth});
  assert.equal(restarted.status,200);assert.equal((await restarted.json()).total,savedCount);
  await publish('telemetry',normal);await pause(250);
  assert.equal(await SensorReading.countDocuments(),savedCount);assert.equal(await Alert.countDocuments(),alertsCount);
  const fresh=telemetry();await publish('telemetry',fresh);await wait(()=>risk(fresh.message_id),'new telemetry after Express restart');
  console.log('PASS Express/consumer restart: persisted history, durable deduplication and new Python analysis');
});
