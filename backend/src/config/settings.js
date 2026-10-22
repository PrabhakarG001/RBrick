import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: ['../../.env', '../../../.env'].map(path => fileURLToPath(new URL(path, import.meta.url))), quiet: true });
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
  .refine(value => !['__proto__', 'constructor', 'prototype'].includes(value));
const rulesSchema = z.array(z.object({
  field: identifier,
  operator: z.enum(['gt', 'gte', 'lt', 'lte', 'eq']),
  value: z.union([z.number().finite(), z.boolean()]),
  kind: z.enum(['safety', 'sos', 'fault']),
  message: z.string().min(1).max(200),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
}).strict()).max(30);

export function parseContract(env = process.env) {
  const rawFields = JSON.parse(env.SENSOR_FIELDS_JSON || '{}');
  for (const key of Object.keys(rawFields)) identifier.parse(key);
  const fields = z.record(identifier, z.enum(['number', 'boolean'])).parse(rawFields);
  if (Object.keys(fields).length > 32) throw new Error('Too many sensor fields');
  const deviceField = identifier.parse(env.DEVICE_ID_FIELD || 'deviceId');
  const eventField = identifier.parse(env.EVENT_ID_FIELD || 'eventId');
  const timeField = identifier.parse(env.TIMESTAMP_FIELD || 'timestamp');
  if (new Set([deviceField, eventField, timeField, ...Object.keys(fields)]).size !== 3 + Object.keys(fields).length) {
    throw new Error('Payload field names must be distinct');
  }
  const rules = rulesSchema.parse(JSON.parse(env.ALERT_RULES_JSON || '[]'));
  for (const rule of rules) {
    if (fields[rule.field] !== typeof rule.value || (typeof rule.value === 'boolean' && rule.operator !== 'eq')) {
      throw new Error('Rule must match a configured sensor type');
    }
  }
  const display = z.object({ temperature: identifier.optional(), humidity: identifier.optional(),
    gas: identifier.optional(), smoke: identifier.optional(), waterLeak: identifier.optional(),
    doorOpen: identifier.optional(), sos: identifier.optional() }).strict().parse(JSON.parse(env.SENSOR_DISPLAY_JSON || '{}'));
  for (const field of Object.values(display)) if (!Object.hasOwn(fields, field)) throw new Error('Display field must exist in sensor contract');
  for (const [sensor, field] of Object.entries(display)) {
    const expected = ['waterLeak', 'doorOpen', 'sos'].includes(sensor) ? 'boolean' : 'number';
    if (fields[field] !== expected) throw new Error('Display mapping must match the sensor value type');
  }
  return { fields, deviceField, eventField, timeField, rules, display };
}

export function settings(env = process.env) {
  const databaseTls = z.enum(['true','false']).parse(env.MONGODB_TLS || 'true') === 'true';
  if ((env.MONGODB_URI || '').startsWith('mongodb+srv://') && !databaseTls) throw new Error('SRV/Atlas connections require TLS');
  const contract = parseContract(env);
  // Default matches documented compose/env contract: nested resilliox-v1.
  // Legacy flat contract requires explicit MQTT_PAYLOAD_FORMAT=flat.
  const payloadFormat = z.enum(['flat', 'resilliox-v1']).parse(env.MQTT_PAYLOAD_FORMAT || 'resilliox-v1');
  const mqttEnabled = z.enum(['true', 'false']).parse(env.MQTT_ENABLED || 'false') === 'true';
  if (mqttEnabled) {
    if (payloadFormat === 'flat') {
      if (!Object.keys(contract.fields).length || !env.MQTT_TOPIC || !env.MQTT_URL || !env.MQTT_CLIENT_ID) {
        throw new Error('MQTT requires topic, URL, stable client ID and sensor field contract');
      }
    } else if (!env.MQTT_URL || !env.MQTT_CLIENT_ID) {
      throw new Error('MQTT v1 requires URL and stable client ID');
    }
    const url = new URL(env.MQTT_URL);
    if (!['mqtt:', 'mqtts:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Use mqtt(s) URL and separate credential variables');
    }
    if (Boolean(env.MQTT_USERNAME) !== Boolean(env.MQTT_PASSWORD)) throw new Error('Incomplete MQTT credentials');
  }
  // v1 topic list: empty = built-in defaults (building/+/+/+/... set).
  const mqttTopics = payloadFormat === 'resilliox-v1'
    ? (env.MQTT_TOPIC || '').split(',').map(s => s.trim()).filter(Boolean)
    : undefined;
  const riskThresholds = JSON.parse(env.RISK_THRESHOLDS_JSON || '{}');
  const aiServiceUrl = z.string().url().parse(env.AI_SERVICE_URL || 'http://127.0.0.1:8000');
  const aiUrl = new URL(aiServiceUrl);
  if (!['http:', 'https:'].includes(aiUrl.protocol) || aiUrl.username || aiUrl.password || aiUrl.search || aiUrl.hash || aiUrl.pathname !== '/') {
    throw new Error('AI_SERVICE_URL must be an http(s) origin with separate credentials');
  }
  // ESP32-CAM snapshot endpoints: { "<deviceId>": "http://<lan-ip>:81/snapshot" }.
  // URLs come only from server configuration, never from request input, so
  // the snapshot proxy cannot be pointed at an arbitrary target by a client.
  const cameraRaw = JSON.parse(env.CAMERA_SNAPSHOT_URLS_JSON || '{}');
  const cameraSnapshotUrls = z.record(
    z.string().regex(/^[A-Za-z0-9_:.\\-]{1,128}$/),
    z.string().url().max(2048),
  ).parse(cameraRaw);
  for (const url of Object.values(cameraSnapshotUrls)) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error('Camera snapshot URLs must use http(s)');
    }
  }
  const cameraSources = z.record(z.string(),z.enum(['hardware','simulation'])).parse(JSON.parse(env.CAMERA_SOURCES_JSON || '{}'));
  const cameraTokens = z.record(z.string(),z.string().min(16).max(512)).parse(JSON.parse(env.CAMERA_BEARER_TOKENS_JSON || '{}'));
  const securityDeviceTokens=z.record(z.string().regex(/^[A-Za-z0-9_:.-]{1,128}$/),z.string().min(32).max(512)).parse(JSON.parse(env.SECURITY_DEVICE_TOKENS_JSON||'{}'));
  return {
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT || 5000),
    uri: env.MONGODB_URI || '',
    databaseTls,
    dbName: z.string().regex(/^[A-Za-z0-9_-]{1,63}$/).parse(env.DB_NAME || 'building_safety'),
    apiToken: env.IOT_API_TOKEN || '',
    mqttEnabled,
    payloadFormat,
    mqttUrl: env.MQTT_URL,
    mqttTopic: env.MQTT_TOPIC,
    mqttTopics,
    mqttUsername: env.MQTT_USERNAME,
    mqttPassword: env.MQTT_PASSWORD,
    mqttClientId: env.MQTT_CLIENT_ID,
    contract,
    riskThresholds,
    aiServiceUrl,
    aiServiceToken: env.AI_SERVICE_TOKEN || '',
    aiTimeoutMs: z.coerce.number().int().min(100).max(30000).parse(env.AI_TIMEOUT_MS || 3000),
    socketCorsOrigin: env.SOCKET_CORS_ORIGIN || '',
    cameraSnapshotUrls,
    cameraSources, cameraTokens,
    securityDeviceTokens,
    securitySimulationEnabled:z.enum(['true','false']).parse(env.SECURITY_SIMULATION_ENABLED||(env.NODE_ENV==='production'?'false':'true'))==='true',
    securityDemoResetEnabled:z.enum(['true','false']).parse(env.SECURITY_DEMO_RESET_ENABLED||'false')==='true',
    nodeEnv:env.NODE_ENV||'development',
    offlineAfterSeconds: z.coerce.number().int().min(10).max(86400).parse(env.DEVICE_OFFLINE_AFTER_SECONDS || 120),
  };
}
