import { randomUUID } from 'node:crypto';
import { settings } from '../src/config/settings.js';
import { connectDatabase, mongoose } from '../src/config/database.js';
import { ensureIndexes } from '../src/models/index.js';
import { databaseFailure } from '../src/config/databaseErrors.js';

const id = `connection-test-${randomUUID()}`;
let collection;
try {
  const config = settings();
  if (!await connectDatabase(config)) throw Object.assign(new Error('Configure Atlas URI'), { code: 'ATLAS_NOT_CONFIGURED' });
  await ensureIndexes();
  console.log('PASS Atlas connected and indexes ready');
  collection = mongoose.connection.collection('connection_tests');
  await collection.insertOne({ _id: id, purpose: 'connectivity-check', createdAt: new Date() });
  if (!(await collection.findOne({ _id: id }))) throw new Error('Read-back failed');
  console.log('PASS harmless test document inserted and retrieved');
} catch (error) {
  const failure = databaseFailure(error);
  console.error(`FAIL Atlas test [${failure.code}]: ${failure.message}`);
  process.exitCode = 1;
} finally {
  if (collection) {
    try { await collection.deleteOne({ _id: id }); console.log('Test document cleaned up'); }
    catch { console.error('Test document cleanup failed; inspect connection_tests manually'); process.exitCode = 1; }
  }
  await mongoose.disconnect();
}
