// rbrick-v1 ingest pipeline:
//   validated MQTT message -> Python HTTP -> MongoDB transaction -> Socket.IO
//
// Deduplication: SensorReading has a partial unique index on (deviceId, eventId);
// v1 uses message_id as event ID, so QoS 1 redelivery is idempotent.

import { mongoose } from '../config/database.js';
import { SensorReading, Alert, Device, RiskAnalysis } from '../models/index.js';
import { AiServiceError, createAiServiceClient } from './aiServiceClient.js';

// Map risk engine incident kinds to existing Alert kind/severity enums.
function alertAttributes(incident) {
  const kind = incident.kind === 'sos' ? 'sos'
    : incident.kind === 'fault' ? 'fault' : 'safety';
  const severity = incident.classification === 'CRITICAL' ? 'critical'
    : incident.classification === 'HIGH' ? 'critical'
    : incident.classification === 'MODERATE' ? 'warning' : 'info';
  return { kind, severity };
}

/**
 * Persist one validated v1 telemetry message + its risk analysis atomically.
 *
 * @param {object} message  output of telemetrySchema.parseChannelMessage('telemetry', ...)
 * @param {object} options  { predict, staleAfterSeconds, aiConfig? }
 * @returns {Promise<{duplicate: boolean, readingId?: object, risk?: object, alerts: object[]}>}
 */
export async function storeTelemetryV1(message, options = {}) {
  const identity = { deviceId: message.device_id, eventId: message.message_id };
  const previous = await SensorReading.findOne(identity).lean();
  if (previous && previous.analysisStatus !== 'unavailable') return { duplicate: true, alerts: [] };
  // On redelivery of unavailable analysis, always analyze the original saved data.
  if (previous) {
    message = { ...message, sensors: previous.sensors, health: previous.health || {},
      timestamp: previous.observedAt.toISOString(), observedAt: previous.observedAt,
      building_id: previous.buildingId, zone_id: previous.zoneId, source: previous.source,
      firmware_version: previous.firmwareVersion };
  }
  const now = new Date();
  let risk = null, analysisError;
  const predict = options.predict || createAiServiceClient(options.aiConfig || {}).predict;
  try { risk = await predict(message, options); }
  catch (error) {
    if (!(error instanceof AiServiceError)) throw error;
    analysisError = error.code;
  }
  try {
    return await mongoose.connection.transaction(async session => {
      let saved = await SensorReading.findOne(identity).session(session);
      if (saved && saved.analysisStatus !== 'unavailable') return { duplicate: true, alerts: [] };
      const newReading = !saved;
      if (!saved) {
        [saved] = await SensorReading.create([{
          ...identity, observedAt: message.observedAt, receivedAt: now,
          sensors: message.sensors, health: message.health,
          topic: `building/${message.building_id}/${message.zone_id}/${message.device_id}/telemetry`,
          buildingId: message.building_id, zoneId: message.zone_id, source: message.source,
          firmwareVersion: message.firmware_version,
        }], { session });
      }
      saved.analysisStatus = risk ? 'complete' : 'unavailable';
      saved.analysisError = analysisError;
      await saved.save({ session });
      let analysis = null, alerts = [];
      if (risk) {
        // Deduplication is persistence bookkeeping, not risk inference. Consult
        // committed alerts so failed transactions/restarts cannot suppress alerts.
        const incidents = [];
        for (const incident of risk.incidents) {
          const recent = await Alert.exists({ deviceId: message.device_id,
            incidentId: incident.incidentId, source: message.source, resolvedAt: null,
            createdAt: mongoose.trusted({ $gte: new Date(now.getTime() - risk.incidentCooldownSeconds * 1000) }),
          }).session(session);
          incidents.push({ ...incident, recurrent: Boolean(recent) });
        }
        [analysis] = await RiskAnalysis.create([{
          deviceId: message.device_id, messageId: message.message_id, readingId: saved._id,
          observedAt: message.observedAt, analyzedAt: risk.analyzedAt,
          score: risk.score, classification: risk.classification, factors: risk.factors,
          incidents, dataQuality: risk.dataQuality, stale: risk.stale,
          zoneId: message.zone_id, source: message.source,
          modelVersion: risk.modelVersion, engineVersion: risk.engineVersion, features: risk.features,
        }], { session });
        const alertDocs = incidents.filter(incident => !incident.recurrent).map(incident => ({
          deviceId: message.device_id, readingId: saved._id, ...alertAttributes(incident),
          field: incident.field, message: incident.message, observedAt: message.observedAt,
          zoneId: message.zone_id, incidentId: incident.incidentId, source: message.source,
          riskScore: risk.score, riskClassification: risk.classification, recurrent: false,
        }));
        if (alertDocs.length) alerts = await Alert.insertMany(alertDocs, { session });
      }
      await Device.updateOne({ deviceId: message.device_id }, {
        $max: { lastSeenAt: now },
        $set: { online: true, zoneId: message.zone_id, buildingId: message.building_id,
          firmwareVersion: message.firmware_version },
      }, { upsert: true, session });
      return { duplicate: false, readingId: saved._id, analysis, alerts, risk,
        message, newReading, analysisStatus: saved.analysisStatus, analysisError };
    });
  } catch (error) {
    if (error.code === 11000) {
      const existing = await SensorReading.findOne(identity).lean();
      if (existing) return { duplicate: true, readingId: existing._id, alerts: [] };
    }
    throw error;
  }
}
/**
 * Persist an emergency event message (events channel, never retained).
 * Returns the created Alert, or null when this message_id was already processed.
 */
export async function storeEventV1(message) {
  const now = new Date();
  const { severity, kind } = message.event.kind === 'sos'
    ? { severity: 'critical', kind: 'sos' }
    : message.event.kind === 'flame'
      ? { severity: 'critical', kind: 'safety' }
      : message.event.kind === 'fault'
        ? { severity: 'warning', kind: 'fault' }
        : { severity: 'warning', kind: 'safety' };
  try {
    return await mongoose.connection.transaction(async session => {
      // Events anchor to a synthetic reading so Alert.readingId stays valid.
      const [anchor] = await SensorReading.create([{
        deviceId: message.device_id,
        eventId: message.message_id,
        observedAt: message.observedAt,
        receivedAt: now,
        sensors: {},
        topic: `building/${message.building_id}/${message.zone_id}/${message.device_id}/events`,
        buildingId: message.building_id,
        zoneId: message.zone_id,
        source: message.source,
      }], { session });
      const [alert] = await Alert.create([{
        deviceId: message.device_id,
        readingId: anchor._id,
        kind,
        field: message.event.kind,
        message: message.event.detail || `Device reported ${message.event.kind} event`,
        observedAt: message.observedAt,
        zoneId: message.zone_id,
        incidentId: `${message.device_id}:event:${message.event.kind}:${message.message_id}`,
        source: message.source,
        severity,
        recurrent: false,
      }], { session });
      await Device.updateOne({ deviceId: message.device_id },
        { $max: { lastSeenAt: now } }, { upsert: true, session });
      return alert;
    });
  } catch (error) {
    if (error.code === 11000) return null; // duplicate QoS 1 delivery
    throw error;
  }
}

/** Apply a status heartbeat or availability message to the device record. */
export async function recordDeviceState({ deviceId, buildingId, zoneId, state, source, firmwareVersion, kind }) {
  if (!deviceId) throw new Error('Device identity required for state updates');
  const now = new Date();
  const update = kind === 'availability'
    ? { lastAvailability: state, lastAvailabilityAt: now, online: state === 'online' }
    : kind === 'camera'
      ? { cameraOnline: state === 'online', cameraStatusAt: now, ...(source ? { cameraSource: source } : {}) }
      : { online: state !== 'offline', lastStatusAt: now,
          ...(firmwareVersion ? { firmwareVersion } : {}),
          ...(state === 'degraded' ? {} : {}) };
  return Device.updateOne({ deviceId }, {
    $max: { lastSeenAt: now },
    $set: { ...update, ...(zoneId != null ? { zoneId } : {}),
      ...(buildingId != null ? { buildingId } : {}), ...(source ? {} : {}) },
  }, { upsert: true });
}
