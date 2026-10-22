// Preserve the existing building/... MQTT schema and subscriber. Only devices
// explicitly registered for security are projected into security event history.
import { Device,SensorReading } from '../models/index.js';
import { storeTelemetryV1,recordDeviceState } from './ingestV1.js';
import { processSecurityEvent,SecurityError } from './securityService.js';
export async function storeSecurityAwareTelemetry(message,options){
  const registered=await Device.findOne({deviceId:message.device_id}).lean();
  if(registered?.securityType&&(registered.zoneId!==message.zone_id||registered.securitySource!==message.source))
    throw new SecurityError(409,'Security device zone/source mismatch');
  const result=await storeTelemetryV1(message,options);
  let canonical=result.message||message;
  if(result.duplicate&&!result.message){
    const saved=await SensorReading.findOne({deviceId:message.device_id,eventId:message.message_id}).lean();
    if(saved)canonical={...message,sensors:saved.sensors,health:saved.health||{},source:saved.source,
      zone_id:saved.zoneId,building_id:saved.buildingId,observedAt:saved.observedAt};
  }
  const device=await Device.findOne({deviceId:canonical.device_id}).lean();
  if(device?.securityType==='pir'&&device.zoneId===canonical.zone_id&&device.securitySource===canonical.source&&
      typeof canonical.sensors.pir==='boolean'&&(!canonical.health?.pir||canonical.health.pir==='ok')){
    await processSecurityEvent({eventId:`pir:${canonical.message_id}`,deviceId:device.deviceId,zoneId:device.zoneId,
      source:canonical.source,type:canonical.sensors.pir?'motion_detected':'motion_cleared',occurredAt:canonical.observedAt,
      description:canonical.sensors.pir?'PIR motion indication received via MQTT.':'PIR motion cleared via MQTT.'},{actor:`mqtt:${device.deviceId}`});
  }
  return result;
}
export async function recordSecurityAwareState(message){
  const device=await Device.findOne({deviceId:message.deviceId}).lean();
  if(device?.securityType&&((message.zoneId&&message.zoneId!==device.zoneId)||(message.source&&message.source!==device.securitySource)))
    throw new SecurityError(409,'Security device zone/source mismatch');
  if(device?.securityType==='camera'&&message.kind==='camera'&&message.source===device.securitySource){
    await processSecurityEvent({eventId:`camera:${message.messageId}`,deviceId:device.deviceId,zoneId:device.zoneId,source:device.securitySource,
      type:message.state==='online'?'camera_online':'camera_offline',occurredAt:message.observedAt||new Date(),
      description:`Camera heartbeat ${message.state} received via existing MQTT contract.`},{actor:`mqtt:${device.deviceId}`});
  }
  return recordDeviceState(message);
}
