import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { settings } from '../src/config/settings.js';
import { mongoose } from '../src/config/database.js';
import { createApp } from '../src/app.js';
import { ensureIndexes, Device, Alert, MaintenanceTask, SensorReading } from '../src/models/index.js';
import { createPayloadParser } from '../src/services/payload.js';
import { storeReading } from '../src/services/ingest.js';

test('dashboard APIs persist device, incident and maintenance workflows against isolated MongoDB', { skip: !process.env.DASHBOARD_TEST_URI }, async t => {
  const dbName = `rbrick_dashboard_test_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(process.env.DASHBOARD_TEST_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  t.after(async () => { assert(mongoose.connection.name.startsWith('rbrick_dashboard_test_')); await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await ensureIndexes();
  const config = settings({ IOT_API_TOKEN: 'dashboard-test-token-'.repeat(3),
    SENSOR_FIELDS_JSON: JSON.stringify({ temperature: 'number', humidity: 'number', gas: 'number', leak: 'boolean', door: 'boolean', sos: 'boolean' }),
    SENSOR_DISPLAY_JSON: JSON.stringify({ temperature: 'temperature', humidity: 'humidity', gas: 'gas', waterLeak: 'leak', doorOpen: 'door', sos: 'sos' }),
    ALERT_RULES_JSON: JSON.stringify([{ field: 'sos', operator: 'eq', value: true, kind: 'sos', message: 'Synthetic test SOS', severity: 'critical' }, { field: 'leak', operator: 'eq', value: true, kind: 'safety', message: 'Synthetic test leak', severity: 'warning' }]),
  });
  const status = { database: true, mqtt: true }; config.mqttEnabled = true;
  const server = createApp(config, status).listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/iot`;
  async function request(path, method = 'GET', body, expected = 200) {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  }
  assert.equal((await fetch(base + '/summary')).status, 401);
  const registered = await request('/devices', 'POST', { deviceId: 'synthetic-esp32', name: 'Test board', area: 'Test lab' }, 201);
  await request('/devices', 'POST', { deviceId: 'synthetic-esp32' }, 409);
  await request(`/devices/${registered.item._id}`, 'PATCH', { area: 'Validation area' });
  assert.equal((await Device.findById(registered.item._id)).area, 'Validation area');
  const parse = createPayloadParser(config.contract), now = Date.now();
  for (let i = 0; i < 4; i++) {
    const reading = parse({ deviceId: 'synthetic-esp32', eventId: `synthetic-${i}`, temperature: 20+i, humidity: 45+i, gas: i, leak: i===1, door: i%2===0, sos: i===2 });
    reading.receivedAt = new Date(now - (3-i)*3600000); reading.observedAt = reading.receivedAt;
    await storeReading(reading, 'synthetic/test/telemetry', config.contract.rules);
  }
  const summary = await request('/summary');assert.equal(summary.devices,1);assert.equal(summary.active,2);assert.equal(summary.critical,1);assert.equal(summary.online,1);
  const pages = await Promise.all([request('/readings?limit=2&page=1'),request('/readings?limit=2&page=2')]);assert.equal(pages[0].total,4);assert.equal(new Set(pages.flatMap(p=>p.items.map(r=>r._id))).size,4);
  assert.equal((await request('/alerts?severity=critical')).total,1);
  const critical = (await request('/alerts?severity=critical')).items[0];
  await request(`/alerts/${critical._id}/acknowledge`, 'PATCH', {});assert((await Alert.findById(critical._id)).acknowledgedAt);
  assert.equal((await request('/alerts?status=acknowledged')).total,1);
  await request(`/alerts/${critical._id}/resolve`, 'PATCH', { resolution: 'Synthetic emergency drill completed.' });
  assert((await Alert.findById(critical._id)).resolvedAt);assert.equal((await request('/alerts?status=resolved')).total,1);
  await request(`/alerts/${critical._id}/acknowledge`, 'PATCH', {}, 409);
  await request('/tasks','POST',{deviceId:'unknown',description:'Check wiring',dueAt:new Date().toISOString()},404);
  const task=(await request('/tasks','POST',{deviceId:'synthetic-esp32',description:'Inspect power and sensor wiring',priority:'high',dueAt:new Date(now-1000).toISOString()},201)).item;
  assert.equal((await request('/summary')).due,1);
  await request(`/tasks/${task._id}`,'PATCH',{description:'Inspect power, wiring and sensor enclosure',status:'in_progress'});
  await request(`/tasks/${task._id}`,'PATCH',{status:'completed'});
  await request(`/tasks/${task._id}`,'PATCH',{status:'completed'},409);
  const saved=await MaintenanceTask.findById(task._id);assert.equal(saved.status,'completed');assert(saved.completedAt);assert.equal((await request('/summary')).due,0);
  assert((await request('/devices')).items[0].lastMaintenanceAt);
  await request('/history','POST',{deviceId:'synthetic-esp32',kind:'maintenance',note:'Synthetic inspection complete',occurredAt:new Date().toISOString()},201);
  assert.equal((await request('/history')).total,1);
  const from = new Date(now-86400000).toISOString();const analytics=await request('/analytics?from='+from);assert(analytics.trends.length>=6);assert.equal(analytics.completed,1);assert.equal(analytics.doorHistory.length,4);assert.equal(analytics.incidents.reduce((n,r)=>n+r.count,0),2);
  assert.equal((await request('/analytics?from='+from+'&deviceId=other')).trends.length,0);
  await request('/devices','POST',{deviceId:{$ne:null}},400);await request('/tasks','POST',{deviceId:'synthetic-esp32',description:'x',dueAt:'bad'},400);await request('/readings?unexpected=1','GET',undefined,400);
  assert.equal(await SensorReading.countDocuments(),4);
  status.mqtt=false;assert.equal((await request('/summary')).online,null);assert.equal((await request('/status')).mqtt,'unavailable');
  status.database=false;assert.equal((await request('/status')).database,'unavailable');await request('/readings','GET',undefined,503);
});
