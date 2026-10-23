import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mongoose } from '../src/config/database.js';
import { createApp } from '../src/app.js';
import { settings } from '../src/config/settings.js';
import { ensureIndexes,Device,Alert,CameraSnapshot } from '../src/models/index.js';
import { SecurityEvent,SecurityZone,SecurityAudit,Visitor,VisitorVisit,SecurityRule,SecurityNotification } from '../src/models/security.js';
import { ensureSecurityRules,outsideHours,processSecurityEvent,reconcileSecurityCameras,DEMO_SCOPE } from '../src/services/securityService.js';

test('security operating hours handle time zones, weekdays and overnight shifts',()=>{
  const zone={timeZone:'UTC'},rule={days:[1],startMinute:22*60,endMinute:6*60};
  assert.equal(outsideHours(new Date('2026-10-19T23:00:00Z'),zone,rule),false);
  assert.equal(outsideHours(new Date('2026-10-20T05:59:00Z'),zone,rule),false);
  assert.equal(outsideHours(new Date('2026-10-20T06:00:00Z'),zone,rule),true);
  assert.equal(outsideHours(new Date('2026-10-20T23:00:00Z'),zone,rule),true);
  assert.equal(outsideHours(new Date('2026-10-19T19:00:00Z'),{timeZone:'Asia/Kolkata'},rule),false);
});

test('security module persists simulation, rules, camera samples, visitor transitions, audits and scoped reset',{
  skip:!process.env.DASHBOARD_TEST_URI,timeout:90000,
},async t=>{
  const dbName=`rbrick_security_test_${randomUUID().replaceAll('-','')}`;
  let server;
  await mongoose.connect(process.env.DASHBOARD_TEST_URI,{dbName,serverSelectionTimeoutMS:5000});
  t.after(async()=>{
    if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    assert.equal(mongoose.connection.name,dbName);await mongoose.connection.dropDatabase();await mongoose.disconnect();
  });
  await ensureIndexes();await ensureSecurityRules();
  const operator='security-test-operator-token-'.repeat(2),deviceToken='security-test-device-token-'.repeat(2);
  const config=settings({IOT_API_TOKEN:operator,SECURITY_SIMULATION_ENABLED:'true',SECURITY_DEMO_RESET_ENABLED:'true',NODE_ENV:'test',
    SECURITY_DEVICE_TOKENS_JSON:JSON.stringify({hw_pir:deviceToken,hw_camera:deviceToken})});
  const status={database:true,mqtt:false};
  server=createApp(config,status).listen(0,'127.0.0.1');await once(server,'listening');
  let base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,method='GET',body,expected=200,token=operator){
    const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const text=await response.text();assert.equal(response.status,expected,`${method} ${path}: ${text.slice(0,300)}`);
    return response.headers.get('content-type')?.includes('json')?JSON.parse(text):text;
  }
  const api='/api/security';
  await call(api+'/overview','GET',undefined,401,'wrong');
  assert.equal((await call(api+'/overview')).totalCameras,0);
  await call(api+'/simulation/start','POST',{},200);await call(api+'/simulation/start','POST',{},200);
  assert.equal(await Device.countDocuments({securityDemoScope:DEMO_SCOPE}),2);
  assert.equal(await SecurityZone.countDocuments({demoScope:DEMO_SCOPE}),2);
  assert.equal((await call(api+'/overview')).onlineCameras,1);
  assert.equal((await call(api+'/cameras')).items[0].source,'simulation');
  await call(api+'/rules/off_hours','PATCH',{enabled:false});
  const eventId=randomUUID();
  const first=await call(api+'/simulation/motion','POST',{eventId},201);
  assert.equal(first.alerts[0].severity,'high');assert.equal(first.item.source,'simulation');
  const duplicate=await call(api+'/simulation/motion','POST',{eventId},200);assert(duplicate.duplicate);
  assert.equal(await SecurityEvent.countDocuments({eventId}),1);
  const batch=await Promise.all(Array.from({length:3},()=>call(api+'/simulation/motion','POST',{},201)));
  assert.equal(await Alert.countDocuments({kind:'security',field:'restricted_motion',resolvedAt:null}),1);
  assert.equal(await Alert.countDocuments({kind:'security',field:'repeated_motion',severity:'critical'}),1);
  assert.equal((await call(api+'/overview')).motionToday,4);
  await call(api+'/simulation/motion','POST',{active:false},201);
  assert.equal((await Device.findOne({deviceId:'security_sim_pir'})).motionActive,false);
  assert.equal((await call(api+'/motion-events?zoneId=security_demo_restricted&source=simulation&limit=2&page=2')).items.length,2);
  assert.equal((await call(api+'/events?search=manually&type=motion_detected')).total,4);
  assert.equal((await call(api+'/events?search=%5B')).total,0,'literal regex search is safe');
  await call(api+'/events?limit=101','GET',undefined,400);
  await call(api+'/simulation/motion','POST',{timestamp:'2020-01-01'},400);
  await call(api+'/simulation/access','POST',{},201);
  assert.equal(await Alert.countDocuments({field:'unauthorized_access',kind:'security'}),1);
  const alert=await Alert.findOne({field:'restricted_motion',kind:'security'});
  await call(`${api}/alerts/${alert.id}/resolve`,'POST',{},409);
  await call(`/api/iot/alerts/${alert.id}/resolve`,'PATCH',{resolution:'Bypass attempt'},409);
  await call(`${api}/alerts/${alert.id}/acknowledge`,'POST',{});
  await call(`${api}/alerts/${alert.id}/acknowledge`,'POST',{},409);
  await call(`${api}/alerts/${alert.id}/resolve`,'POST',{resolution:'Reviewed simulated event'});
  assert.equal((await Alert.findById(alert.id)).activeSecurityKey,undefined);
  assert.equal((await call(api+'/alerts?status=resolved')).total,1);
  assert((await call(api+'/audit-logs?search=Operator')).total>=2);
  const notification=(await call(api+'/notifications?status=unread')).items[0];
  await call(`${api}/notifications/${notification._id}/read`,'POST',{});
  assert.equal((await call(api+'/notifications?status=read')).total,1);
  await assert.rejects(SecurityAudit.updateOne({},{$set:{description:'rewrite'}}),/append-only/);

  const sample=await call('/api/iot/cameras/security_sim_camera/snapshots','POST',{},201);
  assert.equal(sample.item.source,'simulation');
  const image=await fetch(base+`/api/iot/cameras/snapshots/${sample.item._id}/image`,{headers:{Authorization:`Bearer ${operator}`}});
  assert.equal(image.status,200);assert.equal(image.headers.get('content-type'),'image/png');
  const bytes=Buffer.from(await image.arrayBuffer());assert(bytes.length>1000);assert.equal(bytes[0],137);
  await call(`/api/iot/cameras/snapshots/${sample.item._id}/image`,'GET',undefined,401,'wrong');
  assert.equal((await call(api+'/cameras/security_sim_camera/snapshots')).total,1);
  assert.equal(await SecurityEvent.countDocuments({type:'snapshot_captured'}),1);

  // Registration alone creates no active visit. All transition times are server-owned.
  const registered=await call(api+'/visitors','POST',{name:'=Example visitor',company:'Demo',purpose:'Inspection',simulation:true},201);
  const visitorId=registered.item.visitorId;
  assert.equal((await call(api+'/overview')).visitorsInside,0);
  await call(`${api}/visitors/${visitorId}/check-out`,'POST',{},409);
  await call(`${api}/visitors/${visitorId}`,'PATCH',{checkedInAt:'2020-01-01'},400);
  const responses=await Promise.all([1,2].map(()=>fetch(base+`${api}/visitors/${visitorId}/check-in`,{method:'POST',headers:{Authorization:`Bearer ${operator}`,'Content-Type':'application/json'},body:JSON.stringify({zoneId:'security_demo_lobby'})})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[201,409]);for(const r of responses)await r.text();
  assert.equal((await call(api+'/overview')).visitorsInside,1);
  assert.equal((await call(api+'/visitors?status=inside&search=Example')).total,1);
  const csv=await call(api+'/visitors/export?search=Example');assert(csv.includes("'=Example visitor"));
  const checkout=await call(`${api}/visitors/${visitorId}/check-out`,'POST',{});
  assert(new Date(checkout.item.checkedOutAt)>=new Date(checkout.item.checkedInAt));
  await call(`${api}/visitors/${visitorId}/check-out`,'POST',{},409);
  assert.equal((await call(`${api}/visitors/${visitorId}/visits`)).total,1);
  assert.equal((await call(api+'/events?type=visitor_checked_in')).total,1);
  assert.equal((await call(api+'/events?type=visitor_checked_out')).total,1);
  const realVisitor=await call(api+'/visitors','POST',{name:'Operator visitor'},201);
  assert.equal(realVisitor.item.source,'operator');

  // Hardware has its own bearer token, provisioned device/zone identity and UTC schema.
  await call(api+'/zones','POST',{zoneId:'hardware_zone',name:'Hardware test zone',restricted:true},201);
  await call(api+'/devices','POST',{deviceId:'hw_pir',zoneId:'hardware_zone',name:'Pending physical PIR',securityType:'pir'},201);
  await call(api+'/devices','POST',{deviceId:'hw_camera',zoneId:'hardware_zone',name:'Pending physical camera',securityType:'camera'},201);
  assert.equal((await call(api+'/cameras/hw_camera')).item.state,'unknown');
  const hardware={eventId:randomUUID(),deviceId:'hw_pir',zoneId:'hardware_zone',source:'hardware',timestamp:new Date().toISOString(),type:'motion_detected',description:'Protocol fixture only; no physical hardware used.'};
  await call(api+'/ingest/hw_pir','POST',hardware,401,operator);
  await call(api+'/ingest/hw_pir','POST',{...hardware,source:'simulation'},400,deviceToken);
  await call(api+'/ingest/hw_pir','POST',{...hardware,deviceId:'another'},403,deviceToken);
  await call(api+'/ingest/hw_pir','POST',{...hardware,zoneId:'security_demo_lobby'},409,deviceToken);
  await call(api+'/ingest/hw_pir','POST',hardware,201,deviceToken);
  await call(api+'/ingest/hw_pir','POST',hardware,200,deviceToken);
  const old={...hardware,eventId:randomUUID(),timestamp:new Date(Date.now()-600000).toISOString()};
  const history=await call(api+'/ingest/hw_pir','POST',old,201,deviceToken);assert(history.historical);
  await call(api+'/rules/off_hours','PATCH',{enabled:true,days:[(new Date().getUTCDay()+1)%7],startMinute:0,endMinute:0,severity:'high'});
  await call(api+'/ingest/hw_pir','POST',{...hardware,eventId:randomUUID()},201,deviceToken);
  assert.equal(await Alert.countDocuments({kind:'security',field:'off_hours',source:'hardware'}),1);
  const oldCameraTime=new Date(Date.now()-200000);
  await Device.updateOne({deviceId:'security_sim_camera'},{$set:{cameraOnline:true,cameraStatusAt:oldCameraTime}});
  await call(api+'/overview');await call(api+'/overview');
  assert.equal(await SecurityEvent.countDocuments({eventId:`timeout:security_sim_camera:${oldCameraTime.getTime()}`}),1);
  assert.equal(await Alert.countDocuments({field:'camera_offline',source:'simulation'}),1);
  const neverSeen=await Device.findOne({deviceId:'hw_camera'}).lean();assert.equal(neverSeen.cameraStatusAt,undefined);

  // Recreate Express and reconnect Mongoose to the same DB without clearing it.
  const eventCount=await SecurityEvent.countDocuments(),auditCount=await SecurityAudit.countDocuments();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await mongoose.disconnect();await mongoose.connect(process.env.DASHBOARD_TEST_URI,{dbName});
  server=createApp(config,status).listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await call(api+'/events')).total,eventCount);assert.equal((await call(api+'/audit-logs')).total,auditCount);
  assert.equal((await call(`${api}/visitors/${visitorId}/visits`)).total,1);
  assert.equal(await CameraSnapshot.countDocuments(),1);assert.equal((await Alert.findById(alert.id)).resolvedBy,'operator-token');
  await call(api+'/simulation/stop','POST',{});
  await call('/api/iot/cameras/security_sim_camera/snapshots','POST',{},409);
  await call(api+'/simulation/motion','POST',{},409);
  await call(api+'/simulation/reset','POST',{confirmation:'wrong'},400);
  await call(api+'/simulation/reset','POST',{confirmation:'RESET SECURITY DEMO'});
  assert.equal(await SecurityEvent.countDocuments({source:'simulation'}),0);
  assert(await SecurityEvent.exists({source:'hardware'}));assert(await Visitor.exists({visitorId:realVisitor.item.visitorId}));
  assert(await SecurityAudit.exists({action:'demo_reset'}));assert(await SecurityAudit.countDocuments()>auditCount,'audit history preserved through reset');
  assert.equal(await CameraSnapshot.countDocuments({demoScope:DEMO_SCOPE}),0);
  assert(await Device.exists({deviceId:'hw_pir'}));
  // These are protocol fixtures labeled hardware to test validation, not proof
  // of connected hardware. Entire random database is removed by t.after.
});
