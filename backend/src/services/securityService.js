import { randomUUID } from 'node:crypto';
import { mongoose } from '../config/database.js';
import { Device, Alert,CameraSnapshot } from '../models/index.js';
import { SecurityZone,SecurityEvent,SecurityRule,SecurityAudit,SecurityNotification,SecuritySimulation } from '../models/security.js';

export const DEMO_SCOPE='security-demo-v1';
export class SecurityError extends Error {
  constructor(status,message){super(message);this.status=status;}
}
export const actorOf=req=>req.securityDeviceId?`device:${req.securityDeviceId}`:'operator-token';
export async function audit(action,reference,source,actor,description,session,demoScope){
  await SecurityAudit.create([{auditId:randomUUID(),action,reference:String(reference),source,actor,
    description,occurredAt:new Date(),demoScope}],{session});
}
export async function ensureSecurityRules(){
  for(const [key,severity] of [['restricted_motion','high'],['off_hours','warning'],['repeated_motion','critical'],['camera_offline','high'],['unauthorized_access','high']])
    await SecurityRule.updateOne({key},{$setOnInsert:{key,severity}},{upsert:true});
}
const rank={info:0,warning:1,high:2,critical:3};
export function outsideHours(at,zone,rule){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone.timeZone,weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const field=key=>parts.find(p=>p.type===key)?.value;
  const day=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(field('weekday'));
  const minute=Number(field('hour'))*60+Number(field('minute'));
  if(rule.startMinute===rule.endMinute)return !rule.days.includes(day);
  if(rule.startMinute<rule.endMinute)return !rule.days.includes(day)||minute<rule.startMinute||minute>=rule.endMinute;
  // Overnight hours belong to the weekday on which that shift starts.
  return !((rule.days.includes(day)&&minute>=rule.startMinute)||(rule.days.includes((day+6)%7)&&minute<rule.endMinute));
}
async function raise(event,rule,session){
  const scope=rule.key==='camera_offline' ? event.deviceId : event.zoneId;
  const key=`security:${rule.key}:${scope}:${event.source}`;
  let alert=await Alert.findOne({activeSecurityKey:key}).session(session);
  if(!alert){
    [alert]=await Alert.create([{deviceId:event.deviceId||'security-access',kind:'security',field:rule.key,
      message:`${rule.key.replaceAll('_',' ')}: ${event.description}`,observedAt:event.occurredAt,
      zoneId:event.zoneId,source:event.source,severity:rule.severity,securityEventId:event._id,
      activeSecurityKey:key,demoScope:event.demoScope}],{session});
    await SecurityNotification.create([{alertId:alert._id,message:alert.message,source:event.source,createdAt:new Date(),demoScope:event.demoScope}],{session});
    await audit('alert_created',alert._id,event.source,'security-rules',rule.key,session,event.demoScope);
  }else if(rank[rule.severity]>rank[alert.severity]){
    alert.severity=rule.severity;await alert.save({session});
    await audit('alert_escalated',alert._id,event.source,'security-rules',rule.key,session,event.demoScope);
  }
  return alert;
}

// Shared provider boundary: simulation, authenticated hardware HTTP and the
// existing MQTT adapter all call here. An event and its effects commit together.
export async function processSecurityEvent(input,{actor='security-provider',now=new Date(),maxAgeSeconds=120,expectedHeartbeatAt}={}){
  let result;
  try{
    await mongoose.connection.transaction(async session=>{
      const previous=await SecurityEvent.findOne({eventId:input.eventId}).session(session);
      if(previous){
        if(previous.deviceId!==input.deviceId||previous.source!==input.source||previous.zoneId!==input.zoneId)
          throw new SecurityError(409,'Event ID belongs to another device or source');
        result={item:previous,duplicate:true};return;
      }
      const zone=await SecurityZone.findOneAndUpdate({zoneId:input.zoneId},{$inc:{eventVersion:1}},{session,returnDocument:'after'});
      if(!zone)throw new SecurityError(404,'Monitored zone not found');
      let device;
      if(input.deviceId){
        device=await Device.findOne({deviceId:input.deviceId}).session(session);
        if(!device?.securityType||device.zoneId!==input.zoneId||device.securitySource!==input.source)
          throw new SecurityError(409,'Device, zone and source do not match the registered security device');
        if(input.type.startsWith('camera_')&&device.securityType!=='camera')throw new SecurityError(409,'Camera event requires a camera device');
        if(input.type.startsWith('motion_')&&device.securityType!=='pir')throw new SecurityError(409,'Motion event requires a PIR device');
        if(expectedHeartbeatAt&&new Date(device.cameraStatusAt).getTime()!==new Date(expectedHeartbeatAt).getTime()){
          result={duplicate:true};return;
        }
      }
      const fresh=now-input.occurredAt<=maxAgeSeconds*1000 && input.occurredAt-now<=30000;
      const [event]=await SecurityEvent.create([{...input,receivedAt:now,
        demoScope:input.source==='simulation'?DEMO_SCOPE:undefined}],{session});
      if(device&&fresh){
        const update={lastSeenAt:now,online:!['camera_offline','communication_failure'].includes(input.type)};
        if(['motion_detected','motion_cleared'].includes(input.type)){
          update.motionActive=input.type==='motion_detected';
          if(update.motionActive)update.lastMotionAt=input.occurredAt;
        }
        if(input.type.startsWith('camera_'))Object.assign(update,{cameraOnline:input.type==='camera_online',cameraStatusAt:now,cameraSource:input.source});
        await Device.updateOne({_id:device._id},{$set:update,$inc:{securityVersion:1}},{session});
      }
      const rules=await SecurityRule.find({enabled:true}).session(session).lean();
      const alerts=[];
      if(fresh){
        for(const rule of rules){
          let matches=false;
          if(input.type==='motion_detected'){
            if(rule.key==='restricted_motion')matches=zone.restricted;
            if(rule.key==='off_hours')matches=outsideHours(input.occurredAt,zone,rule);
            if(rule.key==='repeated_motion')matches=await SecurityEvent.countDocuments({zoneId:input.zoneId,
              source:input.source,type:'motion_detected',occurredAt:mongoose.trusted({$gte:new Date(now-rule.windowSeconds*1000),$lte:now})}).session(session)>=rule.threshold;
          }
          if(rule.key==='camera_offline'&&input.type==='camera_offline')matches=true;
          if(rule.key==='unauthorized_access'&&['unauthorized_access','restricted_access'].includes(input.type)&&zone.restricted)matches=true;
          if(matches)alerts.push(await raise(event,rule,session));
        }
      }
      if(alerts.length){event.severity=alerts.reduce((highest,item)=>rank[item.severity]>rank[highest]?item.severity:highest,'info');
        // History is append-only: set severity inside its initial transaction via
        // the document save path, never an API update of committed history.
        await event.save({session});}
      await audit(input.type,event._id,input.source,actor,input.description,session,event.demoScope);
      result={item:event,alerts,duplicate:false,historical:!fresh};
    });
  }catch(error){
    if(error.code===11000){
      const previous=await SecurityEvent.findOne({eventId:input.eventId});
      if(previous&&previous.deviceId===input.deviceId&&previous.source===input.source&&previous.zoneId===input.zoneId)
        return {item:previous,duplicate:true};
    }
    throw error;
  }
  return result;
}

export async function seedSecurityDemo(){
  await ensureSecurityRules();
  for(const [zoneId,name,restricted] of [['security_demo_lobby','Demo lobby',false],['security_demo_restricted','Demo restricted room',true]]){
    const previous=await SecurityZone.findOne({zoneId}).lean();
    if(previous&&previous.demoScope!==DEMO_SCOPE)throw new SecurityError(409,'Reserved demo zone ID is already in use');
    await SecurityZone.updateOne({zoneId},{$setOnInsert:{zoneId,name,restricted,timeZone:'UTC',demoScope:DEMO_SCOPE}},{upsert:true});
  }
  for(const [deviceId,name,securityType,zoneId] of [
    ['security_sim_camera','Demo camera','camera','security_demo_restricted'],
    ['security_sim_pir','Demo PIR','pir','security_demo_restricted'],
  ]){
    const previous=await Device.findOne({deviceId}).lean();
    if(previous&&previous.securityDemoScope!==DEMO_SCOPE)throw new SecurityError(409,'Reserved demo device ID is already in use');
    await Device.updateOne({deviceId},{$setOnInsert:{deviceId,name,securityType,zoneId,
      securitySource:'simulation',securityDemoScope:DEMO_SCOPE}},{upsert:true});
  }
}
export async function storeSecuritySnapshot(data,device){
  if(data.source!==device.securitySource)throw new SecurityError(409,'Snapshot provider source differs from registered security camera');
  let snapshot;
  await mongoose.connection.transaction(async session=>{
    [snapshot]=await CameraSnapshot.create([data],{session});
    const description=data.source==='simulation'?'Bundled sample image saved; not a physical camera capture.':'Snapshot retrieved from the configured camera provider.';
    await SecurityEvent.create([{eventId:`snapshot:${snapshot._id}`,deviceId:device.deviceId,zoneId:device.zoneId,
      source:data.source,type:'snapshot_captured',occurredAt:data.capturedAt,receivedAt:new Date(),snapshotId:snapshot._id,
      description,demoScope:data.demoScope}],{session});
    await audit('snapshot_captured',snapshot._id,data.source,'operator-token',description,session,data.demoScope);
  });return snapshot;
}
export async function simulationState(){return await SecuritySimulation.findOne({key:DEMO_SCOPE}).lean()||{running:false};}
export async function setSimulation(running){
  if(running)await seedSecurityDemo();
  await SecuritySimulation.updateOne({key:DEMO_SCOPE},{$set:{running,[running?'startedAt':'stoppedAt']:new Date()}},{upsert:true});
  if(await Device.exists({deviceId:'security_sim_camera',securityDemoScope:DEMO_SCOPE})){
    await processSecurityEvent({eventId:randomUUID(),type:running?'camera_online':'camera_offline',
      deviceId:'security_sim_camera',zoneId:'security_demo_restricted',source:'simulation',occurredAt:new Date(),
      description:running?'Demo camera enabled; bundled sample images only.':'Demo camera stopped by operator.'});
  }
  await audit(running?'simulation_started':'simulation_stopped',DEMO_SCOPE,'simulation','operator-token','Manual simulation control',undefined,DEMO_SCOPE);
  return simulationState();
}
// Periodic/read reconciliation uses a stable heartbeat-derived ID, so repeated
// sweeps/restarts cannot flood logs. Only previously reporting cameras qualify.
export async function reconcileSecurityCameras(now=new Date()){
  const rule=await SecurityRule.findOne({key:'camera_offline',enabled:true}).lean();
  if(!rule)return;
  const cameras=await Device.find({securityType:'camera',cameraOnline:true,cameraStatusAt:mongoose.trusted({$lt:new Date(now-rule.timeoutSeconds*1000)})}).lean();
  for(const camera of cameras)await processSecurityEvent({eventId:`timeout:${camera.deviceId}:${new Date(camera.cameraStatusAt).getTime()}`,
    deviceId:camera.deviceId,zoneId:camera.zoneId,type:'camera_offline',source:camera.securitySource,
    occurredAt:now,description:'Previously reporting camera exceeded its configured heartbeat timeout.'},{now,actor:'security-timeout-monitor',expectedHeartbeatAt:camera.cameraStatusAt});
}
