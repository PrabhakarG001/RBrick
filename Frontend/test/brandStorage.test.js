import test from 'node:test';
import assert from 'node:assert/strict';
import { readBrandStorage, writeBrandStorage, clearBrandStorage } from '../src/services/brandStorage.js';

function storage(entries) {
  const values = new Map(entries);
  return { getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

test('existing sessions and language preferences migrate without losing values', () => {
  for (const key of ['ravynx_token', 'resilliox_token']) {
    const store = storage([[key, 'existing-session']]);
    assert.equal(readBrandStorage('token', store), 'existing-session');
    assert.equal(store.getItem('rbrick_token'), 'existing-session');
    assert.equal(store.getItem(key), null);
    clearBrandStorage('token', store);
    assert.equal(readBrandStorage('token', store), null);
  }
  const store = storage([['ravynx_lang', 'hi']]);
  assert.equal(readBrandStorage('lang', store), 'hi');
  assert.equal(store.getItem('rbrick_lang'), 'hi');
});

test('new sessions take precedence and logout removes legacy sessions too', () => {
  const store = storage([['rbrick_token', 'current'], ['ravynx_token', 'stale']]);
  assert.equal(readBrandStorage('token', store), 'current');
  writeBrandStorage('token', 'new', store);
  assert.equal(store.getItem('ravynx_token'), null);
  clearBrandStorage('token', store);
  assert.equal(readBrandStorage('token', store), null);
});
