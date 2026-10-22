import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, ROLES, ROLE_PERMISSIONS } from '../src/models/user.js';
import { signToken, decodeAndVerifyToken } from '../src/middleware/auth.js';

test('Password hashing and timing-safe verification', () => {
  const password = 'TestSecretPassword@123';
  const { salt, hash } = hashPassword(password);

  assert.ok(salt.length >= 32);
  assert.ok(hash.length >= 64);
  assert.equal(verifyPassword(password, salt, hash), true);
  assert.equal(verifyPassword('WrongPassword', salt, hash), false);
});

test('JWT-like token signing and tamper-evident verification', () => {
  const secret = 'super-secret-key-that-is-at-least-32-chars-long';
  const payload = { userId: 'usr_12345', role: 'student', name: 'John Doe' };

  const token = signToken(payload, secret);
  assert.ok(typeof token === 'string');
  assert.equal(token.split('.').length, 3);

  const decoded = decodeAndVerifyToken(token, secret);
  assert.ok(decoded);
  assert.equal(decoded.userId, 'usr_12345');
  assert.equal(decoded.role, 'student');
  assert.equal(decoded.name, 'John Doe');

  // Verify signature verification fails on tampered token
  const [header, body, sig] = token.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ ...payload, role: 'admin' })).toString('base64url');
  const tamperedToken = `${header}.${tamperedBody}.${sig}`;
  assert.equal(decodeAndVerifyToken(tamperedToken, secret), null);

  // Verify signature verification fails on different secret
  assert.equal(decodeAndVerifyToken(token, 'different-secret-key-32-characters'), null);
});

test('Role permissions matrix covers all supported roles', () => {
  assert.equal(ROLES.includes('student'), true);
  assert.equal(ROLES.includes('faculty_staff'), true);
  assert.equal(ROLES.includes('security_guard'), true);
  assert.equal(ROLES.includes('maintenance_staff'), true);
  assert.equal(ROLES.includes('facility_manager'), true);
  assert.equal(ROLES.includes('admin'), true);

  assert.equal(ROLE_PERMISSIONS.admin.includes('*'), true);
  assert.equal(ROLE_PERMISSIONS.student.includes('emergency:trigger'), true);
  assert.equal(ROLE_PERMISSIONS.student.includes('maintenance:create'), true);
  assert.equal(ROLE_PERMISSIONS.security_guard.includes('security:manage'), true);
  assert.equal(ROLE_PERMISSIONS.facility_manager.includes('maintenance:verify'), true);
});
