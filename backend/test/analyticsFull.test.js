import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { settings } from '../src/config/settings.js';

test('Analytics endpoints require valid bearer token and fail closed', async (t) => {
  const config = settings({ IOT_API_TOKEN: 'analytics-test-token-'.repeat(2) });
  const server = createApp(config, { database: true, mqtt: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}/api/analytics`;

  // Without auth header -> 401
  const unauthHistorical = await fetch(`${base}/historical`);
  assert.equal(unauthHistorical.status, 401);

  const unauthModelStatus = await fetch(`${base}/model-status`);
  assert.equal(unauthModelStatus.status, 401);

  const unauthAnomalies = await fetch(`${base}/anomalies`);
  assert.equal(unauthAnomalies.status, 401);

  const unauthDeviceHealth = await fetch(`${base}/device-health`);
  assert.equal(unauthDeviceHealth.status, 401);

  const unauthPerformance = await fetch(`${base}/performance`);
  assert.equal(unauthPerformance.status, 401);
});

test('Analytics model-status reports truthful metadata and future model directory paths', async (t) => {
  const config = settings({ IOT_API_TOKEN: 'analytics-test-token-'.repeat(2) });
  const server = createApp(config, { database: true, mqtt: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}/api/analytics`;
  const res = await fetch(`${base}/model-status`, {
    headers: { Authorization: `Bearer ${config.apiToken}` }
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.equal(data.futureModelReady, true);
  assert.equal(data.datasetDirectories.raw, 'ai_ml/datasets/raw/');
  assert.equal(data.datasetDirectories.processed, 'ai_ml/datasets/processed/');
  assert.equal(data.modelsDirectories.trained, 'ai_ml/models/trained/');
  assert.equal(data.modelsDirectories.artifacts, 'ai_ml/models/artifacts/');
  assert.equal(Array.isArray(data.supportedFrameworks), true);
});
