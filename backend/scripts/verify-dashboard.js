// Real browser + real REST/MQTT/Python/database. Called by isolated test runner.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mqtt from 'mqtt';
import { mongoose } from '../src/config/database.js';
import { settings } from '../src/config/settings.js';
import { ensureIndexes, SensorReading, RiskAnalysis, Device, MaintenanceTask } from '../src/models/index.js';
import { createApp } from '../src/app.js';
import { attachRealtime } from '../src/services/realtime.js';
import { startMqttV1 } from '../src/services/mqttServiceV1.js';
import { createAiServiceClient, AiServiceError } from '../src/services/aiServiceClient.js';

const root=fileURLToPath(new URL('../../',import.meta.url));
const dir=path.join(root,'.docker-validation',`dashboard-live-${randomUUID()}`);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const processes=[];
let ws,server,realtime,subscriber,publisher,diagnostic,camera;
const dbName=process.env.RESTART_TEST_DB || `rbrick_ui_test_${randomUUID().replaceAll('-','')}`;
assert.match(dbName,/^rbrick_ui_test_[a-f0-9]+$/);
const token=`ui-test-${randomUUID()}`;
let aiUnavailable=false;
function start(exe,args,cwd=root,env=process.env) {
  const child=spawn(exe,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  processes.push(child); child.stdout.resume(); child.stderr.resume();
  child.on('error',error=>console.error('Test process failed:',error.code));
  return child;
}
async function wait(check,label) {
  for(let i=0;i<300;i++){if(await check())return;await pause(100);}
  throw Error(`Timed out: ${label}`);
}
async function main() {
  await mkdir(dir,{recursive:true});
  await mongoose.connect(process.env.PIPELINE_TEST_URI,{dbName,serverSelectionTimeoutMS:5000});
  await ensureIndexes();
  const phase=Number(process.env.INTEGRATION_PHASE || 7);
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  let cameraMode='online';
  if(phase>=8){
    camera=createServer((req,res)=>{
      if(req.headers.authorization!=='Bearer camera-simulation-test-token'){res.writeHead(401);res.end();return;}
      if(cameraMode==='offline'){res.writeHead(503);res.end();return;}
      res.writeHead(200,{'Content-Type':'image/png'});res.end(image);
    }).listen(0,'127.0.0.1');await once(camera,'listening');
  }
  const config=settings({IOT_API_TOKEN:token,MQTT_ENABLED:'true',MQTT_URL:process.env.PIPELINE_TEST_MQTT_URL,
    MQTT_CLIENT_ID:`ui-backend-${randomUUID()}`,MQTT_USERNAME:'backend',MQTT_PASSWORD:process.env.TEST_BACKEND_MQTT_PASSWORD,
    AI_SERVICE_URL:process.env.PIPELINE_TEST_AI_URL,DEVICE_OFFLINE_AFTER_SECONDS:'10',
    CAMERA_SNAPSHOT_URLS_JSON:camera?JSON.stringify({sim_node_01:`http://127.0.0.1:${camera.address().port}/snapshot`}):'{}',
    CAMERA_BEARER_TOKENS_JSON:camera?JSON.stringify({sim_node_01:'camera-simulation-test-token'}):'{}'});
  const status={database:true,mqtt:false,persisted:0,rejected:0,persistenceFailures:0,socketClients:0};
  const ai=createAiServiceClient(config,status);
  server=createApp(config,status).listen(0,'127.0.0.1');await once(server,'listening');
  const api=`http://127.0.0.1:${server.address().port}`;
  realtime=attachRealtime(server,config,status);
  subscriber=startMqttV1(config,status,{broadcast:realtime.broadcast,predict:async(...args)=>{
    if(aiUnavailable)throw new AiServiceError('unavailable');return ai.predict(...args);
  }});
  await wait(()=>status.mqtt,'broker subscription');
  publisher=mqtt.connect(config.mqttUrl,{username:'simulator',password:process.env.TEST_SIMULATOR_MQTT_PASSWORD,reconnectPeriod:0});
  await once(publisher,'connect');
  start(process.execPath,[path.join(root,'Frontend/node_modules/vite/bin/vite.js'),'--host','127.0.0.1','--port','5179','--strictPort'],
    path.join(root,'Frontend'),{...process.env,API_PROXY_TARGET:api});
  const base='http://127.0.0.1:5179';
  await wait(async()=>{try{return(await fetch(base)).ok;}catch{return false;}},'Vite server');
  start(process.env.INTEGRATION_BROWSER || 'C:/Program Files/Google/Chrome/Application/chrome.exe',[
    '--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
    '--remote-debugging-port=9237',`--user-data-dir=${path.join(dir,'browser')}`,base+'/dashboard']);
  let target;
  await wait(async()=>{try{target=(await(await fetch('http://127.0.0.1:9237/json')).json()).find(t=>t.type==='page'&&t.url.startsWith(base));return!!target;}catch{return false;}},'browser debugging page');
  ws=new WebSocket(target.webSocketDebuggerUrl);await once(ws,'open');
  let sequence=0;const pending=new Map(),errors=[];
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){const call=pending.get(message.id);pending.delete(message.id);message.error?call.reject(Error(message.error.message)):call.resolve(message.result);}
    else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  });
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
  const contains=text=>evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`);
  diagnostic=async()=>console.error('Browser diagnostic:',await evaluate('document.body.innerText.slice(0,1200)'),errors.slice(0,3));
  const visible=async text=>wait(()=>contains(text),text);
  const click=text=>evaluate(`[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)})?.click()`);
  const set=(label,value)=>evaluate(`(()=>{const field=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)}))?.querySelector('input,textarea,select');if(!field)throw Error('Missing test field');const proto=field.tagName==='SELECT'?HTMLSelectElement.prototype:field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(field,${JSON.stringify(value)});field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`);
  for(const method of ['Page.enable','Runtime.enable','Network.enable'])await send(method);
  await send('Page.navigate',{url:base+'/dashboard'});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await visible('Connect to load your building data.');
  await evaluate(`(()=>{const input=document.querySelector('input[type=password]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(token)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await click('Connect');await visible('Database: connected');await visible('No sensor readings available.');
  console.log('PASS React initial authenticated REST loading and honest empty state');
  const deviceId='sim_node_01';
  const telemetry=(extra={},overrides={})=>({schema_version:'1.0',message_id:randomUUID(),device_id:deviceId,
    building_id:'building01',zone_id:'zoneA',timestamp:new Date().toISOString(),source:'simulation',firmware_version:'sim-ui',
    sensors:{temperature:24,humidity:50,mq2_raw:100,vibration_rms:0.05,sw420:false,pir:false,flame:false,sos:false,...extra},health:{},...overrides});
  const publish=(channel,data)=>publisher.publishAsync(`building/zoneA/${deviceId}/${channel}`,
    typeof data==='string'?data:JSON.stringify(data),{qos:1});
  let message=telemetry();
  if(phase>=10){
    const child=start(process.env.INTEGRATION_PYTHON,['IoT/simulator/publish_test_data.py','--once',
      '--zone-id','zoneA','--host','127.0.0.1','--port',new URL(config.mqttUrl).port],root,
      {...process.env,MQTT_USERNAME:'simulator',MQTT_PASSWORD:process.env.TEST_SIMULATOR_MQTT_PASSWORD});
    const [code]=await once(child,'exit');assert.equal(code,0,'actual simulator publishes browser demo telemetry');
  }else await publish('telemetry',message);
  await visible('Device sim_node_01');await visible('python-rules-v1');await visible('Score 0/100');await visible('Simulated data');
  console.log('PASS first live device appears without refresh; real Python NORMAL prediction and simulation label');
  if(phase>=10){
    await click('Monitoring');
    for(const [sensors,text] of [
      [{mq2_raw:2800},'2800'],[{vibration_rms:2.8},'2.8'],
      [{sw420:true},'Triggered'],[{pir:true},'Motion detected'],
      [{temperature:null},'Sensor health: missing'],
    ]){
      const sample=telemetry(sensors,sensors.temperature===null?{health:{temperature:'missing'}}:{});
      await publish('telemetry',sample);
      await wait(()=>RiskAnalysis.exists({messageId:sample.message_id}),'individual sensor analysis');
      await visible(text);
    }
    await click('Overview');
    console.log('PASS individual gas raw, MPU RMS, SW-420, PIR and missing-temperature telemetry reach React');
  }
  await publish('telemetry',telemetry({temperature:72,flame:true,sos:true}));
  await visible('SOS emergency - sim_node_01 - Simulated data');await visible('Critical');await visible('Potential flame indication');
  console.log('PASS live hazard descriptions, Python severity and simulated SOS notification');
  aiUnavailable=true;message=telemetry();await publish('telemetry',message);
  await visible('Python risk analysis unavailable for the latest reading. No risk score was generated.');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Risk analysis"]').innerText.includes('Score ')`),false);
  aiUnavailable=false;
  await publish('telemetry',telemetry({}, {timestamp:new Date(Date.now()-600000).toISOString()}));
  // Latest live data must reflect stale observed time even when recently received.
  await visible('Stored / stale telemetry');
  await publish('availability','offline');await visible('Device offline');
  console.log('PASS unavailable inference hides old scores; stale observations and explicit offline state are visible');
  await send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
  for(const socket of realtime.io.sockets.sockets.values())socket.conn.close();
  await visible('reconnecting, polling fallback active');
  message=telemetry({temperature:31});await publish('telemetry',message);
  await wait(()=>RiskAnalysis.exists({messageId:message.message_id}),'missed reading stored');
  await send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});
  await visible('connected (Socket.IO)');
  await wait(()=>evaluate(`document.body.innerText.includes('31') && !document.body.innerText.includes('Device offline')`),'authoritative reconnect refetch');
  console.log('PASS Socket.IO reconnect refetches readings published while the browser was offline');
  if(phase>=8){
    await Device.updateOne({deviceId},{$set:{floorId:'floor2'}});
    await publish('camera/status',{schema_version:'1.0',message_id:randomUUID(),device_id:deviceId,
      timestamp:new Date().toISOString(),source:'simulation',state:'online'});
    await wait(async()=>(await Device.findOne({deviceId}).lean())?.cameraSource==='simulation','camera MQTT status');
    await click('Monitoring');await visible('Cameras (ESP32-CAM)');await visible('Capture snapshot');
    await click('Capture snapshot');
    await wait(()=>evaluate("document.querySelector('.safety-camera-card img')?.naturalWidth===1"),'authorized simulated snapshot decoded');
    await click('Refresh');await pause(300);
    await wait(()=>evaluate("document.querySelector('.safety-camera-card img')?.naturalWidth===1"),'snapshot survives authoritative refresh');
    cameraMode='offline';await click('Capture snapshot');await visible('Snapshot failed:');cameraMode='online';
    console.log('PASS MQTT camera source/status, authenticated simulated snapshot, refresh persistence and disconnection error');
    await publish('telemetry',telemetry({temperature:72,flame:true,sos:true}));
    await click('Incidents');await visible('Details');await click('Details');await visible('Incident details');
    await evaluate("[...document.querySelectorAll('summary')].find(e=>e.textContent==='Create maintenance request from incident').click()");
    await set('Maintenance description','Approved simulated sensor inspection');
    await set('Maintenance due date','2026-10-23T12:00');
    await click('Approve maintenance request');await visible('Active maintenance request already linked:');
    const task=await MaintenanceTask.findOne({description:'Approved simulated sensor inspection'}).lean();
    assert(task?.alertId);assert.equal(task.source,'simulation');assert.equal(task.floorId,'floor2');
    await click('Maintenance');await visible('Approved simulated sensor inspection');await visible('Floor floor2');
    await click('Start');await visible('in_progress');await click('Complete');await visible('completed');
    console.log('PASS authorized alert-to-maintenance creation, location/risk/source display and existing start/complete workflow');
  }
  for(const [width,height] of [[1440,1000],[390,844]]){
    if(phase>=10){await click('Monitoring');await visible('TEMPERATURE (DHT22)');await visible('PIR MOTION');await visible('MQ-2 RAW ADC');}
    await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<768});
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false,`overflow at ${width}`);
    const screenshot=await send('Page.captureScreenshot',{format:'png'});
    await writeFile(path.join(dir,`dashboard-${width}.png`),Buffer.from(screenshot.data,'base64'));
  }
  assert.deepEqual(errors,[],'no browser runtime exceptions');
  console.log('PASS desktop/mobile layout bounds and browser runtime checks');
}
try { await main(); }
catch(error){console.error(error.stack);if(diagnostic)await diagnostic();process.exitCode=1;}
finally {
  ws?.close();
  if(publisher)await publisher.endAsync(true);
  if(subscriber)await subscriber.endAsync(true);
  if(realtime)await new Promise(resolve=>realtime.io.close(resolve));
  if(server?.listening)await new Promise(resolve=>server.close(resolve));
  if(camera)await new Promise(resolve=>camera.close(resolve));
  for(const child of processes)if(child.exitCode===null)child.kill('SIGKILL');
  if(mongoose.connection.readyState===1){assert(mongoose.connection.name===dbName);if(!process.env.RESTART_TEST_DB)await mongoose.connection.dropDatabase();await mongoose.disconnect();}
}
