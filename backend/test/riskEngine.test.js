import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeReading, normalizeSensors, resolveThresholds, DEFAULT_THRESHOLDS } from '../src/services/riskEngine.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');
const fresh = (secondsAgo = 5) => new Date(NOW.getTime() - secondsAgo * 1000);
const healthy = () => ({ temperature: 'ok', humidity: 'ok', mq2_raw: 'ok', vibration_rms: 'ok', sw420: 'ok', pir: 'ok', flame: 'ok', sos: 'ok' });
const baseSensors = () => ({ temperature: 24, humidity: 50, mq2_raw: 200, vibration_rms: 0.05, sw420: false, pir: false, flame: false, sos: false });
const reading = (overrides = {}) => ({
  deviceId: 'sim_node_01',
  observedAt: fresh(),
  sensors: { ...baseSensors(), ...(overrides.sensors || {}) },
  health: { ...healthy(), ...(overrides.health || {}) },
  source: 'simulation',
  ...(overrides.observedAt ? { observedAt: overrides.observedAt } : {}),
});

test('normal readings produce NORMAL risk with zero score', () => {
  const result = analyzeReading(reading(), { now: NOW });
  assert.equal(result.classification, 'NORMAL');
  assert.equal(result.score, 0);
  assert.equal(result.stale, false);
  assert.equal(result.source, 'simulation');
  assert.deepEqual(result.incidents, []);
});

test('deterministic: same input and now produce identical results', () => {
  const a = analyzeReading(reading({ sensors: { temperature: 50 } }), { now: NOW });
  const b = analyzeReading(reading({ sensors: { temperature: 50 } }), { now: NOW });
  assert.deepEqual({ ...a, analyzedAt: 0 }, { ...b, analyzedAt: 0 });
});

test('elevated temperature scales through MODERATE/HIGH/CRITICAL bands', () => {
  assert.equal(analyzeReading(reading({ sensors: { temperature: 42 } }), { now: NOW }).classification, 'MODERATE');
  assert.equal(analyzeReading(reading({ sensors: { temperature: 56 } }), { now: NOW }).classification, 'HIGH');
  assert.equal(analyzeReading(reading({ sensors: { temperature: 71 } }), { now: NOW }).classification, 'CRITICAL');
});

test('MQ-2 raw thresholds classify risk and explain the factor', () => {
  const result = analyzeReading(reading({ sensors: { mq2_raw: 1600 } }), { now: NOW });
  assert.equal(result.classification, 'HIGH');
  const factor = result.factors.find(f => f.factor === 'mq2_raw');
  assert.ok(factor);
  assert.equal(factor.value, 1600);
  assert.equal(factor.threshold, DEFAULT_THRESHOLDS.mq2_raw.high);
  assert.match(factor.message, /MQ-2 raw 1600/);
});

test('abnormal vibration and SW-420 raise vibration factors', () => {
  const rms = analyzeReading(reading({ sensors: { vibration_rms: 1.5 } }), { now: NOW });
  assert.equal(rms.classification, 'HIGH');
  assert.ok(rms.factors.some(f => f.factor === 'vibration'));
  const sw = analyzeReading(reading({ sensors: { sw420: true } }), { now: NOW });
  assert.equal(sw.classification, 'LOW');
  assert.ok(sw.factors.some(f => f.factor === 'sw420'));
});

test('flame indication forces CRITICAL and raises an incident', () => {
  const result = analyzeReading(reading({ sensors: { flame: true } }), { now: NOW });
  assert.equal(result.classification, 'CRITICAL');
  const incident = result.incidents.find(i => i.kind === 'flame');
  assert.ok(incident);
  assert.equal(incident.classification, 'CRITICAL');
});

test('SOS activation is an emergency regardless of other sensors', () => {
  const result = analyzeReading(reading({ sensors: { sos: true } }), { now: NOW });
  assert.equal(result.classification, 'CRITICAL');
  assert.ok(result.incidents.some(i => i.kind === 'sos'));
});

test('PIR motion alone is informational, never an intrusion claim', () => {
  const result = analyzeReading(reading({ sensors: { pir: true } }), { now: NOW });
  assert.equal(result.classification, 'LOW');
  const factor = result.factors.find(f => f.factor === 'pir');
  assert.equal(factor.informational, true);
  assert.match(factor.message, /not treated as intrusion/);
  assert.equal(result.incidents.length, 0);
});

test('incident deduplication: repeat within cooldown is marked recurrent', () => {
  const openIncidents = new Map();
  const opts = { now: NOW, openIncidents };
  const first = analyzeReading(reading({ sensors: { flame: true } }), opts);
  assert.equal(first.incidents[0].recurrent, false);
  const second = analyzeReading(reading({ sensors: { flame: true } }),
    { ...opts, now: new Date(NOW.getTime() + 60_000) });
  assert.equal(second.incidents[0].recurrent, true);
  const afterCooldown = analyzeReading(reading({ sensors: { flame: true } }),
    { ...opts, now: new Date(NOW.getTime() + (DEFAULT_THRESHOLDS.incidentCooldownSeconds + 10) * 1000) });
  assert.equal(afterCooldown.incidents[0].recurrent, false);
});

test('stale readings are flagged and never presented as current safety', () => {
  const result = analyzeReading(reading({ observedAt: fresh(600), sensors: { temperature: 45 } }), { now: NOW });
  assert.equal(result.stale, true);
  assert.ok(result.factors.some(f => f.factor === 'stale'));
  assert.ok(result.dataQuality.stale);
  // classification still reflects last known state
  assert.equal(result.classification, 'MODERATE');
});

test('invalid, missing and distrusted sensor values are excluded and reported', () => {
  // Direct reading (not reading()) so mq2_raw is genuinely absent.
  const result = analyzeReading({
    deviceId: 'sim_node_01', observedAt: fresh(), source: 'simulation',
    sensors: { temperature: '24', humidity: 500, vibration_rms: Infinity,
      sw420: false, pir: false, flame: false, sos: false },
    health: { ...healthy(), sw420: 'error' },
  }, { now: NOW });
  assert.equal(result.score, 0 + DEFAULT_THRESHOLDS.weights.fault); // only the fault factor contributes
  assert.ok(result.dataQuality.invalid.some(i => i.field === 'temperature' && i.reason === 'not_finite_number' || i.field === 'temperature'));
  assert.ok(result.dataQuality.invalid.some(i => i.field === 'humidity' && i.reason === 'out_of_range'));
  assert.ok(result.dataQuality.invalid.some(i => i.field === 'vibration_rms'));
  assert.ok(result.dataQuality.missing.includes('mq2_raw'));
  assert.ok(result.dataQuality.distrusted.some(d => d.field === 'sw420' && d.health === 'error'));
  assert.ok(result.factors.some(f => f.factor === 'fault'));
});

test('health distrust prevents false emergency from dead sensor reporting garbage', () => {
  const result = analyzeReading(reading({ sensors: { flame: true, temperature: 30 }, health: { ...healthy(), flame: 'missing' } }), { now: NOW });
  // The distrusted flame value must not become an emergency; the sensor fault
  // itself still surfaces as a LOW-severity data-quality factor.
  assert.equal(result.classification, 'LOW');
  assert.ok(!result.factors.some(f => f.factor === 'flame'));
  assert.ok(!result.incidents.some(i => i.kind === 'flame'));
  assert.ok(result.dataQuality.distrusted.some(d => d.field === 'flame'));
});

test('threshold overrides are honored', () => {
  const thresholds = resolveThresholds({ temperature: { warning: 25 }, incidentCooldownSeconds: 60 });
  const result = analyzeReading(reading({ sensors: { temperature: 26 } }), { now: NOW, thresholds });
  assert.equal(result.classification, 'MODERATE');
  assert.equal(thresholds.incidentCooldownSeconds, 60);
});

test('normalizeSensors enforces types and ranges', () => {
  const { values, invalid } = normalizeSensors({ temperature: 24.5, sw420: 'yes', mq2_raw: 99999 });
  assert.equal(values.temperature, 24.5);
  assert.ok(invalid.some(i => i.field === 'sw420'));
  assert.ok(invalid.some(i => i.field === 'mq2_raw' && i.reason === 'out_of_range'));
});

test('deviceId is required', () => {
  assert.throws(() => analyzeReading({ sensors: {} }, { now: NOW }));
});
