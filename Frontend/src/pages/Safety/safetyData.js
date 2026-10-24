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

export const MULTILABEL_TARGET_INFO = {
  event_fire_suspected: {
    label: 'Fire Suspicion',
    category: 'Thermal & Combustion',
    severity: 'critical',
    action: 'Evacuate zone immediately; initiate suppression protocols and alert building emergency response.',
    threshold: 0.23,
    sensorInputs: ['flame', 'temperature_c', 'camera_flame_confidence'],
  },
  event_smoke_suspected: {
    label: 'Smoke Suspicion',
    category: 'Air Quality & Fire',
    severity: 'critical',
    action: 'Inspect ventilation and HVAC dampers; verify optical smoke detectors and air particulate readings.',
    threshold: 0.37,
    sensorInputs: ['mq2_adc_raw_0_4095', 'camera_smoke_confidence'],
  },
  event_combustible_gas_suspected: {
    label: 'Combustible Gas Detected',
    category: 'Chemical Hazard',
    severity: 'critical',
    action: 'Isolate gas mains valve; vent space immediately; prohibit electrical ignition and sparking sources.',
    threshold: 0.42,
    sensorInputs: ['mq2_adc_raw_0_4095', 'mq2_delta_from_baseline_pct'],
  },
  event_unauthorized_intrusion: {
    label: 'Unauthorized Intrusion',
    category: 'Physical Security',
    severity: 'high',
    action: 'Dispatch security patrol to zone; verify access badge logs and CCTV surveillance stream.',
    threshold: 0.32,
    sensorInputs: ['pir_motion_detected', 'camera_person_confidence', 'is_after_hours'],
  },
  event_vibration_anomaly: {
    label: 'Vibration Anomaly',
    category: 'Mechanical / Equipment',
    severity: 'warning',
    action: 'Inspect nearby motors, pumps, and mechanical mounts for loose fastenings or bearing failure.',
    threshold: 0.11,
    sensorInputs: ['sw420_digital_state', 'mpu_accel_magnitude_g', 'vibration_duration_s'],
  },
  event_structural_vibration_review: {
    label: 'Structural Vibration Review',
    category: 'Structural Integrity',
    severity: 'warning',
    action: 'Engage structural facilities engineer; review low-frequency resonance and building foundation sensor traces.',
    threshold: 0.05,
    sensorInputs: ['mpu_accel_magnitude_g', 'sw420_pulse_count_10s', 'vibration_duration_s'],
  },
  event_heat_risk: {
    label: 'Extreme Heat Risk',
    category: 'Environmental Safety',
    severity: 'high',
    action: 'Check HVAC cooling cycles; verify room air conditioning; protect temperature-sensitive electrical assets.',
    threshold: 0.19,
    sensorInputs: ['temperature_c', 'esp32_board_temp_c'],
  },
  event_high_humidity_mold_risk: {
    label: 'High Humidity / Mold Risk',
    category: 'Environmental & Air Quality',
    severity: 'warning',
    action: 'Deploy commercial dehumidification; inspect plumbing conduits, ceilings, and drywall for moisture ingress.',
    threshold: 0.25,
    sensorInputs: ['humidity_rh_pct', 'humidity_high_duration_min'],
  },
  event_device_fault: {
    label: 'Device Hardware Fault',
    category: 'IoT Hardware Health',
    severity: 'warning',
    action: 'Inspect probe wiring, replace failing sensor modules, and verify 3.3V power supply rail stability.',
    threshold: 0.31,
    sensorInputs: ['sensor_read_fail_count', 'esp32_3v3_rail_v', 'sensor_values_stale_sec'],
  },
  event_network_degradation: {
    label: 'Network Degradation',
    category: 'Connectivity & Telemetry',
    severity: 'info',
    action: 'Inspect Wi-Fi access point line-of-sight, antenna alignment, and check for 2.4 GHz channel interference.',
    threshold: 0.27,
    sensorInputs: ['wifi_rssi_dbm', 'packet_loss_pct', 'mqtt_latency_ms'],
  },
};

export const esp32SensorLabels = {
  temperature: 'Temperature (DHT22)',
  humidity: 'Humidity (DHT22)',
  gas_value: 'Combustible Gas (MQ-2 ADC)',
  fire: 'Flame Sensor',
  motion: 'Motion Detector (PIR)',
  vibration: 'Vibration & Tilt (SW-420 / MPU6050)',
  sos: 'Emergency SOS Button',
  wifi_rssi: 'Wi-Fi Signal Strength (RSSI)',
  device_status: 'Device Heartbeat & State',
};

export function formatEsp32Value(key, value, reading = {}) {
  if (value === undefined || value === null) return 'Not received';
  switch (key) {
    case 'temperature':
      return `${Number(value).toFixed(1)} °C`;
    case 'humidity':
      return `${Number(value).toFixed(1)} % RH`;
    case 'gas_value':
      return `${Math.round(value)} ADC (0–4095)`;
    case 'fire':
      if (typeof value === 'string') return value.toUpperCase();
      return value ? 'DANGER' : 'SAFE';
    case 'motion':
      if (typeof value === 'string') return value.toUpperCase();
      return value ? 'DETECTED' : 'NONE';
    case 'vibration': {
      const state = typeof value === 'string' ? value.toUpperCase() : value ? 'DETECTED' : 'NORMAL';
      const tilt = reading?.sensors?.tilt != null ? ` (Tilt: ${Number(reading.sensors.tilt).toFixed(1)}°)` : '';
      return `${state}${tilt}`;
    }
    case 'sos':
      return value ? 'EMERGENCY OVERRIDE (ACTIVE)' : 'Inactive';
    case 'wifi_rssi':
      return `${value} dBm (${value >= -60 ? 'Excellent' : value >= -75 ? 'Good' : 'Weak'})`;
    default:
      return String(value);
  }
}

