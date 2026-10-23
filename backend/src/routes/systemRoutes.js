// Phase 6 REST endpoints. Reuses the existing Mongoose models and the same
// bearer-token operator authentication as /api/iot/*. All list responses are
// { success: true, items: [...] } or { success: true, ... } for singletons.
//
//   GET /api/health                       liveness+readiness snapshot (no auth)
//   GET /api/devices                      registered/seen devices
//   GET /api/devices/:deviceId/latest     latest reading + risk for one device
//   GET /api/readings/latest              newest reading per device
//   GET /api/readings/history             paginated readings
//   GET /api/alerts                       incident list with filters
//   GET /api/alerts/active                unresolved incidents
//   GET /api/system/status                dependency + pipeline status

import { Router } from 'express';
import { z } from 'zod';
import { SensorReading, Alert, Device, RiskAnalysis } from '../models/index.js';
import { requireToken } from '../middleware/auth.js';
import { mongoose } from '../config/database.js';

// mongoose.sanitizeFilter is enabled globally; range filters built here from
// validated primitives must be explicitly trusted (same convention as
// iotRoutes.safe()).
function trustedTimeFilter(q, timeField) {
  if (!q.from && !q.before) return undefined;
  return mongoose.trusted({
    ...(q.from ? { $gte: new Date(q.from) } : {}),
    ...(q.before ? { $lt: new Date(q.before) } : {}),
  });
}

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\\-]+$/);
const date = z.iso.datetime({ offset: true });
const listQuery = z.object({
  deviceId: id.optional(),
  zoneId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  from: date.optional(),
  before: date.optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  classification: z.enum(['NORMAL', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']).optional(),
  source: z.enum(['hardware', 'simulation']).optional(),
}).strict();

function buildFilter(q, timeField) {
  const filter = {};
  if (q.deviceId) filter.deviceId = q.deviceId;
  if (q.zoneId) filter.zoneId = q.zoneId;
  if (q.source) filter.source = q.source;
  const time = trustedTimeFilter(q, timeField);
  if (time) filter[timeField] = time;
  return filter;
}

export function systemRoutes(config, status) {
  const router = Router();

  // Public liveness/readiness snapshot (mirrors /api/health/*, no secrets).
  router.get('/health', (req, res) => {
    const aiRequired = config.mqttEnabled && config.payloadFormat === 'rbrick-v1';
    const ready = status.database && (!config.mqttEnabled || status.mqtt) && (!aiRequired || status.ai === true) && config.apiToken.length >= 32;
    res.status(ready ? 200 : 503).json({
      success: true, status: ready ? 'ready' : 'degraded',
      database: status.database ? 'connected' : 'unavailable',
      mqtt: config.mqttEnabled ? (status.mqtt ? 'subscribed' : 'unavailable') : 'disabled',
      ai: aiRequired ? (status.ai === true ? 'available' : status.ai === false ? 'unavailable' : 'unknown') : 'not_required',
      socketClients: status.socketClients ?? 0,
    });
  });

  // Per-route guard (not router.use) so unmatched /api/* paths still 404.
  // Every data route requires the operator token and a live database.
  const guard = (req, res, next) => {
    requireToken(config)(req, res, () => {
      if (!status.database) {
        return res.status(503).json({ success: false, message: 'Atlas database unavailable' });
      }
      next();
    });
  };

  router.get('/devices', guard, async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = buildFilter(q, 'lastSeenAt');
    const [items, total] = await Promise.all([
      Device.find(filter).sort({ lastSeenAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Device.countDocuments(filter),
    ]);
    // Explicit freshness computation; "unknown" when MQTT is not subscribed.
    const cutoff = Date.now() - config.offlineAfterSeconds * 1000;
    for (const item of items) {
      item.online = item.online !== false && (item.lastSeenAt ? new Date(item.lastSeenAt).getTime() >= cutoff : false);
    }
    res.json({ success: true, items, total, page: q.page, limit: q.limit,
      connectivityKnown: Boolean(config.mqttEnabled && status.mqtt) });
  });

  router.get('/devices/:deviceId/latest', guard, async (req, res) => {
    const deviceId = id.parse(req.params.deviceId);
    const [device, reading] = await Promise.all([
      Device.findOne({ deviceId }).lean(),
      SensorReading.findOne({ deviceId }).sort({ receivedAt: -1 }).lean(),
    ]);
    const risk = reading ? await RiskAnalysis.findOne({ readingId: reading._id }).lean() : null;
    if (!device && !reading) return res.status(404).json({ success: false, message: 'Device not found' });
    res.json({ success: true, device, reading, risk });
  });

  router.get('/readings/latest', guard, async (req, res) => {
    const q = listQuery.parse(req.query);
    const match = buildFilter(q, 'receivedAt');
    const items = await SensorReading.aggregate([
      { $match: match },
      { $sort: { receivedAt: -1 } },
      { $group: { _id: '$deviceId', reading: { $first: '$$ROOT' } } },
      { $sort: { 'reading.receivedAt': -1 } },
      { $limit: q.limit },
    ]);
    res.json({ success: true, items: items.map(i => i.reading) });
  });

  router.get('/readings/history', guard, async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = buildFilter(q, 'receivedAt');
    const [items, total] = await Promise.all([
      SensorReading.find(filter).sort({ receivedAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      SensorReading.countDocuments(filter),
    ]);
    res.json({ success: true, items, total, page: q.page, limit: q.limit });
  });

  router.get('/alerts', guard, async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = buildFilter(q, 'createdAt');
    if (q.severity) filter.severity = q.severity;
    const [items, total] = await Promise.all([
      Alert.find(filter).sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit).limit(q.limit).lean(),
      Alert.countDocuments(filter),
    ]);
    res.json({ success: true, items, total, page: q.page, limit: q.limit });
  });

  router.get('/alerts/active', guard, async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = { ...buildFilter(q, 'createdAt'), resolvedAt: null };
    if (q.severity) filter.severity = q.severity;
    const [items, total] = await Promise.all([
      Alert.find(filter).sort({ createdAt: -1, _id: -1 }).limit(q.limit).lean(),
      Alert.countDocuments(filter),
    ]);
    res.json({ success: true, items, total, limit: q.limit });
  });

  router.get('/system/status', guard, async (req, res) => {
    const cutoff = new Date(Date.now() - config.offlineAfterSeconds * 1000);
    const [devices, fresh, active, classifications] = await Promise.all([
      Device.countDocuments(),
      Device.countDocuments({ lastSeenAt: mongoose.trusted({ $gte: cutoff }), online: mongoose.trusted({ $ne: false }) }),
      Alert.countDocuments({ resolvedAt: null }),
      RiskAnalysis.aggregate([
        { $sort: { analyzedAt: -1 } },
        { $group: { _id: '$classification', count: { $sum: 1 } } },
      ]),
    ]);
    res.json({
      success: true,
      database: status.database ? 'connected' : 'unavailable',
      mqtt: config.mqttEnabled ? (status.mqtt ? 'subscribed' : 'unavailable') : 'disabled',
      ai: { available: status.ai ?? null, lastError: status.aiLastError ?? null,
        lastSuccessAt: status.aiLastSuccessAt ?? null, modelVersion: 'python-rules-v1' },
      mqttConnectedAt: status.mqttConnectedAt ?? null,
      payloadFormat: config.payloadFormat === 'rbrick-v1' ? 'resilliox-v1' : config.payloadFormat,
      socketClients: status.socketClients ?? 0,
      counters: {
        persisted: status.persisted ?? 0, rejected: status.rejected ?? 0,
        persistenceFailures: status.persistenceFailures ?? 0,
        mqttReconnects: status.mqttReconnects ?? 0, aiFailures: status.aiFailures ?? 0,
        aiTimeouts: status.aiTimeouts ?? 0,
      },
      devices, online: fresh, offline: devices - fresh, activeAlerts: active,
      riskClassifications: Object.fromEntries(classifications.map(c => [c._id, c.count])),
      simulatedDataNote: 'Readings tagged source=simulation come from the MQTT simulator, not hardware.',
    });
  });

  return router;
}
