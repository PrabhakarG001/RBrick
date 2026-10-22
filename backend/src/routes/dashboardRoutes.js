import { Router } from 'express';
import { mongoose } from '../config/database.js';
import { 
  Device, 
  Alert, 
  EmergencyIncident, 
  MaintenanceTicket, 
  RiskAnalysis,
  User 
} from '../models/index.js';
import { SecurityEvent } from '../models/security.js';
import { requireToken } from '../middleware/auth.js';

export function dashboardRoutes(config, status) {
  const router = Router();

  router.use(requireToken(config));

  // ── 1. GET /api/dashboard/summary - Multi-Module High-Level Aggregation ──
  router.get('/summary', async (req, res) => {
    try {
      const offlineSeconds = config.offlineAfterSeconds || 120;
      const now = new Date();
      const cutoff = new Date(now.getTime() - offlineSeconds * 1000);
      const past24h = new Date(now.getTime() - 24 * 3600 * 1000);

      let devices = [];
      let activeAlerts = 0;
      let criticalAlerts = 0;
      let unackAlerts = 0;
      let activeEmergencies = [];
      let tickets = [];
      let securityEventsCount = 0;
      let recentRisk = null;

      if (mongoose.connection?.readyState === 1) {
        [
          devices,
          activeAlerts,
          criticalAlerts,
          unackAlerts,
          activeEmergencies,
          tickets,
          securityEventsCount,
          recentRisk
        ] = await Promise.all([
          Device.find().lean().catch(() => []),
          Alert.countDocuments({ resolvedAt: null, kind: { $ne: 'security' } }).catch(() => 0),
          Alert.countDocuments({ resolvedAt: null, severity: 'critical', kind: { $ne: 'security' } }).catch(() => 0),
          Alert.countDocuments({ resolvedAt: null, acknowledgedAt: null, kind: { $ne: 'security' } }).catch(() => 0),
          EmergencyIncident.find({ status: { $ne: 'resolved' } }).lean().catch(() => []),
          MaintenanceTicket.find().lean().catch(() => []),
          SecurityEvent.countDocuments({ timestamp: { $gte: past24h } }).catch(() => 0),
          RiskAnalysis.findOne().sort({ analyzedAt: -1 }).lean().catch(() => null),
        ]);
      }

      // Hardware health classification
      let onlineDevices = 0;
      let offlineDevices = 0;
      let staleDevices = 0;

      for (const d of devices) {
        const lastSeen = d.lastSeenAt ? new Date(d.lastSeenAt) : null;
        if (d.online === false) {
          offlineDevices++;
        } else if (lastSeen && lastSeen >= cutoff) {
          onlineDevices++;
        } else {
          staleDevices++;
        }
      }

      // Overall building status calculation
      let overallBuildingStatus = 'NORMAL';
      if (activeEmergencies.length > 0 || criticalAlerts > 0) {
        overallBuildingStatus = 'CRITICAL';
      } else if (activeAlerts > 0 || offlineDevices > 0 || staleDevices > 0) {
        overallBuildingStatus = 'WARNING';
      }

      // Maintenance breakdown
      const openTickets = tickets.filter(t => t.status !== 'verified_closed');
      const inProgressTickets = tickets.filter(t => t.status === 'in_progress').length;
      const repairCompletedTickets = tickets.filter(t => t.status === 'repair_completed').length;
      const overdueTickets = openTickets.filter(t => t.dueAt && new Date(t.dueAt) < now).length;

      // Emergency breakdown
      const unackEmergencies = activeEmergencies.filter(e => e.status === 'active').length;
      const buzzerActiveCount = activeEmergencies.filter(e => e.buzzerState === 'active').length;

      res.json({
        success: true,
        building: {
          status: overallBuildingStatus,
          registeredDevices: devices.length,
          onlineDevices,
          offlineDevices,
          staleDevices,
          healthSummary: `${onlineDevices}/${devices.length} Online (${staleDevices} Stale, ${offlineDevices} Offline)`,
        },
        safety: {
          activeAlerts,
          criticalAlerts,
          unacknowledgedAlerts: unackAlerts,
          hasActiveHazards: activeAlerts > 0,
        },
        emergency: {
          activeCount: activeEmergencies.length,
          unacknowledgedCount: unackEmergencies,
          buzzerActiveCount,
          hasCriticalEmergency: activeEmergencies.length > 0,
        },
        maintenance: {
          totalTickets: tickets.length,
          openTickets: openTickets.length,
          inProgressTickets,
          repairCompletedTickets,
          overdueTickets,
        },
        security: {
          eventsLast24h: securityEventsCount,
        },
        analytics: {
          activeEngine: recentRisk?.engineVersion || 'python-rules-v1',
          latestRiskScore: recentRisk?.score ?? 0,
          highestRiskLevel: recentRisk?.classification || 'NORMAL',
        },
        currentUser: {
          userId: req.user.userId,
          name: req.user.name,
          role: req.user.role,
          permissions: req.user.permissions || [],
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 2. GET /api/dashboard/activity - Unified Cross-Module Activity Stream ──
  router.get('/activity', async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

      let alerts = [];
      let emergencies = [];
      let tickets = [];
      let securityEvents = [];

      if (mongoose.connection?.readyState === 1) {
        [alerts, emergencies, tickets, securityEvents] = await Promise.all([
          Alert.find().sort({ createdAt: -1 }).limit(limit).lean().catch(() => []),
          EmergencyIncident.find().sort({ updatedAt: -1 }).limit(limit).lean().catch(() => []),
          MaintenanceTicket.find().sort({ updatedAt: -1 }).limit(limit).lean().catch(() => []),
          SecurityEvent.find().sort({ timestamp: -1 }).limit(limit).lean().catch(() => []),
        ]);
      }

      const feed = [];

      // 1. Safety Alert Events
      for (const a of alerts) {
        feed.push({
          id: `alert_${a._id}`,
          module: 'safety',
          title: a.message || `Hazard on ${a.deviceId}`,
          description: `Sensor: ${a.field} | Severity: ${a.severity || 'warning'}`,
          severity: a.severity || 'warning',
          timestamp: a.observedAt || a.createdAt,
          actor: a.source || 'hardware_node',
          role: 'sensor',
          link: '/incidents',
        });
      }

      // 2. SOS Emergency Events & Timeline
      for (const e of emergencies) {
        for (const t of (e.timeline || [])) {
          feed.push({
            id: `sos_${e.emergencyId}_${t.action}_${new Date(t.timestamp).getTime()}`,
            module: 'emergency',
            title: `SOS ${t.action.toUpperCase()}: ${e.buildingId} ${e.room ? `Rm ${e.room}` : ''}`,
            description: t.notes || e.message,
            severity: 'critical',
            timestamp: t.timestamp,
            actor: t.actor,
            role: t.role,
            link: '/incidents',
          });
        }
      }

      // 3. Maintenance Ticket History
      for (const m of tickets) {
        for (const h of (m.history || [])) {
          feed.push({
            id: `maint_${m.ticketId}_${h.action}_${new Date(h.timestamp).getTime()}`,
            module: 'maintenance',
            title: `[${m.ticketId}] ${h.action.replace(/_/g, ' ').toUpperCase()}`,
            description: h.notes || m.title,
            severity: m.priority === 'critical' ? 'critical' : m.priority === 'high' ? 'warning' : 'info',
            timestamp: h.timestamp,
            actor: h.actor,
            role: h.role,
            link: '/maintenance',
          });
        }
      }

      // 4. Security Events (if permitted for role)
      if (['security_guard', 'facility_manager', 'admin'].includes(req.user.role)) {
        for (const s of securityEvents) {
          feed.push({
            id: `sec_${s._id || s.eventId}`,
            module: 'security',
            title: `Security Event: ${s.type?.replace(/_/g, ' ') || 'Motion'}`,
            description: s.description || `Zone: ${s.zoneId}`,
            severity: s.severity || 'info',
            timestamp: s.timestamp || s.occurredAt || s.createdAt,
            actor: s.deviceId || 'Sensor',
            role: 'security_device',
            link: '/security',
          });
        }
      }

      // Sort combined feed descending by timestamp
      feed.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.json({
        success: true,
        items: feed.slice(0, limit),
        total: feed.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 3. GET /api/dashboard/module-access - Role-Specific Capability Map ──
  router.get('/module-access', (req, res) => {
    const role = req.user.role || 'student';
    const isAdmin = role === 'admin';
    const isManager = ['facility_manager', 'admin'].includes(role);
    const isGuard = ['security_guard', 'admin'].includes(role);
    const isStaff = ['maintenance_staff', 'facility_manager', 'admin'].includes(role);

    res.json({
      success: true,
      role,
      modules: {
        building_condition: true,
        security: isGuard || isManager,
        emergency: true,
        maintenance: true,
        analytics: isManager || isGuard || isStaff,
        user_management: isAdmin,
      },
      capabilities: {
        canTriggerEmergency: true,
        canAcknowledgeEmergency: isGuard || isManager,
        canResolveEmergency: isManager,
        canToggleBuzzer: isGuard || isManager,
        canReportMaintenance: true,
        canAssignMaintenance: isManager,
        canPerformMaintenance: isStaff,
        canVerifyMaintenance: isManager,
        canReopenMaintenance: isManager,
        canManageUsers: isAdmin,
        canAccessCameraSnapshots: isGuard || isManager,
        canConfigureSettings: isAdmin,
      }
    });
  });

  return router;
}
