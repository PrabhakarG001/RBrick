import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { settings } from '../src/config/settings.js';
import { createAiServiceClient, AiServiceError } from '../src/services/aiServiceClient.js';

const input = () => ({ schema_version: '1.0', message_id: 'test-1', device_id: 'test-device',
  building_id: 'b1', zone_id: 'z1', timestamp: new Date().toISOString(), source: 'simulation',
  firmware_version: 'test-1', sensors: { sos: false }, health: {} });
test('AI service configuration rejects credential-bearing/non-HTTP URLs and invalid timeouts', () => {
  for (const url of ['ftp://localhost','http://user:secret@localhost','http://localhost/path','http://localhost/?token=x']) {
    assert.throws(() => settings({ AI_SERVICE_URL: url }));
  }
  assert.throws(() => settings({ AI_TIMEOUT_MS: '1' }));
});

test('AI timeout, HTTP failure, malformed/oversize/mismatched outputs never produce a fallback score', async t => {
  let mode = 'timeout';
  const server = createServer(async (req, res) => {
    if (mode === 'timeout') { setTimeout(() => res.end('{}'), 400).unref(); return; }
    if (mode === 'http') { res.writeHead(503); res.end('private details'); return; }
    if (mode === 'oversize') { res.end('x'.repeat(70000)); return; }
    if (mode === 'mismatched') {
      const message = input();
      res.end(JSON.stringify({device_id:'wrong-device',message_id:message.message_id,zone_id:message.zone_id,
        source:'simulation',timestamp:message.timestamp,risk_score:0,risk_level:'NORMAL',hazards:[],incidents:[],
        data_quality:{invalid:[],missing:[],distrusted:[],stale:false},features:{},stale:false,
        analyzed_at:new Date().toISOString(),model_version:'python-rules-v1',engine_version:'1.0.0',incident_cooldown_seconds:300}));
      return;
    }
    res.setHeader('Content-Type','application/json');
    res.end(mode === 'malformed' ? '{broken' : JSON.stringify({ risk_score: 0, risk_level: 'NORMAL' }));
  }).listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const status = {};
  const client = createAiServiceClient({ aiServiceUrl: `http://127.0.0.1:${server.address().port}`, aiTimeoutMs: 100 },status);
  for (const [value, code] of [['timeout','timeout'],['http','unavailable'],['oversize','invalid_response'],['malformed','invalid_response'],['incomplete','invalid_response'],['mismatched','invalid_response']]) {
    mode = value;
    await assert.rejects(client.predict(input()), error => error instanceof AiServiceError && error.code === code && !error.message.includes('private details'));
    assert.equal(status.ai,false);
  }
  assert.equal(status.aiFailures,6); assert.equal(status.aiTimeouts,1);
});

test('Express adapter calls the real Python service and preserves identity/version/source', {
  skip: !process.env.PIPELINE_TEST_AI_URL,
}, async () => {
  const status = {}, message = input();
  message.sensors = { temperature: 24, humidity: 50, mq2_raw: 100, vibration_rms: 0,
    sw420: false, pir: false, flame: false, sos: true };
  const client = createAiServiceClient({ aiServiceUrl: process.env.PIPELINE_TEST_AI_URL },status);
  assert.equal(await client.healthcheck(),true);
  const risk = await client.predict(message);
  assert.equal(risk.classification,'CRITICAL'); assert.equal(risk.source,'simulation');
  assert.equal(risk.modelVersion,'python-rules-v1'); assert.equal(status.ai,true);
});
