import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { settings } from '../src/config/settings.js';
import { signToken, decodeAndVerifyToken } from '../src/middleware/auth.js';
import { hashPassword, verifyPassword, ROLES, ROLE_PERMISSIONS } from '../src/models/user.js';

test('Module 6: Cryptographic password hashing and timing-safe verification', () => {
  const password = 'SuperSecretPassword@2026';
  const { salt, hash } = hashPassword(password);

  assert.ok(salt.length >= 32);
  assert.ok(hash.length >= 64);

  // Correct password passes
  assert.equal(verifyPassword(password, salt, hash), true);

  // Incorrect password fails
  assert.equal(verifyPassword('WrongPassword@123', salt, hash), false);

  // Altered hash fails
  assert.equal(verifyPassword(password, salt, hash.slice(0, -2) + 'aa'), false);
});

test('Module 6: Token signing, tamper resistance and expiry decoding', () => {
  const secret = 'test-secret-key-that-is-at-least-32-chars-long';
  const payload = { userId: 'usr_test123', role: 'facility_manager', name: 'Alice Manager' };
  const token = signToken(payload, secret);

  assert.ok(token.includes('.'));
  assert.equal(token.split('.').length, 3);

  // Legitimate token decodes correctly
  const decoded = decodeAndVerifyToken(token, secret);
  assert.equal(decoded.userId, 'usr_test123');
  assert.equal(decoded.role, 'facility_manager');
  assert.equal(decoded.name, 'Alice Manager');

  // Tampered payload fails verification
  const [header, body, sig] = token.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
  const tamperedToken = `${header}.${tamperedBody}.${sig}`;
  assert.equal(decodeAndVerifyToken(tamperedToken, secret), null);

  // Tampered signature fails
  assert.equal(decodeAndVerifyToken(`${token}extra`, secret), null);
});

test('Module 6: Central Dashboard endpoints enforce authentication and return multi-module status', async (t) => {
  const config = settings({ IOT_API_TOKEN: 'dashboard-test-token-'.repeat(2) });
  const server = createApp(config, { database: true, mqtt: false }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));

  const base = `http://127.0.0.1:${server.address().port}/api/dashboard`;

  // 1. Unauthenticated requests fail closed with 401
  const unauthSummary = await fetch(`${base}/summary`);
  assert.equal(unauthSummary.status, 401);

  const unauthActivity = await fetch(`${base}/activity`);
  assert.equal(unauthActivity.status, 401);

  const unauthAccess = await fetch(`${base}/module-access`);
  assert.equal(unauthAccess.status, 401);

  // 2. Authenticated operator request succeeds
  const authSummary = await fetch(`${base}/summary`, {
    headers: { Authorization: `Bearer ${config.apiToken}` }
  });
  assert.equal(authSummary.status, 200);
  const summaryData = await authSummary.json();
  assert.equal(summaryData.success, true);
  assert.ok(summaryData.building);
  assert.ok(summaryData.safety);
  assert.ok(summaryData.emergency);
  assert.ok(summaryData.maintenance);
  assert.ok(summaryData.analytics);
  assert.equal(summaryData.currentUser.role, 'admin');

  // 3. Authenticated activity feed returns normalized items
  const authActivity = await fetch(`${base}/activity`, {
    headers: { Authorization: `Bearer ${config.apiToken}` }
  });
  assert.equal(authActivity.status, 200);
  const activityData = await authActivity.json();
  assert.equal(activityData.success, true);
  assert.ok(Array.isArray(activityData.items));

  // 4. Role capability map reflects admin powers
  const authAccess = await fetch(`${base}/module-access`, {
    headers: { Authorization: `Bearer ${config.apiToken}` }
  });
  assert.equal(authAccess.status, 200);
  const accessData = await authAccess.json();
  assert.equal(accessData.role, 'admin');
  assert.equal(accessData.capabilities.canManageUsers, true);
  assert.equal(accessData.capabilities.canAssignMaintenance, true);
  assert.equal(accessData.capabilities.canResolveEmergency, true);
});

test('Module 6: Role permissions matrix covers all 6 canonical roles', () => {
  assert.deepEqual(ROLES, [
    'student',
    'faculty_staff',
    'security_guard',
    'maintenance_staff',
    'facility_manager',
    'admin'
  ]);

  for (const role of ROLES) {
    assert.ok(ROLE_PERMISSIONS[role], `Role ${role} must have defined permissions`);
    assert.ok(Array.isArray(ROLE_PERMISSIONS[role]));
  }

  // Student cannot manage emergencies or maintenance
  assert.equal(ROLE_PERMISSIONS.student.includes('emergency:resolve'), false);
  assert.equal(ROLE_PERMISSIONS.student.includes('maintenance:assign'), false);

  // Facility manager can assign and verify maintenance
  assert.equal(ROLE_PERMISSIONS.facility_manager.includes('maintenance:assign'), true);
  assert.equal(ROLE_PERMISSIONS.facility_manager.includes('maintenance:verify'), true);

  // Admin has wildcard access
  assert.equal(ROLE_PERMISSIONS.admin.includes('*'), true);
});

