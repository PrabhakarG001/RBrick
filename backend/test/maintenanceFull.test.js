import test from 'node:test';
import assert from 'node:assert/strict';
import { 
  TICKET_CATEGORIES, 
  TICKET_PRIORITIES, 
  TICKET_STATUSES 
} from '../src/models/maintenanceTicket.js';

test('Maintenance ticket categories, priorities and lifecycle statuses', () => {
  assert.equal(TICKET_PRIORITIES.includes('low'), true);
  assert.equal(TICKET_PRIORITIES.includes('medium') || TICKET_PRIORITIES.includes('normal'), true);
  assert.equal(TICKET_PRIORITIES.includes('high'), true);
  assert.equal(TICKET_PRIORITIES.includes('critical'), true);
  assert.equal(TICKET_CATEGORIES.includes('electrical'), true);
  assert.equal(TICKET_CATEGORIES.includes('plumbing'), true);
  assert.equal(TICKET_CATEGORIES.includes('fire_safety'), true);
  assert.equal(TICKET_CATEGORIES.includes('sensor_iot'), true);

  assert.equal(TICKET_STATUSES.includes('reported'), true);
  assert.equal(TICKET_STATUSES.includes('assigned'), true);
  assert.equal(TICKET_STATUSES.includes('in_progress'), true);
  assert.equal(TICKET_STATUSES.includes('repair_completed'), true);
  assert.equal(TICKET_STATUSES.includes('verified_closed'), true);
  assert.equal(TICKET_STATUSES.includes('reopened'), true);
});
