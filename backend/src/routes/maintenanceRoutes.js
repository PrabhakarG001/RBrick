import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { 
  MaintenanceTicket, 
  MaintenanceTask, 
  TICKET_CATEGORIES, 
  TICKET_PRIORITIES, 
  TICKET_STATUSES,
  User,
  Alert,
  Device
} from '../models/index.js';
import { requireToken, requireRole } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UPLOADS_DIR = path.resolve(__dirname, '../../uploads/maintenance');

// Ensure upload directory exists
try {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
} catch {
  // If filesystem is read-only, memory/base64 fallback is used
}

function normalizePriority(p) {
  if (!p) return 'normal';
  const lower = p.toLowerCase();
  if (lower === 'medium') return 'normal';
  return lower;
}

function savePhotoAttachment(ticketId, photoInput, user) {
  const photoId = 'ph_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const filename = (photoInput.filename || 'attachment.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
  let contentType = photoInput.contentType || 'image/jpeg';
  let byteSize = photoInput.byteSize || 0;
  let storagePath = null;
  const data = photoInput.data;

  if (data && data.startsWith('data:')) {
    const match = data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
    if (match) {
      contentType = match[1];
      try {
        const buffer = Buffer.from(match[2], 'base64');
        byteSize = buffer.length;
        const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
        const diskFilename = `${ticketId}_${photoId}${ext}`;
        const fullPath = path.join(UPLOADS_DIR, diskFilename);
        fs.writeFileSync(fullPath, buffer);
        storagePath = fullPath;
      } catch {
        // Disk write failed; fall back to keeping base64 data
      }
    }
  }

  return {
    photoId,
    filename,
    contentType,
    byteSize,
    caption: photoInput.caption || '',
    storagePath: storagePath || undefined,
    url: `/api/maintenance/tickets/${ticketId}/photos/${photoId}`,
    data: storagePath ? undefined : data, // Omit raw payload if stored on disk
    uploadedAt: new Date(),
    uploadedBy: {
      userId: user?.userId,
      name: user?.name,
    },
  };
}

const photoInputSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().max(64),
  byteSize: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
  caption: z.string().trim().max(200).optional(),
  data: z.string().min(10), // Base64 or Data URI
});

const createTicketSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(5).max(2000),
  buildingId: z.string().trim().max(128).default('Building-1'),
  floorId: z.string().trim().max(128).optional(),
  zoneId: z.string().trim().max(128).optional(),
  room: z.string().trim().max(100).optional(),
  location: z.string().trim().max(200).optional(),
  category: z.enum(TICKET_CATEGORIES).default('general'),
  priority: z.enum(TICKET_PRIORITIES).default('normal'),
  source: z.enum(['manual_report', 'safety_event', 'emergency_incident', 'iot_alert']).default('manual_report'),
  deviceId: z.string().trim().max(128).optional(),
  alertId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  emergencyId: z.string().trim().max(64).optional(),
  dueAt: z.string().datetime().optional(),
  photos: z.array(photoInputSchema).max(5).optional(),
});

const updateTicketSchema = z.object({
  title: z.string().trim().min(3).max(200).optional(),
  description: z.string().trim().min(5).max(2000).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  location: z.string().trim().max(200).optional(),
  buildingId: z.string().trim().max(128).optional(),
  floorId: z.string().trim().max(128).optional(),
  room: z.string().trim().max(100).optional(),
  dueAt: z.string().datetime().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(TICKET_STATUSES).optional(),
  category: z.enum(TICKET_CATEGORIES).optional(),
  priority: z.enum(TICKET_PRIORITIES).optional(),
  buildingId: z.string().trim().optional(),
  deviceId: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  source: z.string().trim().optional(),
  search: z.string().trim().max(100).optional(),
  sortBy: z.enum(['createdAt', 'dueAt', 'priority', 'status']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export function maintenanceRoutes(config) {
  const router = Router();

  // All endpoints require authentication
  router.use(requireToken(config));

  // Helper to emit real-time updates via Socket.IO
  const emitSocket = (req, event, data) => {
    try {
      const io = req.app.get('io');
      if (io) {
        io.emit(event, data);
      }
    } catch {}
  };

  // ── 1. GET /api/maintenance/stats - Maintenance Dashboard Statistics ──
  router.get('/stats', async (req, res) => {
    try {
      const now = new Date();
      const [
        totalTickets,
        openTickets,
        reportedCount,
        assignedCount,
        inProgressCount,
        repairCompletedCount,
        verifiedClosedCount,
        reopenedCount,
        overdueCount,
        unassignedCount,
        recentTickets
      ] = await Promise.all([
        MaintenanceTicket.countDocuments(),
        MaintenanceTicket.countDocuments({ status: { $ne: 'verified_closed' } }),
        MaintenanceTicket.countDocuments({ status: 'reported' }),
        MaintenanceTicket.countDocuments({ status: 'assigned' }),
        MaintenanceTicket.countDocuments({ status: 'in_progress' }),
        MaintenanceTicket.countDocuments({ status: 'repair_completed' }),
        MaintenanceTicket.countDocuments({ status: 'verified_closed' }),
        MaintenanceTicket.countDocuments({ status: 'reopened' }),
        MaintenanceTicket.countDocuments({ status: { $ne: 'verified_closed' }, dueAt: { $lt: now } }),
        MaintenanceTicket.countDocuments({ status: { $ne: 'verified_closed' }, 'assignedTo.userId': { $exists: false } }),
        MaintenanceTicket.find().sort({ updatedAt: -1 }).limit(10).lean(),
      ]);

      // Count by category
      const categoryCounts = {};
      for (const cat of TICKET_CATEGORIES) {
        categoryCounts[cat] = 0;
      }
      const categoryAgg = await MaintenanceTicket.aggregate([
        { $group: { _id: '$category', count: { $sum: 1 } } }
      ]);
      categoryAgg.forEach(item => {
        if (item._id) categoryCounts[item._id] = item.count;
      });

      // Count by priority
      const priorityCounts = { low: 0, normal: 0, high: 0, critical: 0 };
      const priorityAgg = await MaintenanceTicket.aggregate([
        { $group: { _id: '$priority', count: { $sum: 1 } } }
      ]);
      priorityAgg.forEach(item => {
        const norm = normalizePriority(item._id);
        priorityCounts[norm] = (priorityCounts[norm] || 0) + item.count;
      });

      // Recent activity trail
      const recentActivity = [];
      for (const t of recentTickets) {
        for (const h of (t.history || []).slice(-3)) {
          recentActivity.push({
            ticketId: t.ticketId,
            title: t.title,
            action: h.action,
            actor: h.actor,
            role: h.role,
            timestamp: h.timestamp,
            notes: h.notes,
          });
        }
      }
      recentActivity.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.json({
        success: true,
        stats: {
          totalTickets,
          openTickets,
          byStatus: {
            reported: reportedCount,
            assigned: assignedCount,
            in_progress: inProgressCount,
            repair_completed: repairCompletedCount,
            verified_closed: verifiedClosedCount,
            reopened: reopenedCount,
          },
          byPriority: priorityCounts,
          byCategory: categoryCounts,
          assignedCount: totalTickets - unassignedCount,
          unassignedCount,
          completedRepairs: repairCompletedCount + verifiedClosedCount,
          verifiedRepairs: verifiedClosedCount,
          overdueCount,
          recentActivity: recentActivity.slice(0, 10),
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // Alias for /tickets/stats
  router.get('/tickets/stats', (req, res) => res.redirect(307, '/api/maintenance/stats'));

  // ── 2. GET /api/maintenance/tickets - Filtered List & Search ──
  router.get('/tickets', async (req, res) => {
    try {
      const q = listQuerySchema.parse(req.query);
      const filter = {};

      if (q.status) filter.status = q.status;
      if (q.category) filter.category = q.category;
      if (q.priority) filter.priority = normalizePriority(q.priority);
      if (q.buildingId) filter.buildingId = q.buildingId;
      if (q.deviceId) filter.deviceId = q.deviceId;
      if (q.source) filter.source = q.source;
      if (q.assignedTo) filter['assignedTo.userId'] = q.assignedTo;

      if (q.search) {
        filter.$or = [
          { ticketId: { $regex: q.search, $options: 'i' } },
          { title: { $regex: q.search, $options: 'i' } },
          { description: { $regex: q.search, $options: 'i' } },
          { location: { $regex: q.search, $options: 'i' } },
          { room: { $regex: q.search, $options: 'i' } },
        ];
      }

      const sort = {};
      sort[q.sortBy] = q.sortOrder === 'asc' ? 1 : -1;

      const [items, total] = await Promise.all([
        MaintenanceTicket.find(filter)
          .sort(sort)
          .skip((q.page - 1) * q.limit)
          .limit(q.limit)
          .lean(),
        MaintenanceTicket.countDocuments(filter),
      ]);

      res.json({
        success: true,
        items,
        total,
        page: q.page,
        limit: q.limit,
        totalPages: Math.ceil(total / q.limit) || 1,
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 3. POST /api/maintenance/tickets - Create Ticket ──
  router.post('/tickets', async (req, res) => {
    try {
      const body = createTicketSchema.parse(req.body);
      const priority = normalizePriority(body.priority);

      // Deduplication check: if alertId or (deviceId && category) matches an unresolved ticket within last 2h
      if (body.alertId || (body.deviceId && body.category)) {
        const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
        const dedupFilter = {
          status: { $in: ['reported', 'assigned', 'in_progress', 'reopened'] },
          $or: [
            ...(body.alertId ? [{ alertId: body.alertId }] : []),
            ...(body.deviceId ? [{ deviceId: body.deviceId, category: body.category, createdAt: { $gte: twoHoursAgo } }] : []),
          ]
        };
        const existing = await MaintenanceTicket.findOne(dedupFilter);
        if (existing) {
          return res.status(409).json({
            success: false,
            message: `Active maintenance ticket already exists for this event: ${existing.ticketId}`,
            item: existing,
          });
        }
      }

      const ticketId = `MNT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
      const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + 48 * 3600 * 1000);

      const reporter = {
        userId: req.user.userId,
        name: req.user.name || 'Building Occupant',
        email: req.user.email || '',
        role: req.user.role || 'student',
        phone: req.user.phone || '',
      };

      const processedPhotos = (body.photos || []).map(p => savePhotoAttachment(ticketId, p, req.user));

      const ticket = await MaintenanceTicket.create({
        ticketId,
        title: body.title,
        description: body.description,
        buildingId: body.buildingId,
        floorId: body.floorId,
        zoneId: body.zoneId,
        room: body.room,
        location: body.location || `${body.buildingId}${body.floorId ? ` Fl ${body.floorId}` : ''}${body.room ? ` Rm ${body.room}` : ''}`,
        category: body.category,
        priority,
        status: 'reported',
        source: body.source,
        deviceId: body.deviceId,
        alertId: body.alertId,
        emergencyId: body.emergencyId,
        reporter,
        photos: processedPhotos,
        history: [{
          action: 'created',
          fromStatus: null,
          toStatus: 'reported',
          actor: req.user.name || 'Occupant',
          role: req.user.role || 'student',
          timestamp: new Date(),
          notes: 'Maintenance ticket submitted',
        }],
        dueAt,
      });

      // Mirror into MaintenanceTask for backwards compatibility with legacy tests
      try {
        if (body.deviceId) {
          await MaintenanceTask.create({
            deviceId: body.deviceId,
            alertId: body.alertId,
            incidentId: ticket.ticketId,
            buildingId: body.buildingId,
            floorId: body.floorId,
            zoneId: body.zoneId,
            description: `[${ticket.ticketId}] ${body.title}: ${body.description}`,
            priority,
            status: 'open',
            dueAt,
          });
        }
      } catch {}

      emitSocket(req, 'maintenance:created', ticket);

      res.status(201).json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 4. POST /api/maintenance/from-safety-event - Cross-Module Integration ──
  router.post('/from-safety-event', async (req, res) => {
    try {
      const eventSchema = z.object({
        alertId: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
        deviceId: z.string().trim().min(1).max(128),
        title: z.string().trim().min(3).max(200).optional(),
        description: z.string().trim().min(5).max(2000).optional(),
        category: z.enum(TICKET_CATEGORIES).default('sensor_iot'),
        priority: z.enum(TICKET_PRIORITIES).default('high'),
        source: z.enum(['safety_event', 'iot_alert']).default('safety_event'),
        dueAt: z.string().datetime().optional(),
      });
      const body = eventSchema.parse(req.body);
      const priority = normalizePriority(body.priority);

      // Check deduplication
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
      const existing = await MaintenanceTicket.findOne({
        status: { $in: ['reported', 'assigned', 'in_progress', 'reopened'] },
        $or: [
          ...(body.alertId ? [{ alertId: body.alertId }] : []),
          { deviceId: body.deviceId, category: body.category, createdAt: { $gte: twoHoursAgo } }
        ]
      });

      if (existing) {
        return res.status(200).json({
          success: true,
          duplicate: true,
          message: `Active maintenance ticket already linked for device ${body.deviceId}`,
          item: existing,
        });
      }

      // Fetch device info for location enrichment
      const device = await Device.findOne({ deviceId: body.deviceId }).lean();
      const buildingId = device?.buildingId || 'Building-1';
      const floorId = device?.floorId || 'Floor-1';
      const zoneId = device?.zoneId || 'Zone-A';

      const ticketId = `MNT-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 900 + 100)}`;
      const title = body.title || `Hazard Inspection for ${body.deviceId} (${body.category})`;
      const description = body.description || `Automated maintenance ticket triggered by safety event from device ${body.deviceId}`;
      const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + 24 * 3600 * 1000);

      const ticket = await MaintenanceTicket.create({
        ticketId,
        title,
        description,
        buildingId,
        floorId,
        zoneId,
        location: `${buildingId} Floor ${floorId} Zone ${zoneId}`,
        category: body.category,
        priority,
        status: 'reported',
        source: body.source,
        deviceId: body.deviceId,
        alertId: body.alertId,
        reporter: {
          userId: req.user.userId,
          name: 'IoT Safety Monitor',
          role: 'system',
        },
        history: [{
          action: 'created_from_safety_event',
          fromStatus: null,
          toStatus: 'reported',
          actor: req.user.name || 'System',
          role: req.user.role || 'system',
          timestamp: new Date(),
          notes: `Created from ${body.source} on device ${body.deviceId}`,
        }],
        dueAt,
      });

      emitSocket(req, 'maintenance:created', ticket);

      res.status(201).json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 5. GET /api/maintenance/tickets/:id - Single Ticket Details ──
  router.get('/tickets/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };

      const ticket = await MaintenanceTicket.findOne(query).lean();
      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 6. GET /api/maintenance/tickets/:id/history - Ticket Audit Trail ──
  router.get('/tickets/:id/history', async (req, res) => {
    try {
      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };

      const ticket = await MaintenanceTicket.findOne(query, 'ticketId history').lean();
      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      res.json({ success: true, ticketId: ticket.ticketId, history: ticket.history || [] });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 7. PATCH /api/maintenance/tickets/:id - Edit Permitted Fields ──
  router.patch('/tickets/:id', async (req, res) => {
    try {
      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const body = updateTicketSchema.parse(req.body);

      const ticket = await MaintenanceTicket.findOne(query);
      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      // Priority changes require facility_manager or admin
      if (body.priority && !['facility_manager', 'admin'].includes(req.user.role)) {
        return res.status(403).json({ success: false, message: 'Only managers or admins can modify ticket priority' });
      }

      // Editing general info after closure is forbidden
      if (ticket.status === 'verified_closed' && req.user.role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Cannot edit verified and closed ticket' });
      }

      if (body.priority) body.priority = normalizePriority(body.priority);

      Object.assign(ticket, body);
      ticket.history.push({
        action: 'fields_updated',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Updated: ${Object.keys(body).join(', ')}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 8. PATCH /api/maintenance/tickets/:id/assign - Assign Technician ──
  router.patch('/tickets/:id/assign', requireRole('facility_manager', 'admin'), async (req, res) => {
    try {
      const assignSchema = z.object({
        technicianId: z.string().trim().min(1),
        notes: z.string().trim().max(500).optional(),
        dueAt: z.string().datetime().optional(),
      });
      const { technicianId, notes, dueAt } = assignSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      // Find technician user
      const tech = await User.findOne({
        $or: [
          { userId: technicianId },
          ...(technicianId.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: technicianId }] : [])
        ]
      }).lean();

      const techName = tech ? tech.name : technicianId;
      const techEmail = tech ? tech.email : '';
      const techRole = tech ? tech.role : 'maintenance_staff';

      const prevStatus = ticket.status;
      ticket.assignedTo = {
        userId: tech ? tech.userId : technicianId,
        name: techName,
        email: techEmail,
        role: techRole,
        assignedAt: new Date(),
      };

      if (ticket.status === 'reported') {
        ticket.status = 'assigned';
      }
      if (dueAt) {
        ticket.dueAt = new Date(dueAt);
      }

      ticket.history.push({
        action: 'assigned',
        fromStatus: prevStatus,
        toStatus: ticket.status,
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Assigned to ${techName} (${techRole}). ${notes || ''}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:assigned', { ticketId: ticket.ticketId, assignedTo: ticket.assignedTo });
      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 9. PATCH /api/maintenance/tickets/:id/status - Workflow State Transition ──
  router.patch('/tickets/:id/status', async (req, res) => {
    try {
      const statusSchema = z.object({
        status: z.enum(TICKET_STATUSES),
        notes: z.string().trim().max(1000).optional(),
      });
      const { status, notes } = statusSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      const fromStatus = ticket.status;

      // Workflow transition validation & role authorization
      if (status === 'in_progress') {
        if (!['assigned', 'reported', 'reopened'].includes(fromStatus)) {
          return res.status(400).json({ success: false, message: `Cannot move to in_progress from ${fromStatus}` });
        }
        if (!['maintenance_staff', 'facility_manager', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ success: false, message: 'Only technicians and managers can start work' });
        }
      } else if (status === 'repair_completed') {
        if (fromStatus !== 'in_progress') {
          return res.status(400).json({ success: false, message: 'Ticket must be in_progress before completing repair' });
        }
        if (!['maintenance_staff', 'facility_manager', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ success: false, message: 'Only technicians and managers can complete repairs' });
        }
        ticket.completedAt = new Date();
        ticket.repairDetails = {
          completedAt: new Date(),
          completedBy: { userId: req.user.userId, name: req.user.name },
          notes: notes || 'Repair work completed by technician',
        };
      } else if (status === 'verified_closed') {
        if (fromStatus !== 'repair_completed' && req.user.role !== 'admin') {
          return res.status(400).json({ success: false, message: 'Repairs must be completed before verification and closure' });
        }
        if (!['facility_manager', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ success: false, message: 'Only facility managers or admins can verify and close tickets' });
        }
        ticket.verifiedAt = new Date();
        ticket.verificationDetails = {
          verifiedAt: new Date(),
          verifiedBy: { userId: req.user.userId, name: req.user.name },
          notes: notes || 'Verified and approved by facility management',
        };
      } else if (status === 'reopened') {
        if (!['repair_completed', 'verified_closed'].includes(fromStatus)) {
          return res.status(400).json({ success: false, message: 'Only completed or closed tickets can be reopened' });
        }
        if (!['facility_manager', 'admin'].includes(req.user.role)) {
          return res.status(403).json({ success: false, message: 'Only managers can reopen tickets' });
        }
        ticket.reopenDetails = {
          reopenedAt: new Date(),
          reopenedBy: { userId: req.user.userId, name: req.user.name },
          reason: notes || 'Reopened for additional maintenance work',
        };
      }

      ticket.status = status;
      ticket.history.push({
        action: `status_change_to_${status}`,
        fromStatus,
        toStatus: status,
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: notes || `Status transitioned from ${fromStatus} to ${status}`,
      });

      await ticket.save();

      // Mirror to legacy MaintenanceTask if matching
      try {
        if (ticket.deviceId) {
          const legacyStatus = status === 'verified_closed' || status === 'repair_completed' ? 'completed'
            : status === 'in_progress' ? 'in_progress' : 'open';
          await MaintenanceTask.updateMany(
            { incidentId: ticket.ticketId },
            { status: legacyStatus, ...(legacyStatus === 'completed' ? { completedAt: new Date() } : {}) }
          );
        }
      } catch {}

      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 10. POST /api/maintenance/tickets/:id/repair - Record Repair Details ──
  router.post('/tickets/:id/repair', requireRole('maintenance_staff', 'facility_manager', 'admin'), async (req, res) => {
    try {
      const repairSchema = z.object({
        workPerformed: z.string().trim().min(3).max(2000),
        partsUsed: z.string().trim().max(1000).optional(),
        laborHours: z.number().min(0).max(1000).optional(),
        notes: z.string().trim().max(1000).optional(),
        photo: photoInputSchema.optional(),
      });
      const body = repairSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      if (ticket.status !== 'in_progress' && req.user.role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Ticket must be in_progress before recording repair completion' });
      }

      let attachedPhoto = null;
      if (body.photo) {
        attachedPhoto = savePhotoAttachment(ticket.ticketId, body.photo, req.user);
        ticket.photos.push(attachedPhoto);
      }

      const fromStatus = ticket.status;
      ticket.status = 'repair_completed';
      ticket.completedAt = new Date();
      ticket.repairDetails = {
        completedAt: new Date(),
        completedBy: { userId: req.user.userId, name: req.user.name },
        workPerformed: body.workPerformed,
        partsUsed: body.partsUsed || '',
        laborHours: body.laborHours || 0,
        notes: body.notes || body.workPerformed,
        photoUrl: attachedPhoto ? attachedPhoto.url : undefined,
      };

      ticket.history.push({
        action: 'repair_completed',
        fromStatus,
        toStatus: 'repair_completed',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Repair completed: ${body.workPerformed}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 11. PATCH /api/maintenance/tickets/:id/verify - Verify and Close ──
  router.patch('/tickets/:id/verify', requireRole('facility_manager', 'admin'), async (req, res) => {
    try {
      const verifySchema = z.object({
        notes: z.string().trim().min(1).max(1000),
        rating: z.number().int().min(1).max(5).default(5),
      });
      const { notes, rating } = verifySchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      if (ticket.status !== 'repair_completed' && req.user.role !== 'admin') {
        return res.status(400).json({ success: false, message: 'Work must be marked repair_completed before verification' });
      }

      const fromStatus = ticket.status;
      ticket.status = 'verified_closed';
      ticket.verifiedAt = new Date();
      ticket.verificationDetails = {
        verifiedAt: new Date(),
        verifiedBy: { userId: req.user.userId, name: req.user.name },
        notes,
        rating,
      };
      ticket.history.push({
        action: 'verified_and_closed',
        fromStatus,
        toStatus: 'verified_closed',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Quality verification approved (Rating: ${rating}/5): ${notes}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 12. PATCH /api/maintenance/tickets/:id/reopen - Reopen Ticket ──
  router.patch('/tickets/:id/reopen', requireRole('facility_manager', 'admin'), async (req, res) => {
    try {
      const reopenSchema = z.object({
        reason: z.string().trim().min(3).max(1000),
      });
      const { reason } = reopenSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      if (!['repair_completed', 'verified_closed'].includes(ticket.status)) {
        return res.status(400).json({ success: false, message: 'Only completed or closed tickets can be reopened' });
      }

      const fromStatus = ticket.status;
      ticket.status = 'reopened';
      ticket.reopenDetails = {
        reopenedAt: new Date(),
        reopenedBy: { userId: req.user.userId, name: req.user.name },
        reason,
      };
      ticket.history.push({
        action: 'ticket_reopened',
        fromStatus,
        toStatus: 'reopened',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Reopened: ${reason}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.json({ success: true, item: ticket });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 13. POST /api/maintenance/tickets/:id/notes - Add Progress Note ──
  router.post('/tickets/:id/notes', async (req, res) => {
    try {
      const noteSchema = z.object({
        text: z.string().trim().min(1).max(1000),
      });
      const { text } = noteSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      const note = {
        noteId: 'not_' + randomUUID().slice(0, 8),
        author: req.user.name || 'Staff',
        role: req.user.role || 'maintenance_staff',
        text,
        createdAt: new Date(),
      };

      ticket.notes.push(note);
      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.status(201).json({ success: true, item: note });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 14. POST /api/maintenance/tickets/:id/photos - Upload Supporting Photo ──
  router.post('/tickets/:id/photos', async (req, res) => {
    try {
      const body = photoInputSchema.parse(req.body);

      const id = req.params.id;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query);

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Maintenance ticket not found' });
      }

      if ((ticket.photos || []).length >= 5) {
        return res.status(400).json({ success: false, message: 'Maximum of 5 photos per ticket reached' });
      }

      const photo = savePhotoAttachment(ticket.ticketId, body, req.user);
      ticket.photos.push(photo);
      ticket.history.push({
        action: 'photo_uploaded',
        actor: req.user.name,
        role: req.user.role,
        timestamp: new Date(),
        notes: `Photo added: ${photo.filename}`,
      });

      await ticket.save();
      emitSocket(req, 'maintenance:updated', ticket);

      res.status(201).json({ success: true, item: photo });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 15. GET /api/maintenance/tickets/:id/photos/:photoId - Serve Photo Binary ──
  router.get('/tickets/:id/photos/:photoId', async (req, res) => {
    try {
      const { id, photoId } = req.params;
      const query = id.match(/^[0-9a-fA-F]{24}$/) ? { _id: id } : { ticketId: id };
      const ticket = await MaintenanceTicket.findOne(query).lean();

      if (!ticket) {
        return res.status(404).json({ success: false, message: 'Ticket not found' });
      }

      const photo = (ticket.photos || []).find(p => p.photoId === photoId);
      if (!photo) {
        return res.status(404).json({ success: false, message: 'Photo not found' });
      }

      // If stored on disk, stream file
      if (photo.storagePath && fs.existsSync(photo.storagePath)) {
        res.setHeader('Content-Type', photo.contentType || 'image/jpeg');
        res.setHeader('Content-Disposition', `inline; filename="${photo.filename}"`);
        res.setHeader('Cache-Control', 'private, max-age=86400');
        return fs.createReadStream(photo.storagePath).pipe(res);
      }

      // Fallback: If stored in base64 data property
      if (photo.data && photo.data.startsWith('data:')) {
        const match = photo.data.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);
        if (match) {
          const buffer = Buffer.from(match[2], 'base64');
          res.setHeader('Content-Type', match[1]);
          res.setHeader('Content-Disposition', `inline; filename="${photo.filename}"`);
          res.setHeader('Cache-Control', 'private, max-age=86400');
          return res.send(buffer);
        }
      }

      res.status(404).json({ success: false, message: 'Photo content unavailable' });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  return router;
}
