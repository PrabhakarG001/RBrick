// Read existing sessions/preferences once, then use the RBrick storage namespace.
const legacyKeys = {
  token: ['ravynx_token', 'resilliox_token'],
  lang: ['ravynx_lang'],
};

export function readBrandStorage(name, storage = localStorage) {
  const key = `rbrick_${name}`;
  const current = storage.getItem(key);
  if (current !== null) return current;
  for (const legacy of legacyKeys[name] || []) {
    const value = storage.getItem(legacy);
    if (value !== null) {
      writeBrandStorage(name, value, storage);
      return value;
    }
  }
  return null;
}

export function writeBrandStorage(name, value, storage = localStorage) {
  storage.setItem(`rbrick_${name}`, value);
  for (const key of legacyKeys[name] || []) storage.removeItem(key);
}

export function clearBrandStorage(name, storage = localStorage) {
  storage.removeItem(`rbrick_${name}`);
  for (const key of legacyKeys[name] || []) storage.removeItem(key);
}
