import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTopic, parseChannelMessage, DEFAULT_V1_TOPICS } from '../src/services/telemetrySchema.js';
import { analyzeReading } from '../src/services/riskEngine.js';
import { recordDeviceState } from '../src/services/ingestV1.js';
import { Device } from '../src/models/index.js';
test('short firmware topics coexist with building-qualified topics and reject identity mismatch', () => {
  const payload = { schema_version: '1.0', message_id: 'test-1', device_id: 'esp32_main_01',
    building_id: 'building01', zone_id: 'zone01', timestamp: new Date().toISOString(), source: 'hardware', firmware_version: '1.0.0',
    sensors: { temperature: 25, humidity: 50, mq2_raw: 200, vibration_rms: 0.1, sw420: false, pir: false, flame: false, sos: false } };
  for (const topic of ['building/zone01/esp32_main_01/telemetry', 'building/building01/zone01/esp32_main_01/telemetry']) {
    assert.equal(parseChannelMessage('telemetry', topic, payload).device_id, 'esp32_main_01');
  }
  assert.throws(() => parseChannelMessage('telemetry', 'building/other/esp32_main_01/telemetry', payload));
  assert.throws(() => parseChannelMessage('telemetry', 'building/zone01/other/telemetry', payload));
  assert.equal(parseTopic('building/zone01/esp32_cam_01/camera/status').channel, 'camera/status');
  assert.equal(parseTopic('building/zone01/esp32_main_01/availability').buildingId, null);
  const availability = parseChannelMessage('availability', 'building/zone01/esp32_main_01/availability', 'offline');
  assert.equal(availability.zone_id, 'zone01');
  assert.equal(availability.device_id, 'esp32_main_01');
  assert.equal(availability.building_id, null);
  assert.equal(parseChannelMessage('availability', 'building/building01/zone01/esp32_main_01/availability', 'offline').building_id, 'building01');
  assert.equal(parseTopic('building/zone01/esp32_main_01/not-a-channel'), null);
  assert(DEFAULT_V1_TOPICS.includes('building/+/+/telemetry'));
  assert(DEFAULT_V1_TOPICS.includes('building/+/+/+/telemetry'));
});

test('unavailable hardware readings require exact-field unhealthy status and never become healthy zeroes', () => {
  const fields = ['temperature','humidity','mq2_raw','vibration_rms','sw420','pir','flame','sos'];
  const payload = { schema_version: '1.0', message_id: 'missing-1', device_id: 'esp32_main_01',
    building_id: 'building01', zone_id: 'zone01', timestamp: new Date().toISOString(),
    source: 'hardware', firmware_version: '1.0.0',
    sensors: Object.fromEntries(fields.map(f => [f, null])),
    health: Object.fromEntries(fields.map(f => [f, 'missing'])) };
  const parse = () => parseChannelMessage('telemetry', 'building/zone01/esp32_main_01/telemetry', payload);
  const message = parse();
  const risk = analyzeReading({ deviceId: message.device_id, sensors: message.sensors,
    health: message.health, observedAt: message.observedAt, source: 'hardware' });
  assert.equal(risk.dataQuality.distrusted.length, fields.length);
  assert.equal(risk.dataQuality.invalid.length, 0);
  assert.equal(risk.incidents.some(i => ['sos','flame'].includes(i.kind)), false);
  payload.health.sos = 'ok';
  assert.throws(parse);
  delete payload.health.sos;
  assert.throws(parse);
  payload.health.sos = 'error';
  assert.doesNotThrow(parse);
});

test('short-topic availability preserves an existing building assignment', async () => {
  const original = Device.updateOne;
  let captured;
  Device.updateOne = async (filter, update) => { captured = { filter, update }; };
  try {
    await recordDeviceState({ deviceId: 'esp32_main_01', buildingId: null,
      zoneId: 'zone01', state: 'offline', kind: 'availability' });
    assert.equal(captured.filter.deviceId, 'esp32_main_01');
    assert.equal(captured.update.$set.zoneId, 'zone01');
    assert.equal(captured.update.$set.online, false);
    assert.equal(Object.hasOwn(captured.update.$set, 'buildingId'), false);
  } finally { Device.updateOne = original; }
});
