// Native, isolated Windows verification. No production database/credentials used.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = path.join(root, '.docker-validation', `integration-${randomUUID()}`);
const bin = process.env.MOSQUITTO_DIRECTORY || 'C:/Program Files/mosquitto';
const children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const slash = value => value.replaceAll('\\', '/');
const port = 18887;
const phase = Number(process.argv.find(arg => arg.startsWith('--phase='))?.split('=')[1] || 4);
const aiPort = 18001;
const mongoPort = 27028;
function start(exe, args, env = process.env) {
  const child = spawn(exe, args, { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  children.push(child);
  return child;
}
async function run(exe, args, env = process.env) {
  const child = start(exe, args, env);
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(Error('Verification command failed')));
  });
}
async function open(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}
async function main() {
  if (![4,5,6,7,8,9,10].includes(phase)) throw Error('Use --phase=4 through --phase=10');
  if (phase >= 5) {
    if (await open(aiPort)) throw Error('Isolated Python test port already occupied');
    const python = process.env.INTEGRATION_PYTHON || path.join(root,'.docker-validation/python-venv/Scripts/python.exe');
    const service = start(python, ['-m','uvicorn','ai_ml.main:app','--host','127.0.0.1','--port',String(aiPort)],
      { ...process.env, RISK_THRESHOLDS_JSON: '{}', AI_SERVICE_TOKEN: '' });
    let error;
    service.once('error', value => { error = value; });
    service.stdout.resume(); service.stderr.resume();
    const url = `http://127.0.0.1:${aiPort}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; ++attempt) {
      if (error || service.exitCode !== null) throw Error('Python service startup failed');
      try {
        const response = await fetch(url + '/health');
        healthy = response.ok && (await response.json()).trained_model === false;
        if (healthy) break;
      } catch {}
      await pause(100);
    }
    assert(healthy, 'Python HTTP health failed');
    const input = { schema_version: '1.0', message_id: randomUUID(), device_id: 'sim_node_01',
      zone_id: 'zoneA', building_id: 'building01', timestamp: new Date().toISOString(), source: 'simulation',
      sensors: { temperature: 24, humidity: 50, mq2_raw: 100, vibration_rms: 0,
        sw420: false, pir: false, flame: false, sos: false }, health: {} };
    const predict = body => fetch(url + '/predict', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const normal = await predict(input);
    assert.equal(normal.status, 200); assert.equal((await normal.json()).risk_level, 'NORMAL');
    input.sensors.sos = true;
    const sos = await predict(input);
    assert.equal(sos.status, 200); assert.equal((await sos.json()).risk_level, 'CRITICAL');
    assert.equal((await predict({})).status, 422);
    console.log('PASS actual Uvicorn HTTP health, normal/SOS predictions and invalid request rejection');
    if (phase === 5) return;
  }
  if (await open(port)) throw Error('Isolated test broker port already occupied');
  await mkdir(dir, { recursive: true });
  const backendPassword = randomBytes(24).toString('base64');
  const simulatorPassword = randomBytes(24).toString('base64');
  const passwordFile = path.join(dir,'password_file');
  await writeFile(passwordFile, `backend:${backendPassword}\nsimulator:${simulatorPassword}\n`);
  await run(path.join(bin,'mosquitto_passwd.exe'), ['-H','sha512-pbkdf2','-U',passwordFile]);
  const config = path.join(dir,'mosquitto.conf');
  await writeFile(config, `listener ${port} 127.0.0.1\nallow_anonymous false\npassword_file ${slash(passwordFile)}\nacl_file ${slash(path.join(root,'mqtt/acl.example'))}\nlog_dest stdout\n`);
  const broker = start(path.join(bin,'mosquitto.exe'), ['-c',config]);
  let failure;
  broker.once('error', error => { failure = error; });
  broker.stdout.resume(); broker.stderr.resume();
  for (let attempts = 0; !await open(port); ++attempts) {
    if (failure || broker.exitCode !== null || attempts > 50) throw Error('Test broker startup failed');
    await pause(100);
  }
  const env = { ...process.env, DASHBOARD_TEST_URI: '', PIPELINE_TEST_URI: '', PIPELINE_TEST_MQTT_URL: '',
    MQTT_V1_TEST_URL: `mqtt://127.0.0.1:${port}`, TEST_BACKEND_MQTT_PASSWORD: backendPassword,
    TEST_SIMULATOR_MQTT_PASSWORD: simulatorPassword };
  if (phase >= 6) {
    if (await open(mongoPort)) throw Error('Isolated MongoDB test port already occupied');
    const dbpath = path.join(dir,'mongo');
    await mkdir(dbpath);
    const mongod = process.env.INTEGRATION_MONGOD || 'C:/Program Files/MongoDB/Server/8.2/bin/mongod.exe';
    const mongo = start(mongod, ['--replSet','resilliox_test','--port',String(mongoPort),
      '--bind_ip','127.0.0.1','--dbpath',dbpath,'--logpath',path.join(dir,'mongo.log')]);
    let error;
    mongo.once('error', value => { error = value; });
    mongo.stdout.resume(); mongo.stderr.resume();
    const admin = new mongoose.mongo.MongoClient(`mongodb://127.0.0.1:${mongoPort}/?directConnection=true`,
      { serverSelectionTimeoutMS: 500 });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 30; ++attempt) {
        if (error || mongo.exitCode !== null) throw Error('Test MongoDB startup failed');
        try { await admin.connect(); ready = true; break; } catch { await pause(200); }
      }
      assert(ready, 'MongoDB startup timed out');
      await admin.db('admin').command({ replSetInitiate: { _id: 'resilliox_test',
        members: [{ _id: 0, host: `127.0.0.1:${mongoPort}` }] } });
      ready = false;
      for (let attempt = 0; attempt < 100; ++attempt) {
        if ((await admin.db('admin').command({ hello: 1 })).isWritablePrimary) { ready = true; break; }
        await pause(100);
      }
      assert(ready, 'MongoDB replica set primary not ready');
    } finally { await admin.close(); }
    env.PIPELINE_TEST_URI = `mongodb://127.0.0.1:${mongoPort}/?replicaSet=resilliox_test`;
    // Keep unrelated camera/dashboard database suites gated. This batch runs
    // its real database coverage through the Phase 6 pipeline test below.
    env.PIPELINE_TEST_MQTT_URL = env.MQTT_V1_TEST_URL;
    env.PIPELINE_TEST_AI_URL = `http://127.0.0.1:${aiPort}`;
    if(phase>=8)env.DASHBOARD_TEST_URI=env.PIPELINE_TEST_URI;
    if(phase>=10){
      env.INTEGRATION_PYTHON=process.env.INTEGRATION_PYTHON || path.join(root,'.docker-validation/python-venv/Scripts/python.exe');
      env.RESTART_TEST_DB=`resilliox_ui_test_${randomUUID().replaceAll('-','')}`;
    }
    // Native broker tests share the ACL's simulator ID; run files sequentially.
    if (phase === 6) await run(process.execPath, ['--test','--test-concurrency=1','backend/test/*.test.js'], env);
    else {
      if(phase>=8)await run(process.execPath,['--test','--test-concurrency=1','backend/test/*.test.js'],env);
      env.INTEGRATION_PHASE = String(phase);
      await run(process.execPath, ['backend/scripts/verify-dashboard.js'], env);
      if(phase>=10){
        const snapshot=async()=>{
          const client=new mongoose.mongo.MongoClient(env.PIPELINE_TEST_URI,{serverSelectionTimeoutMS:1000});
          try{
            await client.connect();const db=client.db(env.RESTART_TEST_DB),data={};
            for(const {name} of (await db.listCollections().toArray()).sort((a,b)=>a.name.localeCompare(b.name)))
              data[name]=await db.collection(name).find().sort({_id:1}).toArray();
            assert(data.sensorreadings?.length>0);assert(data.riskanalyses?.length>0);
            assert(data.alerts?.length>0);assert(data.maintenancetasks?.length>0);
            return createHash('sha256').update(JSON.stringify(data)).digest('hex');
          }finally{await client.close();}
        };
        const before=await snapshot();
        // Only child services created by this runner; retain the same Mongo dbpath.
        const owned=children.filter(child=>child.pid && child.exitCode===null && child.signalCode===null);
        await Promise.all(owned.map(child=>new Promise(resolve=>{child.once('close',resolve);child.kill('SIGKILL');})));
        for(const [exe,args] of [
          [mongod,['--replSet','resilliox_test','--port',String(mongoPort),'--bind_ip','127.0.0.1','--dbpath',dbpath,'--logpath',path.join(dir,'mongo.log'),'--logappend']],
          [path.join(bin,'mosquitto.exe'),['-c',config]],
          [env.INTEGRATION_PYTHON,['-m','uvicorn','ai_ml.main:app','--host','127.0.0.1','--port',String(aiPort)]],
        ]){const child=start(exe,args,{...process.env,RISK_THRESHOLDS_JSON:'{}',AI_SERVICE_TOKEN:''});child.stdout.resume();child.stderr.resume();}
        let recovered=false;
        for(let i=0;i<150;i++){
          try{if(await open(port) && (await fetch(env.PIPELINE_TEST_AI_URL+'/health')).ok && await snapshot()===before){recovered=true;break;}}catch{}
          await pause(200);
        }
        assert(recovered,'owned services recover with all stored documents unchanged');
        // Verify Python still accepts telemetry following restart, not just liveness.
        const input={schema_version:'1.0',message_id:randomUUID(),device_id:'sim_node_01',zone_id:'zoneA',building_id:'building01',
          timestamp:new Date().toISOString(),source:'simulation',sensors:{temperature:24,humidity:50,mq2_raw:100,vibration_rms:0,sw420:false,pir:false,flame:false,sos:false},health:{}};
        const response=await fetch(env.PIPELINE_TEST_AI_URL+'/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
        assert.equal(response.status,200);assert.equal((await response.json()).risk_level,'NORMAL');
        await run(process.execPath,['--test','backend/test/pipeline.test.js'],env);
        console.log('PASS owned MongoDB, Mosquitto and Python process restart; readings, risks, alerts, snapshots and completed maintenance unchanged');
      }
    }
  } else await run(process.execPath, ['--test','backend/test/mqttV1.test.js'], env);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => {
    await Promise.all(children.filter(child => child.pid && child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => {
      child.once('close',resolve); child.kill('SIGKILL');
    })));
    // Only our generated database directory, after owned processes have closed.
    // Keep logs/configuration, but do not accumulate WiredTiger journals per run.
    const candidate=path.join(dir,'mongo');
    try {
      const target=await realpath(candidate);
      const expected=await realpath(dir);
      const parent=await realpath(path.join(root,'.docker-validation'));
      assert.equal(path.dirname(expected),parent);
      assert.match(path.basename(expected),/^integration-[0-9a-f-]{36}$/);
      assert.equal(path.dirname(target),expected); assert.equal(path.basename(target),'mongo');
      await rm(target,{recursive:true,force:true});
    } catch(error) { if(error.code!=='ENOENT') {console.error('Test database cleanup failed');process.exitCode=1;} }
  });
