import test from 'node:test';
import assert from 'node:assert/strict';
import { once, EventEmitter } from 'node:events';
import { parseContract, settings } from '../src/config/settings.js';
import { createPayloadParser, evaluateRules } from '../src/services/payload.js';
import { createApp } from '../src/app.js';
import { startMqtt } from '../src/services/mqttService.js';
import { databaseFailure } from '../src/config/databaseErrors.js';

test('database diagnostics classify failures without exposing raw credential-bearing errors', () => {
  const secret = 'synthetic-secret-that-must-not-be-logged';
  const auth = databaseFailure({ code: 8000, message: `bad auth : authentication failed mongodb+srv://user:${secret}@host/` });
  assert.equal(auth.code, 'authentication_failed');
  assert.ok(!JSON.stringify(auth).includes(secret));
  assert.equal(databaseFailure({ code: 18 }).code, 'authentication_failed');
  assert.equal(databaseFailure({ code: 13 }).code, 'permission_denied');
  assert.equal(databaseFailure({ cause: { code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' } }).code, 'tls_failed');
  assert.equal(databaseFailure({ code: 'ENOTFOUND' }).code, 'dns_failed');
  assert.equal(databaseFailure({ name: 'MongoParseError', message: secret }).code, 'invalid_uri');
  assert.ok(!JSON.stringify(databaseFailure({ message: secret })).includes(secret));
});

// These are deliberately synthetic contracts, not claimed firmware formats.
const env = { SENSOR_FIELDS_JSON: '{"heat":"number","help":"boolean"}',
  DEVICE_ID_FIELD: 'board', EVENT_ID_FIELD: 'sequence', TIMESTAMP_FIELD: 'time',
  ALERT_RULES_JSON: '[{"field":"help","operator":"eq","value":true,"kind":"sos","message":"Help requested"}]' };
const contract = parseContract(env);
const parse = createPayloadParser(contract);
test('maps configured firmware fields and preserves zero/false without inventing absent values', () => {
  const reading = parse({ board: 'test-device', heat: 0, help: false });
  assert.deepEqual(reading.sensors, { heat: 0, help: false });
  assert.equal(reading.deviceId, 'test-device');
  assert.equal(reading.eventId, undefined);
  assert.deepEqual(parse({ board: 'test-device', heat: 1 }).sensors, { heat: 1 });
});
test('rejects unknown fields, strings for numbers, invalid booleans, IDs and future timestamps', () => {
  for (const payload of [
    { board: 'test-device', heat: '20' }, { board: 'test-device', help: 1 },
    { board: 'test-device', surprise: 12 }, { board: { $ne: null }, heat: 2 },
    { board: 'test-device' }, { board: 'test-device', heat: Infinity },
    { board: 'test-device', heat: 1, time: '2099-01-01T00:00:00Z' },
  ]) assert.throws(() => parse(payload));
});
test('no ingestion contract or alert defaults are silently introduced', () => {
  assert.throws(() => createPayloadParser(parseContract({}))({ deviceId: 'test', heat: 2 }));
  assert.deepEqual(evaluateRules({ heat: 1000 }, []), []);
  assert.equal(settings({}).mqttEnabled, false);
  assert.throws(() => settings({ MQTT_ENABLED: 'true' }));
});
test('rules match only configured provided values and reject mismatched types', () => {
  assert.equal(evaluateRules({ help: true }, contract.rules).length, 1);
  assert.equal(evaluateRules({ help: false }, contract.rules).length, 0);
  assert.equal(evaluateRules({ heat: 50 }, contract.rules).length, 0);
  assert.throws(() => parseContract({ ...env, ALERT_RULES_JSON: '[{"field":"unknown","operator":"gt","value":1,"kind":"safety","message":"x"}]' }));
  assert.throws(() => parseContract({ SENSOR_FIELDS_JSON: '{"__proto__":"number"}' }));
  assert.throws(() => parseContract({ SENSOR_FIELDS_JSON: '{"deviceId":"number"}' }));
});
test('HTTP liveness, dependency readiness and API authentication fail closed', async t => {
  const config = settings({ IOT_API_TOKEN: 'x'.repeat(32) });
  const server = createApp(config, { database: false, mqtt: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/health/live`)).status, 200);
  const ready = await fetch(`${base}/api/health/ready`);
  assert.equal(ready.status, 503);
  assert.equal((await ready.json()).database, 'unavailable');
  assert.equal((await fetch(`${base}/api/iot/readings`)).status, 401);
  assert.equal((await fetch(`${base}/api/iot/readings`, { headers: { Authorization: `Bearer ${config.apiToken}` } })).status, 503);
  const missing = await fetch(`${base}/api/unimplemented`);
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /application\/json/);
  assert.equal(missing.headers.get('x-powered-by'), null);
  const invalid = await fetch(`${base}/api/iot/history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
  assert.equal(invalid.status, 400);
});

test('MQTT acknowledges valid messages after persistence and drops poison messages without storing', async () => {
  const client = new EventEmitter();
  const status = { persisted: 0, rejected: 0, persistenceFailures: 0 };
  let release;
  let stored = false;
  let acknowledged = false;
  startMqtt({ mqttEnabled: true, contract }, status, {
    connect: () => client,
    store: async () => { stored = true; return new Promise(resolve => { release = resolve; }); },
  });
  client.handleMessage({ topic: 'synthetic-test', payload: Buffer.from('{"board":"test","heat":1}') }, error => {
    assert.equal(error, undefined); acknowledged = true;
  });
  assert.equal(stored, true);
  assert.equal(acknowledged, false);
  release({ duplicate: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, true);
  assert.equal(status.persisted, 1);
  stored = false;
  client.handleMessage({ topic: 'synthetic-test', payload: Buffer.from('{broken') }, error => assert.equal(error, undefined));
  assert.equal(stored, false);
  assert.equal(status.rejected, 1);
});

test('MQTT database failure requests reconnect and returns error instead of success acknowledgement', async () => {
  const client = new EventEmitter();
  let destroyed = false;
  client.stream = { destroy: () => { destroyed = true; } };
  const status = { persisted: 0, rejected: 0, persistenceFailures: 0 };
  startMqtt({ mqttEnabled: true, contract }, status, {
    connect: () => client, store: async () => { throw new Error('Synthetic database outage'); },
  });
  const error = await new Promise(resolve => client.handleMessage({
    topic: 'synthetic-test', payload: Buffer.from('{"board":"test","heat":1}'),
  }, resolve));
  assert.ok(error instanceof Error);
  assert.equal(destroyed, true);
  assert.equal(status.persistenceFailures, 1);
});
