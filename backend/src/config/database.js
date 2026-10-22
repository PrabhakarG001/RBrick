import mongoose from 'mongoose';

mongoose.set('bufferCommands', false);
mongoose.set('sanitizeFilter', true);
export { mongoose };

export async function connectDatabase(config) {
  if (!config.uri || config.uri.includes('<')) return false;
  // Atlas SRV connections require TLS. Do not log URI/error text containing credentials.
  if (!config.uri.startsWith('mongodb+srv://') && !config.uri.startsWith('mongodb://')) {
    throw new Error('Invalid database URI scheme');
  }
  await mongoose.connect(config.uri, {
    dbName: config.dbName,
    tls: config.databaseTls ?? true,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    maxPoolSize: 10,
    autoIndex: false,
  });
  return true;
}
