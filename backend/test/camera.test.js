// Phase 8 ESP32-CAM API tests.
//
// Unit cases run without any database. The persistence case is env-gated on
// the same isolated local MongoDB replica set as dashboard.test.js:
//   DASHBOARD_TEST_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0
// NEVER point these at production. A local synthetic HTTP camera serves a
// tiny generated JPEG; no physical camera is used or claimed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { settings } from '../src/config/settings.js';
import { createApp } from '../src/app.js';

// Minimal valid JPEG header bytes; the API validates type/size, not content.
const TINY_JPEG = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

function syntheticCamera(handler) {
  const server = createServer(handler).listen(0,'127.0.0.1');
  return once(server, 'listening').then(() => server);
}

test('camera snapshot URLs are validated to http(s) and bounded', () => {
  const config = settings({ CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam01: 'http://192.168.1.50:81/snapshot' }) });
  assert.equal(config.cameraSnapshotUrls.cam01, 'http://192.168.1.50:81/snapshot');
  assert.throws(() => settings({ CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam01: 'file:///etc/passwd' }) }));
  assert.throws(() => settings({ CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam01: 'ftp://host/x' }) }));
  assert.throws(() => settings({ CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ 'bad key': 'http://h/x' }) }));
  // Empty default keeps working.
  assert.deepEqual(settings({}).cameraSnapshotUrls, {});
});

test('camera APIs fail closed without token and report unconfigured devices honestly', async t => {
  const config = settings({ IOT_API_TOKEN: 'camera-test-token-'.repeat(2),
    CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam_unit_01: 'http://127.0.0.1:1/snapshot' }) });
  const status = { database: false, mqtt: false };
  const server = createApp(config, status).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/iot/cameras`;
  const auth = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' };
  // No token -> 401, token but no database -> 503. Never 200, never leaked URL.
  assert.equal((await fetch(base)).status, 401);
  const degraded = await fetch(base, { headers: auth });
  assert.equal(degraded.status, 503);
  const body = await degraded.text();
  assert.ok(!body.includes('192.168') && !body.includes('snapshot'), 'camera URLs must not leak in errors');
});

test('camera snapshot capture, storage and retrieval work end to end on isolated MongoDB', { skip: !process.env.DASHBOARD_TEST_URI }, async t => {
  const { mongoose } = await import('../src/config/database.js');
  const { ensureIndexes, CameraSnapshot, Alert, Device } = await import('../src/models/index.js');
  const dbName = `rbrick_camera_test_${randomUUID().replaceAll('-', '')}`;
  await mongoose.connect(process.env.DASHBOARD_TEST_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  t.after(async () => {
    assert(mongoose.connection.name.startsWith('rbrick_camera_test_'));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  await ensureIndexes();

  // Synthetic camera: serves a JPEG, then can be flipped to misbehave.
  let mode = 'jpeg';
  const camera = await syntheticCamera((req, res) => {
    if (mode === 'jpeg') { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': TINY_JPEG.length }); res.end(TINY_JPEG); }
    else if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>not an image</html>'); }
    else { res.writeHead(500); res.end('broken'); }
  });
  t.after(() => new Promise(resolve => camera.close(resolve)));
  const { port } = camera.address();

  const config = settings({ IOT_API_TOKEN: 'camera-test-token-'.repeat(2),
    CAMERA_SOURCES_JSON: JSON.stringify({cam_e2e_01:'simulation'}),
    CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam_e2e_01: `http://127.0.0.1:${port}/snapshot`,cam_hw_01:`http://127.0.0.1:${port}/snapshot` }) });
  const status = { database: true, mqtt: false };
  const server = createApp(config, status).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/iot/cameras`;
  const auth = { Authorization: `Bearer ${config.apiToken}`, 'Content-Type': 'application/json' };
  const request = async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + path, { method, headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = response.headers.get('content-type')?.startsWith('image/') ? null : await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
    return { data, response };
  };

  // Inventory: configured camera visible, honest "unknown" state, no URL leak.
  const inventory = (await request('/')).data;
  assert.equal(inventory.items[0].deviceId, 'cam_e2e_01');
  assert.equal(inventory.items[0].snapshotConfigured, true);
  assert.equal(inventory.items[0].cameraOnline, null, 'no heartbeat means unknown, not online');
  assert.ok(!JSON.stringify(inventory).includes(`127.0.0.1:${port}`), 'internal camera URL never sent to clients');

  // Capture without a registered device still works but is labeled simulation.
  const created = (await request('/cam_e2e_01/snapshots', 'POST', {}, 201)).data;
  assert.equal(created.item.deviceId, 'cam_e2e_01');
  assert.equal(created.item.contentType, 'image/jpeg');
  assert.equal(created.item.source, 'simulation', 'unregistered device snapshot labeled simulation');
  assert.equal(await CameraSnapshot.countDocuments(), 1);

  // Image retrieval returns the exact bytes with the right content type.
  const image = await fetch(`${base}/snapshots/${created.item._id}/image`, { headers: auth });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), TINY_JPEG);

  // Register the device with a camera heartbeat -> hardware-labeled metadata.
  await Device.create({ deviceId: 'cam_hw_01', cameraOnline: true, cameraStatusAt: new Date(), lastSeenAt: new Date() });
  const hardware = (await request('/cam_hw_01/snapshots', 'POST', {}, 201)).data;
  assert.equal(hardware.item.source, undefined, 'device with hardware heartbeats is not auto-labeled simulation');

  // Incident association: snapshot can reference an existing alert only.
  const { SensorReading } = await import('../src/models/index.js');
  const reading = await SensorReading.create({ deviceId: 'cam_hw_01', observedAt: new Date(), receivedAt: new Date(), sensors: {}, topic: 'synthetic' });
  const alert = await Alert.create({ deviceId: 'cam_hw_01', readingId: reading._id, kind: 'safety', field: 'flame', message: 'Synthetic', observedAt: new Date() });
  const linked = (await request('/cam_hw_01/snapshots', 'POST', { alertId: alert._id }, 201)).data;
  assert.deepEqual(linked.item.alertIds.map(String), [String(alert._id)]);
  assert.equal((await request(`/snapshots?alertId=${alert._id}`)).data.items.length, 1);
  await request('/cam_hw_01/snapshots', 'POST', { alertId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }, 404);

  // Failure modes stay graceful and never crash the app.
  mode = 'html';
  await request('/cam_e2e_01/snapshots', 'POST', {}, 502);
  mode = 'broken';
  await request('/cam_e2e_01/snapshots', 'POST', {}, 502);
  mode = 'jpeg';
  await request('/unknown_cam/snapshots', 'POST', {}, 404);
  await request('/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1/image', 'GET', undefined, 400);
  // Oversized response rejected before storage.
  const big = await syntheticCamera((req, res) => {
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': 5 * 1024 * 1024 });
    res.end(Buffer.alloc(5 * 1024 * 1024));
  });
  t.after(() => new Promise(resolve => big.close(resolve)));
  const { settings: mk } = await import('../src/config/settings.js');
  const bigConfig = mk({ IOT_API_TOKEN: 'camera-test-token-'.repeat(2),
    CAMERA_SNAPSHOT_URLS_JSON: JSON.stringify({ cam_big: `http://127.0.0.1:${big.address().port}/snapshot` }) });
  const bigServer = createApp(bigConfig, { database: true, mqtt: false }).listen(0, '127.0.0.1');
  await once(bigServer, 'listening');
  t.after(() => new Promise(resolve => bigServer.close(resolve)));
  const bigRes = await fetch(`http://127.0.0.1:${bigServer.address().port}/api/iot/cameras/cam_big/snapshots`, {
    method: 'POST', headers: { Authorization: `Bearer ${bigConfig.apiToken}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(bigRes.status, 502);
  assert.equal(await CameraSnapshot.countDocuments(), 3, 'oversized snapshot not stored');
});
