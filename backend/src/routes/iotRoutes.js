import { Router } from 'express';
import { z } from 'zod';
import { SensorReading, Alert, Device, MaintenanceEvent, MaintenanceTask, RiskAnalysis, MaintenanceTicket } from '../models/index.js';
import { mongoose } from '../config/database.js';
const deviceId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\-]+$/);
const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/);
const date = z.iso.datetime({ offset: true });
const listQuery = z.object({
  alertId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  deviceId: deviceId.optional(), limit: z.coerce.number().int().min(1).max(100).default(30),
  page: z.coerce.number().int().min(1).max(10000).default(1),
  from: date.optional(), before: date.optional(),
  status: z.enum(['active', 'acknowledged', 'resolved', 'open', 'in_progress', 'completed']).optional(),
  severity: z.enum(['info', 'warning', 'critical']).optional(),
  field: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/).optional(),
  kind: z.enum(['safety', 'sos', 'fault', 'maintenance']).optional(),
}).strict();
const taskInput = z.object({ deviceId, description: z.string().trim().min(1).max(1000),
  priority: z.enum(['low', 'normal', 'high', 'critical']).default('normal'), dueAt: date }).strict();
const taskUpdate = taskInput.omit({ deviceId: true }).partial().extend({
  status: z.enum(['open', 'in_progress', 'completed']).optional(),
}).strict().refine(input => Object.keys(input).length > 0);
const deviceInput = z.object({ deviceId, name: z.string().trim().max(100).default(''), area: z.string().trim().max(100).default(''),
  buildingId: deviceId.optional(), floorId: deviceId.optional(), zoneId: deviceId.optional() }).strict();
const activeFilter = { resolvedAt: null, kind: { $ne:'security' } };
const criticalFilter = { $or: [{ severity: 'critical' }, { severity: { $exists: false }, kind: 'sos' }] };
// Only operators constructed by these routes are trusted. Request values are
// validated primitives; global Mongoose filter sanitization remains enabled.
function safe(query) {
  function trust(filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (['$or', '$and', '$nor'].includes(key)) value.forEach(trust);
      else if (value && typeof value === 'object' && Object.keys(value).some(k => k.startsWith('$'))) mongoose.trusted(value);
    }
  }
  trust(query.getFilter());
  return query;
}
export function iotRoutes(config, status) {
  const router = Router();
  for (const [path, model, timeField] of [
    ['/readings', SensorReading, 'receivedAt'], ['/alerts', Alert, 'createdAt'],
    ['/devices', Device, 'createdAt'], ['/history', MaintenanceEvent, 'occurredAt'],
    ['/tasks', MaintenanceTask, 'createdAt'],
  ]) {
    router.get(path, async (req, res) => {
      const q = listQuery.parse(req.query);
      const filter = q.deviceId ? { deviceId: q.deviceId } : {};
      if (q.from || q.before) filter[timeField] = { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.before ? { $lt: new Date(q.before) } : {}) };
      if (path === '/alerts') {
        filter.kind={ $ne:'security' };
        if(q.alertId)filter._id=q.alertId;
        if (q.status === 'active') Object.assign(filter, { resolvedAt: null, acknowledgedAt: null });
        if (q.status === 'acknowledged') Object.assign(filter, { resolvedAt: null, acknowledgedAt: { $ne: null } });
        if (q.status === 'resolved') filter.resolvedAt = { $ne: null };
        if (q.severity) {
          if (q.severity === 'critical') Object.assign(filter, criticalFilter);
          else if (q.severity === 'warning') filter.$or = [{ severity: 'warning' }, { severity: { $exists: false }, kind: { $ne: 'sos' } }];
          else filter.severity = q.severity;
        }
        if (q.field) filter.field = q.field;
        if (q.kind) filter.kind = q.kind;
      }
      if (path === '/tasks' && ['open', 'in_progress', 'completed'].includes(q.status)) filter.status = q.status;
      const [items, total] = await Promise.all([
        safe(model.find(filter)).sort({ [timeField]: -1, _id: -1 }).skip((q.page - 1) * q.limit).limit(q.limit).lean(),
        safe(model.countDocuments(filter)),
      ]);
      if (path === '/devices' && items.length) {
        const ids = items.map(item => item.deviceId);
        const [tasks, events] = await Promise.all([
          MaintenanceTask.aggregate([{ $match: { deviceId: { $in: ids }, status: 'completed' } }, { $group: { _id: '$deviceId', at: { $max: '$completedAt' } } }]),
          MaintenanceEvent.aggregate([{ $match: { deviceId: { $in: ids }, kind: 'maintenance' } }, { $group: { _id: '$deviceId', at: { $max: '$occurredAt' } } }]),
        ]);
        for (const item of items) {
          const dates = [...tasks, ...events].filter(row => row._id === item.deviceId && row.at).map(row => new Date(row.at).getTime());
          item.lastMaintenanceAt = dates.length ? new Date(Math.max(...dates)) : null;
        }
      }
      res.json({ success: true, items, total, page: q.page, limit: q.limit });
    });
  }
  router.post('/devices', async (req, res) => {
    const input = deviceInput.parse(req.body);
    if (await Device.exists({ deviceId: input.deviceId })) return res.status(409).json({ success: false, message: 'Device ID is already registered' });
    try { res.status(201).json({ success: true, item: await Device.create(input) }); }
    catch (e) { if (e.code === 11000) return res.status(409).json({ success: false, message: 'Device ID is already registered' }); throw e; }
  });
  router.patch('/devices/:id', async (req, res) => {
    const id = objectId.parse(req.params.id);
    const input = deviceInput.omit({ deviceId: true }).partial().refine(v => Object.keys(v).length > 0).parse(req.body);
    const item = await Device.findByIdAndUpdate(id, input, { returnDocument: 'after', runValidators: true });
    if (!item) return res.status(404).json({ success: false, message: 'Device not found' });
    res.json({ success: true, item });
  });
  router.post('/history', async (req, res) => {
    const input = z.object({ deviceId, kind: z.enum(['maintenance', 'fault']),
      note: z.string().trim().min(1).max(1000), occurredAt: date }).strict().parse(req.body);
    if (!await Device.exists({ deviceId: input.deviceId })) return res.status(404).json({ success: false, message: 'Register this device first' });
    res.status(201).json({ success: true, item: await MaintenanceEvent.create(input) });
  });
  for (const action of ['acknowledge', 'resolve']) router.patch(`/alerts/:id/${action}`, async (req, res) => {
    const id = objectId.parse(req.params.id);
    const input = action === 'resolve' ? z.object({ resolution: z.string().trim().min(1).max(1000) }).strict().parse(req.body) : z.object({}).strict().parse(req.body || {});
    const update = action === 'resolve' ? { resolvedAt: new Date(), resolution: input.resolution } : { acknowledgedAt: new Date() };
    const filter = { _id: id, kind: { $ne:'security' }, resolvedAt: null, ...(action === 'acknowledge' ? { acknowledgedAt: null } : {}) };
    const item = await safe(Alert.findOneAndUpdate(filter, update, { returnDocument: 'after', runValidators: true }));
    if (!item) return res.status(409).json({ success: false, message: 'Incident not found or already updated. Refresh before retrying.' });
    res.json({ success: true, item });
  });
  router.post('/tasks', async (req, res) => {
    const input = taskInput.parse(req.body);
    const device = await Device.findOne({ deviceId: input.deviceId }).lean();
    if (!device) return res.status(404).json({ success: false, message: 'Register this device first' });
    res.status(201).json({ success: true, item: await MaintenanceTask.create({...input,
      buildingId:device.buildingId,floorId:device.floorId,zoneId:device.zoneId}) });
  });
  router.post('/alerts/:id/maintenance', async (req, res) => {
    const alertId = objectId.parse(req.params.id);
    const input = taskInput.omit({deviceId:true}).parse(req.body);
    const alert = await Alert.findById(alertId).lean();
    if(alert?.kind==='security')return res.status(409).json({success:false,message:'Security alerts are managed in Security & Surveillance'});
    if (!alert) return res.status(404).json({success:false,message:'Incident not found'});
    if (alert.resolvedAt) return res.status(409).json({success:false,message:'Resolved incidents cannot create active maintenance requests'});
    const [device, reading] = await Promise.all([Device.findOne({deviceId:alert.deviceId}).lean(),SensorReading.findById(alert.readingId).lean()]);
    const key = `${alert.deviceId}:${alert.source || 'unknown'}:${alert.incidentId || alert._id}`;
    try {
      const item = await MaintenanceTask.create({...input,deviceId:alert.deviceId,alertId:alert._id,
        incidentId:alert.incidentId,activeIncidentKey:key,
        buildingId:reading?.buildingId || device?.buildingId,floorId:device?.floorId,
        zoneId:alert.zoneId || reading?.zoneId || device?.zoneId,source:alert.source,
        riskScore:alert.riskScore,riskClassification:alert.riskClassification});
      try {
        const ticketId = `MNT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
        await MaintenanceTicket.create({
          ticketId,
          title: `Incident: ${alert.message || alert.field || 'Safety Hazard'}`,
          description: input.description,
          buildingId: reading?.buildingId || device?.buildingId || 'Building-1',
          floorId: device?.floorId,
          zoneId: alert.zoneId || reading?.zoneId || device?.zoneId,
          location: `${reading?.buildingId || device?.buildingId || 'Building-1'}${device?.floorId ? ` Fl ${device.floorId}` : ''}`,
          category: alert.field === 'temperature' ? 'hvac' : (alert.field === 'gas_ppm' || alert.field === 'gas_raw') ? 'fire_safety' : 'sensor_iot',
          priority: input.priority || 'normal',
          status: 'reported',
          source: 'safety_event',
          deviceId: alert.deviceId,
          alertId: alert._id,
          reporter: { name: 'IoT Safety Monitor', role: 'system' },
          history: [{
            action: 'created_from_alert',
            fromStatus: null,
            toStatus: 'reported',
            actor: 'System',
            role: 'system',
            timestamp: new Date(),
            notes: `Auto-generated from alert ${alert._id}`,
          }],
          dueAt: new Date(input.dueAt),
        });
      } catch {}
      return res.status(201).json({success:true,item});
    } catch(error) {
      if(error.code===11000) return res.status(409).json({success:false,message:'An active maintenance request already exists for this incident'});
      throw error;
    }
  });
  router.patch('/tasks/:id', async (req, res) => {
    const id = objectId.parse(req.params.id), input = taskUpdate.parse(req.body);
    const update = { ...input };
    if (input.status) {
      update.completedAt = input.status === 'completed' ? new Date() : null;
      const existing = await MaintenanceTask.findById(id).lean();
      if(existing?.alertId) update.activeIncidentKey = input.status === 'completed' ? undefined
        : `${existing.deviceId}:${existing.source || 'unknown'}:${existing.incidentId || existing.alertId}`;
    }
    if(input.status==='completed') { delete update.activeIncidentKey; update.$unset={activeIncidentKey:1}; }
    try {
      const item = await safe(MaintenanceTask.findOneAndUpdate({ _id: id,
        ...(input.status === 'completed' ? { status: { $ne: 'completed' } } : {}),
      }, update, { returnDocument: 'after', runValidators: true }));
      if (!item) return res.status(409).json({ success: false, message: 'Task not found or already completed. Refresh before retrying.' });
      res.json({ success: true, item });
    } catch(error) {
      if(error.code===11000)return res.status(409).json({success:false,message:'An active maintenance request already exists for this incident'});
      throw error;
    }
  });
  router.get('/summary', async (req, res) => {
    const since = new Date(Date.now() - config.offlineAfterSeconds * 1000);
    const [devices, fresh, active, critical, due, completed, latest, latestRisk] = await Promise.all([
      Device.countDocuments(), safe(Device.countDocuments({ lastSeenAt: { $gte: since }, online: { $ne: false } })),
      safe(Alert.countDocuments(activeFilter)), safe(Alert.countDocuments({ ...activeFilter, ...criticalFilter })),
      safe(MaintenanceTask.countDocuments({ status: { $ne: 'completed' }, dueAt: { $lte: new Date() } })),
      MaintenanceTask.countDocuments({ status: 'completed' }),
      SensorReading.aggregate([{ $sort: { receivedAt: -1 } }, { $group: { _id: '$deviceId', reading: { $first: '$$ROOT' } } }, { $sort: { 'reading.receivedAt': -1 } }, { $limit: 100 }]),
      RiskAnalysis.aggregate([{ $sort: { analyzedAt: -1 } }, { $group: { _id: '$deviceId', risk: { $first: '$$ROOT' } } }, { $sort: { 'risk.analyzedAt': -1 } }, { $limit: 100 }]),
    ]);
    const knownConnectivity = config.mqttEnabled && status.mqtt;
    const unavailable = new Set(latest.filter(item => item.reading.analysisStatus === 'unavailable').map(item => item._id));
    res.json({ success: true, devices, online: knownConnectivity ? fresh : null,
      offline: knownConnectivity ? devices - fresh : null, active, critical, due, completed,
      latest: latest.map(item => item.reading), latestLimit: 100,
      // Latest risk analysis per device so the dashboard shows scores on load.
      risk: latestRisk.map(item => item.risk).filter(risk => !unavailable.has(risk.deviceId)) });
  });
  router.get('/analytics', async (req, res) => {
    const q = z.object({ from: date, deviceId: deviceId.optional() }).strict().parse(req.query);
    const from = new Date(q.from), now = new Date();
    if (from > now || now - from > 31 * 86400000) return res.status(400).json({ success: false, message: 'Choose a range within the last 31 days' });
    const device = q.deviceId ? { deviceId: q.deviceId } : {};
    const bucketMs = now - from <= 86460000 ? 3600000 : 86400000;
    const trendPipeline = [
      { $match: { ...device, receivedAt: { $gte: from } } },
      { $project: { receivedAt: 1, pairs: { $objectToArray: '$sensors' } } }, { $unwind: '$pairs' },
      { $match: { 'pairs.v': { $type: 'number' } } },
      { $group: { _id: { bucket: { $subtract: [{ $toLong: '$receivedAt' }, { $mod: [{ $toLong: '$receivedAt' }, bucketMs] }] }, field: '$pairs.k' }, value: { $avg: '$pairs.v' }, samples: { $sum: 1 } } },
      { $sort: { '_id.bucket': 1 } },
    ];
    const [trends, incidents, tasks, binary, doors] = await Promise.all([
      SensorReading.aggregate(trendPipeline),
      Alert.aggregate([{ $match: { ...device, kind:{$ne:'security'}, createdAt: { $gte: from } } }, { $group: { _id: { field: '$field', kind: '$kind', severity: { $ifNull: ['$severity', { $cond: [{ $eq: ['$kind', 'sos'] }, 'critical', 'warning'] }] } }, count: { $sum: 1 } } }]),
      MaintenanceTask.aggregate([{ $match: { ...device, completedAt: { $gte: from } } }, { $count: 'completed' }]),
      SensorReading.aggregate([{ $match: { ...device, receivedAt: { $gte: from } } }, { $project: { pairs: { $objectToArray: '$sensors' } } }, { $unwind: '$pairs' }, { $match: { 'pairs.v': true } }, { $group: { _id: '$pairs.k', count: { $sum: 1 } } }]),
      config.contract.display.doorOpen ? safe(SensorReading.find({ ...device, receivedAt: { $gte: from }, [`sensors.${config.contract.display.doorOpen}`]: { $exists: true } })).sort({ receivedAt: -1 }).limit(50).lean() : [],
    ]);
    res.json({ success: true, from, to: now, bucketMs, trends, incidents, completed: tasks[0]?.completed || 0,
      activations: binary, doorHistory: doors, doorHistoryLimit: 50 });
  });
  return router;
}
