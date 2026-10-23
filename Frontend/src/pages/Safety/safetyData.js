export const sensorLabels = { temperature: 'Temperature (DHT22)', humidity: 'Humidity (DHT22)', gas: 'Gas (MQ-2)', smoke: 'Smoke (MQ-2)', waterLeak: 'Water leak', doorOpen: 'Door activity', sos: 'SOS button' };
// rbrick-v1 fixed sensor vocabulary (backend/src/services/telemetrySchema.js).
export const v1SensorLabels = { temperature: 'Temperature (DHT22)', humidity: 'Humidity (DHT22)', mq2_raw: 'MQ-2 raw ADC', vibration_rms: 'Vibration RMS (MPU6050)', sw420: 'SW-420 switch', pir: 'PIR motion', flame: 'Flame sensor', sos: 'SOS button' };
// Honest interpretation notes; raw values are never restated as calibrated
// measurements or safety conclusions the sensors cannot support.
export const v1SensorNotes = { mq2_raw: 'Raw ADC counts, not a calibrated gas concentration', pir: 'Motion indication only, never classified as intrusion', vibration_rms: 'g RMS from MPU6050; acceleration axes are not transmitted; not a structural-damage assessment', sw420: 'Digital vibration switch trigger' };
export const riskClassLabel = value => ({ NORMAL: 'Normal', LOW: 'Low', MODERATE: 'Moderate', HIGH: 'High', CRITICAL: 'Critical' }[value] || value || 'Unknown');
export const sourceLabel = value => value === 'simulation' ? 'Simulated data' : value === 'hardware' ? 'Hardware' : 'Unknown source';
export function mergeReading(stored, live) {
  if (!live) return stored || null;
  if (!stored) return { ...live, health: live.health ?? {} };
  return new Date(live.receivedAt ?? live.observedAt) >= new Date(stored.receivedAt ?? stored.observedAt) ? { ...stored, ...live } : stored;
}
export function latestReadings(stored = [], live = {}) {
  const readings = new Map(stored.filter(r => Object.keys(r.sensors || {}).length).map(r => [r.deviceId, r]));
  for (const reading of Object.values(live)) readings.set(reading.deviceId, mergeReading(readings.get(reading.deviceId), reading));
  return [...readings.values()].sort((a,b) => Date.parse(b.receivedAt || b.observedAt) - Date.parse(a.receivedAt || a.observedAt));
}
export function currentRisk(reading, liveRisk, storedRisk) {
  if (!reading || reading.analysisStatus === 'unavailable') return null;
  const id = reading.messageId || reading.eventId;
  return [liveRisk, storedRisk].filter(Boolean).filter(r => !id || r.messageId === id)
    .sort((a,b) => Date.parse(b.analyzedAt) - Date.parse(a.analyzedAt))[0] || null;
}
export function freshReading(reading, seconds = 120, now = Date.now()) {
  return Boolean(reading && [reading.observedAt, reading.receivedAt].every(at =>
    Number.isFinite(Date.parse(at)) && now - Date.parse(at) <= seconds * 1000 && Date.parse(at) <= now + 300000));
}
export function v1SensorValue(name, value, kind) {
  if (value === undefined || value === null) return 'Not received';
  if (kind === 'boolean' || typeof value === 'boolean') {
    const flags = { sw420: ['No trigger', 'Triggered'], pir: ['No motion', 'Motion detected'], flame: ['No flame indication', 'Flame indicated'], sos: ['Inactive', 'Emergency signal'] }[name];
    return flags ? (value ? flags[1] : flags[0]) : String(value);
  }
  return String(value);
}
export const when = value => value ? new Date(value).toLocaleString() : 'Not recorded';
export const severity = alert => alert.severity || (alert.kind === 'sos' ? 'critical' : 'warning');
export const incidentStatus = alert => alert.resolvedAt ? 'resolved' : alert.acknowledgedAt ? 'acknowledged' : 'active';
export function incidentType(alert, meta) {
  const sensor = Object.keys(meta?.display || {}).find(key => meta.display[key] === alert.field);
  return sensor ? sensorLabels[sensor] : alert.kind === 'sos' ? 'SOS emergency' : alert.kind === 'fault' ? 'Device fault' : 'Safety event';
}
export function deviceState(device, meta, now = Date.now()) {
  if (!device.lastSeenAt) return 'Awaiting telemetry';
  if (meta?.mqtt !== 'subscribed') return 'Unknown (MQTT unavailable)';
  if (device.online === false || device.state === 'offline') return 'Offline';
  return now - new Date(device.lastSeenAt).getTime() > (meta.offlineAfterSeconds || 120) * 1000 ? 'Offline' : 'Online';
}
export function sensorValue(key, value) {
  if (value === undefined || value === null) return 'Not received';
  if (key === 'waterLeak' && typeof value === 'boolean') return value ? 'Leak detected' : 'No leak signal';
  if (key === 'doorOpen' && typeof value === 'boolean') return value ? 'Open' : 'Closed';
  if (key === 'sos' && typeof value === 'boolean') return value ? 'Emergency signal' : 'Inactive';
  return String(value);
}
export function downloadReport(name, payload) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
