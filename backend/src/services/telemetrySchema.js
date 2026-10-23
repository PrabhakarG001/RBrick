// rbrick-v1 nested payload validation (schema_version 1.0).
//
// One schema shared by firmware, the Python simulator, the backend and the
// risk engine. Examples: IoT/README.md. Topic contract: mqtt/README.md.
//
//   telemetry    building/{building_id}/{zone_id}/{device_id}/telemetry    QoS 1, no retain
//   events       building/{building_id}/{zone_id}/{device_id}/events       QoS 1, NEVER retained
//   status       building/{building_id}/{zone_id}/{device_id}/status       QoS 1, retained heartbeat
//   availability building/{building_id}/{zone_id}/{device_id}/availability QoS 1, retained + Last Will
//   camera/status building/{building_id}/{zone_id}/{device_id}/camera/status

import { z } from 'zod';

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\\-]+$/);
const utc = z.iso.datetime({ offset: true }).refine(v => v.endsWith('Z'), 'timestamp must be UTC (Z suffix)');
const source = z.enum(['hardware', 'simulation']);
const SENSOR_NAMES = ['temperature', 'humidity', 'mq2_raw', 'vibration_rms', 'sw420', 'pir', 'flame', 'sos'];
const NUMERIC_SENSORS = ['temperature', 'humidity', 'mq2_raw', 'vibration_rms'];
const BOOLEAN_SENSORS = ['sw420', 'pir', 'flame', 'sos'];

const envelope = {
  schema_version: z.literal('1.0'),
  message_id: id,
  device_id: id,
  building_id: id,
  zone_id: id,
  timestamp: utc,
  source,
};

export const telemetrySchema = z.object({
  ...envelope,
  firmware_version: z.string().min(1).max(32),
  sensors: z.object({
    temperature: z.number().finite().nullable(),
    humidity: z.number().finite().nullable(),
    mq2_raw: z.number().finite().nullable(),
    vibration_rms: z.number().finite().nullable(),
    sw420: z.boolean().nullable(),
    pir: z.boolean().nullable(),
    flame: z.boolean().nullable(),
    sos: z.boolean().nullable(),
  }),
  // Per-sensor health: "ok" | "error" | "missing" | "degraded".
  health: z.record(id, z.enum(['ok', 'error', 'missing', 'degraded'])).default({}),
}).strict().superRefine((message, ctx) => {
  for (const field of SENSOR_NAMES) {
    if (message.sensors[field] === null && (!message.health[field] || message.health[field] === 'ok')) {
      ctx.addIssue({ code: 'custom', path: ['health', field],
        message: 'Null readings require an explicit unhealthy status for the exact sensor field' });
    }
  }
});

export const eventSchema = z.object({
  ...envelope,
  event: z.object({
    kind: z.enum(['sos', 'flame', 'gas', 'vibration', 'fault', 'other']),
    detail: z.string().max(500).default(''),
    referenced_message_id: id.optional(),
  }).strict(),
}).strict();

export const statusSchema = z.object({
  ...envelope,
  firmware_version: z.string().min(1).max(32),
  state: z.enum(['online', 'offline', 'degraded']),
}).strict();

export const cameraStatusSchema = z.object({
  schema_version: z.literal('1.0'),
  message_id: id,
  device_id: id,
  timestamp: utc,
  source,
  state: z.enum(['online', 'offline']),
  ip: z.string().max(64).optional(),
  uptime_s: z.number().finite().nonnegative().optional(),
}).strict();

// Plain-string availability payloads: "online" / "offline".
export const availabilitySchema = z.enum(['online', 'offline']);

const TOPIC_SEGMENT = /^[A-Za-z0-9_:.\\-]{1,128}$/;

/**
 * Parse a topic of the form
 * building/{building_id}/{zone_id}/{device_id}/{channel}
 * or building/{building_id}/{zone_id}/{device_id}/camera/{subchannel}.
 * Returns { buildingId, zoneId, deviceId, channel } or null.
 */
export function parseTopic(topic) {
  const parts = String(topic).split('/');
  if (parts[0] !== 'building') return null;
  const short = parts.length === 4 || (parts.length === 5 && parts[3] === 'camera');
  if (short) parts.splice(1, 0, null);
  const [prefix, buildingId, zoneId, deviceId, channel, subchannel] = parts;
  if (prefix !== 'building' || parts.length < 5 || parts.length > 6) return null;
  for (const segment of [buildingId, zoneId, deviceId]) {
    if (segment === null && short) continue;
    if (!TOPIC_SEGMENT.test(segment)) return null;
  }
  if (parts.length === 5) {
    if (!['telemetry', 'events', 'status', 'availability'].includes(channel)) return null;
    return { buildingId, zoneId, deviceId, channel };
  }
  if (parts.length === 6) {
    if (channel !== 'camera' || !['status', 'events'].includes(subchannel)) return null;
    return { buildingId, zoneId, deviceId, channel: `camera/${subchannel}` };
  }
  return null;
}

/**
 * Validate a message for one channel. Topic identity must match the payload
 * identity (device/building/zone) — mismatches are rejected, never trusted.
 * Returns the parsed payload or throws.
 */
export function parseChannelMessage(channel, topic, payload, now = new Date()) {
  const parsedTopic = parseTopic(topic);
  if (!parsedTopic) throw new Error('Malformed topic');
  if (parsedTopic.channel !== channel) throw new Error('Channel/topic mismatch');
  let data;
  if (channel === 'availability') {
    const state = availabilitySchema.parse(payload);
    return { ...parsedTopic, device_id: parsedTopic.deviceId, building_id: parsedTopic.buildingId, zone_id: parsedTopic.zoneId,
      channel, state, message_id: null, timestamp: now.toISOString() };
  }
  const schema = channel === 'telemetry' ? telemetrySchema
    : channel === 'events' ? eventSchema
    : channel === 'status' ? statusSchema
    : cameraStatusSchema;
  data = schema.parse(typeof payload === 'string' ? JSON.parse(payload) : payload);
  if (data.device_id !== parsedTopic.deviceId) throw new Error('Topic/payload device_id mismatch');
  if (channel !== 'camera/status') {
    if (parsedTopic.buildingId !== null && data.building_id !== parsedTopic.buildingId) throw new Error('Topic/payload building_id mismatch');
    if (data.zone_id !== parsedTopic.zoneId) throw new Error('Topic/payload zone_id mismatch');
  }
  const observed = new Date(data.timestamp);
  // Reject timestamps too far in either direction (clock skew guard).
  if (observed.getTime() > now.getTime() + 300000) throw new Error('Timestamp too far in the future');
  return { ...parsedTopic, channel, ...data, observedAt: observed };
}

export const SENSOR_NAMES_LIST = Object.freeze(SENSOR_NAMES);
export const NUMERIC_SENSORS_LIST = Object.freeze(NUMERIC_SENSORS);
export const BOOLEAN_SENSORS_LIST = Object.freeze(BOOLEAN_SENSORS);

export const DEFAULT_V1_TOPICS = Object.freeze([
  'building/+/+/telemetry',
  'building/+/+/events',
  'building/+/+/status',
  'building/+/+/availability',
  'building/+/+/camera/status',
  'building/+/+/+/telemetry',
  'building/+/+/+/events',
  'building/+/+/+/status',
  'building/+/+/+/availability',
  'building/+/+/+/camera/status',
]);
