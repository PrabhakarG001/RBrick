import test from 'node:test';
import assert from 'node:assert/strict';
import { latestReadings, currentRisk, freshReading, deviceState } from '../src/pages/Safety/safetyData.js';
test('new live devices appear, stale readings cannot override newer readings, unavailable inference cannot reuse an old score', () => {
  const now = new Date().toISOString();
  const stored = {deviceId:'old',eventId:'one',observedAt:now,receivedAt:now,sensors:{temperature:24}};
  const newest = {deviceId:'new',messageId:'two',observedAt:now,receivedAt:now,sensors:{temperature:25}};
  assert.equal(latestReadings([stored],{new:newest}).length,2);
  assert.equal(currentRisk(newest,{messageId:'one'},null),null);
  assert.equal(currentRisk({...newest,analysisStatus:'unavailable'},{messageId:'two'},null),null);
  assert.equal(currentRisk(newest,{messageId:'two',score:5,analyzedAt:now},null).score,5);
  assert(freshReading(stored));
  assert(!freshReading({...stored,observedAt:'2000-01-01T00:00:00Z'}));
  assert.equal(deviceState({lastSeenAt:now,online:false},{mqtt:'subscribed'}),'Offline');
});
