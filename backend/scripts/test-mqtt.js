import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';
import { settings } from '../src/config/settings.js';
import { connectDatabase, mongoose } from '../src/config/database.js';
import { SensorReading } from '../src/models/index.js';
import { createPayloadParser } from '../src/services/payload.js';
let client;
try {
  const config = settings();
  if (!config.mqttEnabled || !config.mqttTopic || /[+#]/.test(config.mqttTopic)) {
    throw new Error('Set a single actual publish topic and enable MQTT');
  }
  const file = process.argv[2];
  if (!file) throw new Error('Pass path to an actual firmware JSON payload file');
  const payload = JSON.parse(await readFile(file, 'utf8'));
  const parsed = createPayloadParser(config.contract)(payload);
  if (!parsed.eventId) throw new Error('Test requires a fresh event identifier to verify persistence');
  if (!await connectDatabase(config)) throw new Error('Atlas missing');
  if (await SensorReading.exists({ deviceId: parsed.deviceId, eventId: parsed.eventId })) {
    throw new Error('Use a fresh test event identifier');
  }
  client = await mqtt.connectAsync(config.mqttUrl, {
    username: config.mqttUsername, password: config.mqttPassword,
    clientId: `probe-${randomUUID().slice(0, 12)}`, reconnectPeriod: 0, connectTimeout: 10000,
  });
  await client.publishAsync(config.mqttTopic, JSON.stringify(payload), { qos: 1, retain: false });
  const deadline = Date.now() + 20000;
  let saved;
  while (Date.now() < deadline) {
    saved = await SensorReading.findOne({ deviceId: parsed.deviceId, eventId: parsed.eventId }).lean();
    if (saved) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!saved) throw new Error('Reading not persisted before deadline');
  const response = await fetch(`${process.env.TEST_API_URL || 'http://localhost:5000'}/api/iot/readings?deviceId=${encodeURIComponent(parsed.deviceId)}`, {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (!response.ok || !(await response.json()).items.some(item => item.eventId === parsed.eventId)) {
    throw new Error('Reading not returned by API');
  }
  console.log('PASS MQTT publish -> Atlas reading -> authenticated Express API');
  console.log('Test event retained as an explicit test reading; use a dedicated test device ID.');
} catch {
  console.error('FAIL MQTT pipeline test: verify contract, unique event ID, broker, running subscriber, Atlas and API configuration. Details omitted.');
  process.exitCode = 1;
} finally {
  if (client) await client.endAsync(true);
  await mongoose.disconnect();
}
