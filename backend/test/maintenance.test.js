import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mongoose } from '../src/config/database.js';
import { settings } from '../src/config/settings.js';
import { createApp } from '../src/app.js';
import { ensureIndexes,Device,Alert,SensorReading,MaintenanceTask } from '../src/models/index.js';

test('authorized incident approval creates linked maintenance once and preserves existing status workflows',{
  skip:!process.env.DASHBOARD_TEST_URI,timeout:20000,
},async t=>{
  const dbName=`rbrick_maintenance_test_${randomUUID().replaceAll('-','')}`;
  await mongoose.connect(process.env.DASHBOARD_TEST_URI,{dbName});
  t.after(async()=>{assert.equal(mongoose.connection.name,dbName);await mongoose.connection.dropDatabase();await mongoose.disconnect();});
  await ensureIndexes();
  await Device.create({deviceId:'sim_node_01',buildingId:'b1',floorId:'floor2',zoneId:'z1'});
  const reading=await SensorReading.create({deviceId:'sim_node_01',observedAt:new Date(),receivedAt:new Date(),
    sensors:{temperature:60},topic:'simulation',buildingId:'b1',zoneId:'z1',source:'simulation'});
  const incident=await Alert.create({deviceId:'sim_node_01',readingId:reading._id,kind:'safety',field:'temperature',
    message:'Simulated temperature hazard',observedAt:new Date(),zoneId:'z1',incidentId:'simulation-temperature',
    source:'simulation',riskScore:65,riskClassification:'HIGH'});
  const config=settings({IOT_API_TOKEN:'maintenance-test-token-'.repeat(2)});
  const server=createApp(config,{database:true,mqtt:false}).listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/api/iot`;
  const body={description:'Inspect simulated hazard',priority:'high',dueAt:new Date(Date.now()+86400000).toISOString()};
  const post=()=>fetch(`${url}/alerts/${incident._id}/maintenance`,{method:'POST',headers:{Authorization:`Bearer ${config.apiToken}`,'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await fetch(`${url}/alerts/${incident._id}/maintenance`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,401);
  const results=await Promise.all([post(),post()]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  const task=await MaintenanceTask.findOne().lean();
  assert.equal(String(task.alertId),String(incident._id));assert.equal(task.zoneId,'z1');assert.equal(task.floorId,'floor2');
  assert.equal(task.buildingId,'b1');assert.equal(task.riskScore,65);assert.equal(task.source,'simulation');
  const patch=async(id,status)=>fetch(`${url}/tasks/${id}`,{method:'PATCH',headers:{Authorization:`Bearer ${config.apiToken}`,'Content-Type':'application/json'},body:JSON.stringify({status})});
  assert.equal((await patch(task._id,'in_progress')).status,200);assert.equal((await post()).status,409);
  assert.equal((await patch(task._id,'completed')).status,200);assert.equal((await post()).status,201);
  assert.equal((await patch(task._id,'open')).status,409,'cannot reopen into a second active request');
  await Alert.updateOne({_id:incident._id},{$set:{resolvedAt:new Date()}});
  assert.equal((await post()).status,409,'resolved incident rejected');
  const manual=await fetch(`${url}/tasks`,{method:'POST',headers:{Authorization:`Bearer ${config.apiToken}`,'Content-Type':'application/json'},body:JSON.stringify({...body,deviceId:'sim_node_01'})});
  assert.equal(manual.status,201);
  assert.equal((await manual.json()).item.floorId,'floor2','manual tasks also inherit registered device location');
});
