import test from 'node:test';
import assert from 'node:assert/strict';
import { settings } from '../src/config/settings.js';

test('legacy and RBrick MQTT format settings select the same wire contract', () => {
  assert.deepEqual(settings({ MQTT_PAYLOAD_FORMAT: 'resilliox-v1' }),
    settings({ MQTT_PAYLOAD_FORMAT: 'rbrick-v1' }));
  assert.equal(settings({}).payloadFormat, 'rbrick-v1');
  assert.equal(settings({ MQTT_PAYLOAD_FORMAT: 'flat' }).payloadFormat, 'flat');
  assert.throws(() => settings({ MQTT_PAYLOAD_FORMAT: 'unknown' }));
});
