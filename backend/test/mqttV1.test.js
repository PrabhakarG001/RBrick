import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import mqtt from 'mqtt';
import { startMqttV1 } from '../src/services/mqttServiceV1.js';
import { settings } from '../src/config/settings.js';

const telemetry = () => ({ schema_version: '1.0', message_id: crypto.randomUUID(),
  device_id: 'sim_node_01', building_id: 'building01', zone_id: 'zoneA',
  timestamp: new Date().toISOString(), source: 'simulation', firmware_version: 'sim-1',
  sensors: { temperature: 24, humidity: 50, mq2_raw: 100, vibration_rms: 0,
    sw420: false, pir: false, flame: false, sos: false }, health: {} });
const config = () => settings({ MQTT_ENABLED: 'true', MQTT_URL: 'mqtt://127.0.0.1:18887',
  MQTT_CLIENT_ID: 'phase4-test' });
const state = () => ({ persisted: 0, rejected: 0, persistenceFailures: 0 });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('v1 consumer validates identity, rejects retained emergency replay and broadcasts applied device states', async () => {
  const client = new EventEmitter();
  client.subscribe = (topics, options, done) => done(null, Object.keys(topics).filter(topic => topic !== 'resubscribe').map(topic => ({ topic, qos: 1 })));
  const events = [], status = state();
  let options;
  startMqttV1(config(), status, { connect: (url, opts) => { options = opts; return client; },
    recordState: async () => ({ acknowledged: true }), broadcast: (...event) => events.push(event) });
  client.emit('connect'); assert.equal(status.mqtt, true);
  assert.equal(options.clean, false); assert.equal(options.reconnectPeriod, 5000);
  const dispatch = async (topic, payload, retain = false) => {
    await new Promise(resolve => client.handleMessage({ topic, payload: Buffer.from(payload), retain }, resolve));
    await tick();
  };
  await dispatch('building/zoneA/sim_node_01/availability', 'offline');
  assert.equal(events[0][0], 'device_status'); assert.equal(events[0][1].state, 'offline');
  assert.equal(events[0][1].deviceId, 'sim_node_01');
  const before = events.length;
  await dispatch('building/zoneA/other-device/telemetry', JSON.stringify(telemetry()));
  await dispatch('building/zoneA/sim_node_01/telemetry', '{bad');
  await dispatch('building/zoneA/sim_node_01/events', '{}', true);
  assert.equal(status.rejected, 3); assert.equal(events.length, before);
  client.emit('reconnect'); assert.equal(status.mqtt, false); assert.equal(status.mqttReconnects, 1);
  client.emit('connect'); assert.equal(status.mqtt, true);
});

test('v1 database failure never acknowledges success or broadcasts data', async () => {
  const client = new EventEmitter(); let destroyed = false;
  client.stream = { destroy: () => { destroyed = true; } };
  const status = state(), events = [];
  startMqttV1(config(), status, { connect: () => client,
    storeTelemetry: async () => { throw Error('database unavailable'); }, broadcast: (...event) => events.push(event) });
  const error = await new Promise(resolve => client.handleMessage({
    topic: 'building/zoneA/sim_node_01/telemetry', payload: Buffer.from(JSON.stringify(telemetry())),
  }, resolve));
  await tick();
  assert(error instanceof Error); assert(destroyed);
  assert.equal(status.persistenceFailures, 1); assert.equal(events.length, 0);
});

test('native broker delivers simulated messages to the existing MQTT.js consumer', {
  skip: !process.env.MQTT_V1_TEST_URL, timeout: 20000,
}, async t => {
  const status = state(), stored = [], events = [];
  const cfg = settings({ MQTT_ENABLED: 'true', MQTT_URL: process.env.MQTT_V1_TEST_URL,
    MQTT_USERNAME: 'backend', MQTT_PASSWORD: process.env.TEST_BACKEND_MQTT_PASSWORD,
    MQTT_CLIENT_ID: `phase4-backend-${crypto.randomUUID()}` });
  const subscriber = startMqttV1(cfg, status, { storeTelemetry: async message => {
    stored.push(message); return { duplicate: false, alerts: [] };
  }, recordState: async () => ({ acknowledged: true }), broadcast: (...event) => events.push(event) });
  t.after(() => subscriber.endAsync(true));
  const publisher = mqtt.connect(cfg.mqttUrl, { username: 'simulator', password: process.env.TEST_SIMULATOR_MQTT_PASSWORD,
    reconnectPeriod: 0 });
  t.after(() => publisher.endAsync(true));
  await once(publisher, 'connect');
  const wait = async predicate => {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    assert(predicate(), 'Timed out waiting for broker delivery');
  };
  await wait(() => status.mqtt);
  await publisher.publishAsync('building/zoneA/sim_node_01/telemetry', JSON.stringify(telemetry()), { qos: 1 });
  await wait(() => stored.length === 1);
  assert.equal(stored[0].source, 'simulation');
  await publisher.publishAsync('building/zoneA/sim_node_01/telemetry', 'not-json', { qos: 1 });
  await wait(() => status.rejected === 1);
  await publisher.publishAsync('building/zoneA/sim_node_01/availability', 'offline', { qos: 1 });
  await wait(() => events.some(([event]) => event === 'device_status'));
  // Exercise actual client reconnect/resubscribe without creating a second consumer.
  subscriber.stream.destroy();
  await wait(() => !status.mqtt);
  await wait(() => status.mqtt && status.mqttReconnects >= 1);
  await publisher.publishAsync('building/zoneA/sim_node_01/telemetry', JSON.stringify(telemetry()), { qos: 1 });
  await wait(() => stored.length === 2);
});
