import { Router } from 'express';
import { z } from 'zod';
import { EmergencyIncident, MaintenanceTicket } from '../models/index.js';
import { requireToken, requireRole } from '../middleware/auth.js';

const triggerInput = z.object({
  deviceId: z.string().trim().max(128).optional(),
  buildingId: z.string().trim().max(128).optional(),
  floorId: z.string().trim().max(128).optional(),
  zoneId: z.string().trim().max(128).optional(),
  room: z.string().trim().max(100).optional(),
  message: z.string().trim().min(1).max(500),
  triggerSource: z.enum(['hardware', 'simulation', 'web_ui', 'operator']).default('web_ui'),
  severity: z.enum(['warning', 'critical']).default('critical'),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'acknowledged', 'responding', 'resolved', 'cancelled']).optional(),
  buildingId: z.string().trim().optional(),
  zoneId: z.string().trim().optional(),
  from: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
});

export function emergencyRoutes(config, emergencyService) {
  const router = Router();

  // All emergency endpoints require an authenticated user or operator token
  router.use(requireToken(config));

  // POST /api/emergency/trigger - Any authenticated user (Student, Faculty, Staff, etc.) can raise SOS
  router.post('/trigger', async (req, res) => {
    const input = triggerInput.parse(req.body);
    const reportedBy = {
      userId: req.user.userId,
      name: req.user.name || 'Occupant',
      email: req.user.email || '',
      role: req.user.role || 'student',
      phone: req.user.phone || '',
    };

    const incident = await emergencyService.triggerEmergency({
      ...input,
      reportedBy,
    });

    res.status(201).json({ success: true, item: incident });
  });

  // GET /api/emergency/active - Active and in-progress emergencies
  router.get('/active', async (req, res) => {
    const active = await EmergencyIncident.find({
      status: { $in: ['active', 'acknowledged', 'responding'] }
    }).sort({ createdAt: -1 }).lean();

    res.json({ success: true, items: active, total: active.length });
  });

  // GET /api/emergency/incidents - Paginated emergency history
  router.get('/incidents', async (req, res) => {
    const q = listQuery.parse(req.query);
    const filter = {};

    if (q.status) filter.status = q.status;
    if (q.buildingId) filter.buildingId = q.buildingId;
    if (q.zoneId) filter.zoneId = q.zoneId;
    if (q.from || q.before) {
      filter.createdAt = {
        ...(q.from ? { $gte: new Date(q.from) } : {}),
        ...(q.before ? { $lt: new Date(q.before) } : {}),
      };
    }

    const [items, total] = await Promise.all([
      EmergencyIncident.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      EmergencyIncident.countDocuments(filter),
    ]);

    res.json({ success: true, items, total, page: q.page, limit: q.limit });
  });

  // GET /api/emergency/incidents/:id - Incident details with timeline
  router.get('/incidents/:id', async (req, res) => {
    const id = req.params.id;
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };
    const incident = await EmergencyIncident.findOne(query).lean();

    if (!incident) {
      return res.status(404).json({ success: false, message: 'Emergency incident not found' });
    }

    res.json({ success: true, item: incident });
  });

  // PATCH /api/emergency/incidents/:id/acknowledge
  router.patch('/incidents/:id/acknowledge', requireRole('security_guard', 'facility_manager', 'admin'), async (req, res) => {
    try {
      const incident = await emergencyService.acknowledgeEmergency(req.params.id, req.user);
      res.json({ success: true, item: incident });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // PATCH /api/emergency/incidents/:id/respond
  router.patch('/incidents/:id/respond', requireRole('security_guard', 'facility_manager', 'admin'), async (req, res) => {
    const schema = z.object({
      responderUnit: z.string().trim().min(1).max(100),
      notes: z.string().trim().max(500).optional(),
    });
    const body = schema.parse(req.body);

    try {
      const incident = await emergencyService.dispatchResponse(
        req.params.id,
        body.responderUnit,
        body.notes,
        req.user
      );
      res.json({ success: true, item: incident });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // PATCH /api/emergency/incidents/:id/buzzer
  router.patch('/incidents/:id/buzzer', requireRole('security_guard', 'facility_manager', 'admin'), async (req, res) => {
    const schema = z.object({
      buzzerState: z.enum(['active', 'silenced', 'off']),
    });
    const body = schema.parse(req.body);

    try {
      const incident = await emergencyService.setBuzzer(req.params.id, body.buzzerState, req.user);
      res.json({ success: true, item: incident });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // PATCH /api/emergency/incidents/:id/resolve
  router.patch('/incidents/:id/resolve', requireRole('facility_manager', 'admin'), async (req, res) => {
    const schema = z.object({
      resolutionNotes: z.string().trim().min(1).max(1000),
    });
    const body = schema.parse(req.body);

    try {
      const incident = await emergencyService.resolveEmergency(
        req.params.id,
        body.resolutionNotes,
        req.user
      );
      res.json({ success: true, item: incident });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // POST /api/emergency/incidents/:id/maintenance - Create maintenance ticket directly from emergency
  router.post('/incidents/:id/maintenance', requireRole('security_guard', 'facility_manager', 'admin', 'maintenance_staff'), async (req, res) => {
    const schema = z.object({
      title: z.string().trim().min(3).max(200),
      description: z.string().trim().min(5).max(2000),
      priority: z.enum(['low', 'normal', 'high', 'critical']).default('high'),
      category: z.enum(['electrical', 'plumbing', 'hvac', 'structural', 'fire_safety', 'sensor_iot', 'general']).default('fire_safety'),
      dueAt: z.string().datetime().optional(),
    });
    const body = schema.parse(req.body);

    const id = req.params.id;
    const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { emergencyId: id };
    const incident = await EmergencyIncident.findOne(query);

    if (!incident) {
      return res.status(404).json({ success: false, message: 'Emergency incident not found' });
    }

    // Deduplication check: prevent multiple active tickets for the same emergency
    if (incident.linkedTicketId) {
      const existingTicket = await MaintenanceTicket.findOne({ ticketId: incident.linkedTicketId });
      if (existingTicket && existingTicket.status !== 'verified_closed') {
        return res.status(409).json({
          success: false,
          message: `Active maintenance ticket already linked to this emergency: ${incident.linkedTicketId}`,
          item: existingTicket
        });
      }
    }

    const ticketId = `MNT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + 24 * 3600 * 1000);

    const ticket = await MaintenanceTicket.create({
      ticketId,
      title: body.title,
      description: body.description,
      buildingId: incident.buildingId,
      floorId: incident.floorId,
      zoneId: incident.zoneId,
      room: incident.room,
      location: `${incident.buildingId}${incident.floorId ? ` Fl ${incident.floorId}` : ''}${incident.room ? ` Rm ${incident.room}` : ''}`,
      category: body.category,
      priority: body.priority,
      status: 'reported',
      source: 'emergency_incident',
      deviceId: incident.deviceId,
      alertId: incident.alertId,
      emergencyId: incident.emergencyId,
      reporter: {
        userId: req.user.userId,
        name: req.user.name,
        email: req.user.email,
        role: req.user.role,
        phone: req.user.phone,
      },
      history: [{
        action: 'created_from_emergency',
        fromStatus: null,
        toStatus: 'reported',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Spawned from Emergency Incident ${incident.emergencyId}`,
      }],
      dueAt,
    });

    // Link back to emergency incident
    incident.linkedTicketId = ticket.ticketId;
    incident.timeline.push({
      action: 'maintenance_linked',
      actor: req.user.name,
      role: req.user.role,
      timestamp: new Date(),
      notes: `Linked Maintenance Ticket: ${ticket.ticketId}`,
    });
    await incident.save();

    res.status(201).json({ success: true, item: ticket });
  });

  return router;
}
