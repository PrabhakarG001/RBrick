import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mongoose } from '../config/database.js';
import { requireToken } from '../middleware/auth.js';
import { Device,Alert,CameraSnapshot } from '../models/index.js';
import { SecurityZone,SecurityEvent,Visitor,VisitorVisit,SecurityRule,SecurityAudit,SecurityNotification,SecuritySimulation } from '../models/security.js';
import { SecurityError,DEMO_SCOPE,audit,actorOf,ensureSecurityRules,processSecurityEvent,simulationState,setSimulation,reconcileSecurityCameras } from '../services/securityService.js';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.-]+$/);
const oid=z.string().regex(/^[a-fA-F0-9]{24}$/);
const source=z.enum(['simulation','hardware','operator','system']);
const text=n=>z.string().trim().min(1).max(n);
const query=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),limit:z.coerce.number().int().min(1).max(100).default(20),
  search:z.string().max(100).optional(),zoneId:id.optional(),deviceId:id.optional(),visitorId:id.optional(),source:source.optional(),
  type:z.string().max(64).optional(),severity:z.enum(['info','warning','high','critical']).optional(),
  status:z.enum(['active','acknowledged','resolved','inside','outside','unread','read']).optional(),
  from:z.iso.datetime().optional(),before:z.iso.datetime().optional(),sort:z.enum(['asc','desc']).default('desc')}).strict();
const eventInput=z.object({eventId:id,type:z.enum(['motion_detected','motion_cleared','camera_online','camera_offline','device_heartbeat','unauthorized_access','restricted_access','communication_failure']),
  deviceId:id,zoneId:id,source:z.literal('hardware'),timestamp:z.iso.datetime(),description:text(500)}).strict();
const visitorInput=z.object({name:text(100),company:z.string().trim().max(100).default(''),purpose:z.string().trim().max(300).default(''),simulation:z.boolean().default(false)}).strict();
function filterOf(q,time='occurredAt'){
  const filter={};
  for(const key of ['zoneId','deviceId','visitorId','source','type','severity'])if(q[key])filter[key]=q[key];
  if(q.from||q.before)filter[time]=mongoose.trusted({...(q.from?{$gte:new Date(q.from)}:{}),...(q.before?{$lt:new Date(q.before)}:{})});
  return filter;
}
const regex=value=>new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'i');
async function list(model,filter,q,time='occurredAt'){
  const [items,total]=await Promise.all([model.find(filter).select('-image').sort({[time]:q.sort==='asc'?1:-1,_id:q.sort==='asc'?1:-1}).skip((q.page-1)*q.limit).limit(q.limit).lean(),model.countDocuments(filter)]);
  return {success:true,items,total,page:q.page,limit:q.limit};
}
function cameraView(device,config){
  const online=device.cameraStatusAt?device.cameraOnline===true&&Date.now()-new Date(device.cameraStatusAt)<config.offlineAfterSeconds*1000:null;
  return {...device,source:device.securitySource||device.cameraSource,state:online===null?'unknown':online?'online':'offline',
    snapshotConfigured:device.securityDemoScope===DEMO_SCOPE||Boolean(config.cameraSnapshotUrls[device.deviceId])};
}
const cameraFilter={$or:[{securityType:'camera'},{cameraStatusAt:mongoose.trusted({$exists:true})}]};
export function securityRoutes(config,status){
  const router=Router();
  // Device-only route has separate per-device secrets, not the operator token.
  router.post('/ingest/:deviceId',async(req,res,next)=>{
    const deviceId=id.parse(req.params.deviceId),token=config.securityDeviceTokens?.[deviceId];
    if(!token)return res.status(401).json({success:false,message:'Device authentication required'});
    requireToken({apiToken:token})(req,res,()=>{req.securityDeviceId=deviceId;next();});
  },async(req,res)=>{
    if(!status.database)throw new SecurityError(503,'Database unavailable');
    const input=eventInput.parse(req.body);
    if(input.deviceId!==req.securityDeviceId)throw new SecurityError(403,'Device identity mismatch');
    const at=new Date(input.timestamp);
    if(at-Date.now()>30000)throw new SecurityError(400,'Timestamp is in the future');
    const {timestamp,...rest}=input;
    const result=await processSecurityEvent({...rest,occurredAt:at},{actor:actorOf(req)});
    res.status(result.duplicate?200:201).json({success:true,...result});
  });
  router.use(requireToken(config),(req,res,next)=>{if(!status.database)return res.status(503).json({success:false,message:'Database unavailable'});next();});
  router.get('/simulation/status',async(req,res)=>res.json({success:true,item:await simulationState(),enabled:Boolean(config.securitySimulationEnabled)}));
  const simulationGuard=async()=>{
    if(!config.securitySimulationEnabled)throw new SecurityError(403,'Security simulation is disabled');
  };
  router.post('/simulation/start',async(req,res)=>{await simulationGuard();z.object({}).strict().parse(req.body||{});res.json({success:true,item:await setSimulation(true)});});
  router.post('/simulation/stop',async(req,res)=>{await simulationGuard();z.object({}).strict().parse(req.body||{});res.json({success:true,item:await setSimulation(false)});});
  router.post('/simulation/motion',async(req,res)=>{
    await simulationGuard();if(!(await simulationState()).running)throw new SecurityError(409,'Start simulation first');
    const input=z.object({deviceId:id.default('security_sim_pir'),active:z.boolean().default(true),eventId:id.optional()}).strict().parse(req.body||{});
    const device=await Device.findOne({deviceId:input.deviceId,securityDemoScope:DEMO_SCOPE});
    if(!device||device.securityType!=='pir')throw new SecurityError(404,'Demo PIR not found');
    const result=await processSecurityEvent({eventId:input.eventId||randomUUID(),deviceId:device.deviceId,zoneId:device.zoneId,source:'simulation',
      occurredAt:new Date(),type:input.active?'motion_detected':'motion_cleared',description:input.active?'Manually simulated PIR motion.':'Manually simulated motion cleared.'},{actor:actorOf(req)});
    res.status(result.duplicate?200:201).json({success:true,...result});
  });
  router.post('/simulation/camera',async(req,res)=>{
    await simulationGuard();if(!(await simulationState()).running)throw new SecurityError(409,'Start simulation first');
    const input=z.object({online:z.boolean()}).strict().parse(req.body);
    res.status(201).json({success:true,...await processSecurityEvent({eventId:randomUUID(),deviceId:'security_sim_camera',zoneId:'security_demo_restricted',source:'simulation',
      type:input.online?'camera_online':'camera_offline',occurredAt:new Date(),description:`Manually simulated camera ${input.online?'online':'offline'}.`})});
  });
  router.post('/simulation/access',async(req,res)=>{
    await simulationGuard();if(!(await simulationState()).running)throw new SecurityError(409,'Start simulation first');
    const input=z.object({zoneId:id.default('security_demo_restricted')}).strict().parse(req.body||{});
    if(!await SecurityZone.exists({zoneId:input.zoneId,demoScope:DEMO_SCOPE}))throw new SecurityError(404,'Demo zone not found');
    res.status(201).json({success:true,...await processSecurityEvent({eventId:randomUUID(),zoneId:input.zoneId,source:'simulation',type:'unauthorized_access',occurredAt:new Date(),description:'Manually simulated unauthorized access attempt.'})});
  });
  router.post('/simulation/reset',async(req,res)=>{
    await simulationGuard();if(!config.securityDemoResetEnabled||config.nodeEnv==='production')throw new SecurityError(403,'Demo reset is disabled');
    z.object({confirmation:z.literal('RESET SECURITY DEMO')}).strict().parse(req.body);
    if((await simulationState()).running)throw new SecurityError(409,'Stop simulation before reset');
    await mongoose.connection.transaction(async session=>{
      const demoZones=await SecurityZone.find({demoScope:DEMO_SCOPE}).session(session).distinct('zoneId');
      const references={zoneId:mongoose.trusted({$in:demoZones})};
      if(await VisitorVisit.exists({...references,demoScope:mongoose.trusted({$ne:DEMO_SCOPE})}).session(session)||
         await Device.exists({...references,securitySource:'hardware'}).session(session))
        throw new SecurityError(409,'Demo zones are referenced by non-demo records; reset refused');
      // Explicit equality scope only. Operator/hardware visits and audit history
      // are never deleted. Preserve append-only demo audit too.
      for(const model of [SecurityEvent,Visitor,VisitorVisit,SecurityNotification,CameraSnapshot,Alert,SecurityZone])
        await model.deleteMany({demoScope:DEMO_SCOPE},{session});
      await Device.deleteMany({securityDemoScope:DEMO_SCOPE},{session});
      await audit('demo_reset',DEMO_SCOPE,'operator',actorOf(req),'Scoped development demo reset',session);
    });res.json({success:true});
  });
  router.get('/overview',async(req,res)=>{
    await reconcileSecurityCameras();
    const cameras=await Device.find(cameraFilter).lean(),views=cameras.map(d=>cameraView(d,config));
    const start=new Date();start.setUTCHours(0,0,0,0);
    const [motionToday,activeAlerts,visitorsInside,unreadNotifications]=await Promise.all([
      SecurityEvent.countDocuments({type:'motion_detected',occurredAt:mongoose.trusted({$gte:start})}),
      Alert.countDocuments({kind:'security',resolvedAt:null}),VisitorVisit.countDocuments({activeVisitorKey:mongoose.trusted({$exists:true})}),
      SecurityNotification.countDocuments({readAt:null}),
    ]);
    res.json({success:true,totalCameras:views.length,onlineCameras:views.filter(c=>c.state==='online').length,
      offlineCameras:views.filter(c=>c.state==='offline').length,unknownCameras:views.filter(c=>c.state==='unknown').length,
      motionToday,activeAlerts,visitorsInside,unreadNotifications,dayTimeZone:'UTC',simulation:await simulationState()});
  });
  router.get('/zones',async(req,res)=>{const q=query.parse(req.query);res.json(await list(SecurityZone,{},q,'createdAt'));});
  const zoneInput=z.object({zoneId:id,name:text(100),restricted:z.boolean().default(false),timeZone:z.string().max(100).default('UTC').refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}})}).strict();
  router.post('/zones',async(req,res)=>{
    const input=zoneInput.parse(req.body);let item;
    await mongoose.connection.transaction(async session=>{[item]=await SecurityZone.create([input],{session});await audit('zone_registered',item.zoneId,'operator',actorOf(req),'Monitored zone registered',session);});
    res.status(201).json({success:true,item});
  });
  router.patch('/zones/:zoneId',async(req,res)=>{
    const zoneId=id.parse(req.params.zoneId),input=zoneInput.omit({zoneId:true}).partial().strict().parse(req.body);let item;
    await mongoose.connection.transaction(async session=>{item=await SecurityZone.findOneAndUpdate({zoneId},{$set:input},{returnDocument:'after',session,runValidators:true});
      if(!item)throw new SecurityError(404,'Zone not found');await audit('zone_updated',zoneId,'operator',actorOf(req),'Zone settings updated',session);});res.json({success:true,item});
  });
  router.get('/devices',async(req,res)=>{const q=query.parse(req.query);res.json(await list(Device,{securityType:mongoose.trusted({$exists:true}),...(q.zoneId?{zoneId:q.zoneId}:{})},q,'lastSeenAt'));});
  router.post('/devices',async(req,res)=>{
    const input=z.object({deviceId:id,zoneId:id,name:text(100),securityType:z.enum(['pir','camera','access'])}).strict().parse(req.body);let item;
    await mongoose.connection.transaction(async session=>{
      if(!await SecurityZone.exists({zoneId:input.zoneId}).session(session))throw new SecurityError(404,'Zone not found');
      const previous=await Device.findOne({deviceId:input.deviceId}).session(session);
      if(previous?.securityType)throw new SecurityError(409,'Security device already registered');
      if(previous?.zoneId&&previous.zoneId!==input.zoneId)throw new SecurityError(409,'Existing device belongs to another zone');
      item=await Device.findOneAndUpdate({deviceId:input.deviceId},{$set:{...input,securitySource:'hardware'}},{upsert:true,session,returnDocument:'after',runValidators:true});
      await audit('device_registered',input.deviceId,'operator',actorOf(req),'Security role assigned to device',session);
    });res.status(201).json({success:true,item});
  });
  router.get('/cameras',async(req,res)=>{
    const q=query.parse(req.query),result=await list(Device,{...cameraFilter,...(q.zoneId?{zoneId:q.zoneId}:{})},q,'cameraStatusAt');
    result.items=result.items.map(d=>cameraView(d,config));
    for(const item of result.items)item.latestSnapshot=await CameraSnapshot.findOne({deviceId:item.deviceId}).select('-image').sort({capturedAt:-1}).lean();
    res.json(result);
  });
  router.get('/cameras/:id',async(req,res)=>{const deviceId=id.parse(req.params.id),item=await Device.findOne({deviceId,...cameraFilter}).lean();
    if(!item)throw new SecurityError(404,'Camera not found');res.json({success:true,item:cameraView(item,config)});});
  router.get('/cameras/:id/snapshots',async(req,res)=>{const q=query.parse(req.query);res.json(await list(CameraSnapshot,{deviceId:id.parse(req.params.id)},q,'capturedAt'));});
  for(const [path,model,time] of [['/events',SecurityEvent,'occurredAt'],['/motion-events',SecurityEvent,'occurredAt'],['/audit-logs',SecurityAudit,'occurredAt'],['/notifications',SecurityNotification,'createdAt']]){
    router.get(path,async(req,res)=>{
      const q=query.parse(req.query),filter=filterOf(q,time);
      if(path==='/motion-events')filter.type=mongoose.trusted({$in:['motion_detected','motion_cleared']});
      if(q.search){
        const fields=path==='/notifications'?['message']:path==='/audit-logs'?['description','action','actor','reference']:['description','eventId','deviceId','visitorId','type'];
        filter.$or=fields.map(field=>({[field]:regex(q.search)}));
      }
      if(path==='/notifications'&&q.status)filter.readAt=q.status==='unread'?null:mongoose.trusted({$ne:null});
      res.json(await list(model,filter,q,time));
    });
  }
  router.get('/events/:id',async(req,res)=>{const item=await SecurityEvent.findById(oid.parse(req.params.id)).lean();if(!item)throw new SecurityError(404,'Event not found');res.json({success:true,item});});
  router.post('/notifications/:id/read',async(req,res)=>{
    const _id=oid.parse(req.params.id);const item=await SecurityNotification.findOneAndUpdate({_id,readAt:null},{$set:{readAt:new Date()}},{returnDocument:'after'})||await SecurityNotification.findById(_id);
    if(!item)throw new SecurityError(404,'Notification not found');res.json({success:true,item});
  });
  router.get('/alerts',async(req,res)=>{
    const q=query.parse(req.query),filter={...filterOf(q,'createdAt'),kind:'security'};
    if(q.status==='resolved')filter.resolvedAt=mongoose.trusted({$ne:null});
    else if(q.status==='acknowledged')Object.assign(filter,{resolvedAt:null,acknowledgedAt:mongoose.trusted({$ne:null})});
    else if(q.status==='active')Object.assign(filter,{resolvedAt:null,acknowledgedAt:null});
    if(q.search)filter.message=regex(q.search);res.json(await list(Alert,filter,q,'createdAt'));
  });
  for(const action of ['acknowledge','resolve'])router.post(`/alerts/:id/${action}`,async(req,res)=>{
    const _id=oid.parse(req.params.id),input=z.object({resolution:z.string().trim().max(1000).optional()}).strict().parse(req.body||{});let item;
    await mongoose.connection.transaction(async session=>{
      item=await Alert.findOne({_id,kind:'security'}).session(session);if(!item)throw new SecurityError(404,'Alert not found');
      if(item.resolvedAt||(action==='acknowledge'&&item.acknowledgedAt))throw new SecurityError(409,'Invalid alert transition');
      if(action==='resolve'&&!item.acknowledgedAt)throw new SecurityError(409,'Acknowledge the alert before resolution');
      const now=new Date();
      if(action==='acknowledge')Object.assign(item,{acknowledgedAt:now,acknowledgedBy:actorOf(req)});
      else {Object.assign(item,{resolvedAt:now,resolvedBy:actorOf(req),resolution:input.resolution||'Resolved by operator'});item.activeSecurityKey=undefined;}
      await item.save({session});
      await SecurityEvent.create([{eventId:randomUUID(),type:`alert_${action==='resolve'?'resolved':'acknowledged'}`,source:'operator',occurredAt:now,receivedAt:now,
        deviceId:item.deviceId,zoneId:item.zoneId,description:`Security alert ${_id} ${action}d.`,demoScope:item.demoScope}],{session});
      await audit(`alert_${action}`,item._id,'operator',actorOf(req),input.resolution||'Operator alert transition',session,item.demoScope);
    });res.json({success:true,item});
  });
  router.get('/rules',async(req,res)=>{await ensureSecurityRules();res.json({success:true,items:await SecurityRule.find().sort({key:1}).lean()});});
  router.patch('/rules/:key',async(req,res)=>{
    const key=z.enum(['restricted_motion','off_hours','repeated_motion','camera_offline','unauthorized_access']).parse(req.params.key);
    const input=z.object({enabled:z.boolean().optional(),severity:z.enum(['warning','high','critical']).optional(),
      windowSeconds:z.number().int().min(1).max(86400).optional(),threshold:z.number().int().min(2).max(1000).optional(),timeoutSeconds:z.number().int().min(10).max(86400).optional(),
      startMinute:z.number().int().min(0).max(1439).optional(),endMinute:z.number().int().min(0).max(1439).optional(),days:z.array(z.number().int().min(0).max(6)).min(1).max(7).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);let item;
    await mongoose.connection.transaction(async session=>{
      item=await SecurityRule.findOneAndUpdate({key},{$set:input},{session,returnDocument:'after',runValidators:true});if(!item)throw new SecurityError(404,'Rule not found');
      await audit('rule_updated',key,'operator',actorOf(req),`Changed rule fields: ${Object.keys(input).join(', ')}`,session);
    });res.json({success:true,item});
  });
  // CSV uses the same validated query/search criteria and neutralizes spreadsheet
  // formulas. Capped at 10k rows; larger exports must narrow their date filter.
  router.get('/visitors/export',async(req,res)=>{
    const q=query.parse(req.query),pipeline=visitorPipeline(q);const rows=await Visitor.aggregate([...pipeline,{$limit:10001}]);
    if(rows.length>10000)throw new SecurityError(413,'Narrow filters to export at most 10000 visitors');
    const cell=value=>`"${String(value??'').replace(/^(\s*[=+@\-]|[\t\r])/ ,"'$&").replaceAll('"','""')}"`;
    res.type('text/csv').attachment('security-visitors.csv').send(['Visitor ID,Name,Company,Purpose,Source,Status,Registered at',
      ...rows.map(v=>[v.visitorId,v.name,v.company,v.purpose,v.source,v.activeVisits.length?'inside':'outside',v.createdAt.toISOString()].map(cell).join(','))].join('\r\n'));
  });
  router.get('/visitors',async(req,res)=>{
    const q=query.parse(req.query),pipeline=visitorPipeline(q);
    const [result]=await Visitor.aggregate([...pipeline,{$facet:{items:[{$skip:(q.page-1)*q.limit},{$limit:q.limit}],count:[{$count:'total'}]}}]);
    res.json({success:true,items:result.items,total:result.count[0]?.total||0,page:q.page,limit:q.limit});
  });
  router.post('/visitors',async(req,res)=>{
    const {simulation,...input}=visitorInput.parse(req.body);if(simulation){await simulationGuard();if(!(await simulationState()).running)throw new SecurityError(409,'Start simulation first');}
    let item;await mongoose.connection.transaction(async session=>{
      [item]=await Visitor.create([{...input,visitorId:`visitor_${randomUUID()}`,source:simulation?'simulation':'operator',demoScope:simulation?DEMO_SCOPE:undefined}],{session});
      await audit('visitor_registered',item.visitorId,item.source,actorOf(req),'Visitor registered; not checked in',session,item.demoScope);
    });res.status(201).json({success:true,item});
  });
  router.get('/visitors/:id',async(req,res)=>{const visitorId=id.parse(req.params.id),item=await Visitor.findOne({visitorId}).lean();if(!item)throw new SecurityError(404,'Visitor not found');res.json({success:true,item});});
  router.patch('/visitors/:id',async(req,res)=>{
    const visitorId=id.parse(req.params.id),input=visitorInput.omit({simulation:true}).partial().strict().refine(v=>Object.keys(v).length>0).parse(req.body);let item;
    await mongoose.connection.transaction(async session=>{item=await Visitor.findOneAndUpdate({visitorId},{$set:input},{session,returnDocument:'after',runValidators:true});if(!item)throw new SecurityError(404,'Visitor not found');
      await audit('visitor_updated',visitorId,item.source,actorOf(req),'Visitor profile updated; visit timestamps unchanged',session,item.demoScope);});res.json({success:true,item});
  });
  router.get('/visitors/:id/visits',async(req,res)=>{const q=query.parse(req.query);res.json(await list(VisitorVisit,{visitorId:id.parse(req.params.id)},q,'checkedInAt'));});
  for(const action of ['check-in','check-out'])router.post(`/visitors/:id/${action}`,async(req,res)=>{
    const visitorId=id.parse(req.params.id),input=(action==='check-in'?z.object({zoneId:id}):z.object({})).strict().parse(req.body||{});let item;
    await mongoose.connection.transaction(async session=>{
      const visitor=await Visitor.findOneAndUpdate({visitorId},{$inc:{visitVersion:1}},{session,returnDocument:'after'});
      if(!visitor)throw new SecurityError(404,'Visitor not found');
      const active=await VisitorVisit.findOne({activeVisitorKey:visitorId}).session(session),now=new Date();
      if(action==='check-in'){
        if(active)throw new SecurityError(409,'Visitor already checked in');
        const zone=await SecurityZone.findOne({zoneId:input.zoneId}).session(session);if(!zone)throw new SecurityError(404,'Zone not found');
        if(visitor.source==='simulation'&&zone.demoScope!==DEMO_SCOPE)throw new SecurityError(409,'Demo visits require a demo zone');
        [item]=await VisitorVisit.create([{visitorId,zoneId:zone.zoneId,checkedInAt:now,activeVisitorKey:visitorId,source:visitor.source,demoScope:visitor.demoScope}],{session});
      }else{
        if(!active)throw new SecurityError(409,'Visitor has no active visit');
        active.checkedOutAt=now;active.activeVisitorKey=undefined;await active.save({session});item=active;
      }
      await SecurityEvent.create([{eventId:randomUUID(),type:action==='check-in'?'visitor_checked_in':'visitor_checked_out',zoneId:item.zoneId,visitorId,visitId:item._id,
        source:visitor.source,occurredAt:now,receivedAt:now,description:`Visitor ${visitorId} ${action}.`,demoScope:visitor.demoScope}],{session});
      await audit(action,visitorId,visitor.source,actorOf(req),'Server-timestamped visitor transition',session,visitor.demoScope);
    });res.status(action==='check-in'?201:200).json({success:true,item});
  });
  return router;
}
function visitorPipeline(q){
  const filter={};if(q.source)filter.source=q.source;
  if(q.search)filter.$or=['name','company','visitorId'].map(key=>({[key]:regex(q.search)}));
  if(q.from||q.before)filter.createdAt={...(q.from?{$gte:new Date(q.from)}:{}),...(q.before?{$lt:new Date(q.before)}:{})};
  const pipeline=[{$match:filter},{$lookup:{from:VisitorVisit.collection.name,let:{id:'$visitorId'},pipeline:[{$match:{$expr:{$eq:['$visitorId','$$id']},activeVisitorKey:{$exists:true}}},{$limit:1}],as:'activeVisits'}}];
  if(q.status==='inside')pipeline.push({$match:{'activeVisits.0':{$exists:true}}});
  if(q.status==='outside')pipeline.push({$match:{'activeVisits.0':{$exists:false}}});
  if(q.zoneId)pipeline.push({$match:{'activeVisits.zoneId':q.zoneId}});
  pipeline.push({$sort:{createdAt:q.sort==='asc'?1:-1,_id:1}});return pipeline;
}
