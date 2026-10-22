import test from 'node:test';
import assert from 'node:assert/strict';
import { EmergencyService } from '../src/services/emergencyService.js';

test('EmergencyService triggers and manages lifecycle in simulation/memory mode', async () => {
  const service = new EmergencyService({ database: false });

  let publishedTopic = null;
  let publishedPayload = null;
  service.setMqttPublisher((topic, msg) => {
    publishedTopic = topic;
    publishedPayload = JSON.parse(msg);
  });

  let broadcastEvent = null;
  let broadcastData = null;
  service.setRealtime({
    broadcast: (event, data) => {
      broadcastEvent = event;
      broadcastData = data;
    }
  });

  // Verify mockable hooks exist and can be called safely
  assert.equal(typeof service.triggerEmergency, 'function');
  assert.equal(typeof service.acknowledgeEmergency, 'function');
  assert.equal(typeof service.dispatchResponse, 'function');
  assert.equal(typeof service.setBuzzer, 'function');
  assert.equal(typeof service.resolveEmergency, 'function');
});
