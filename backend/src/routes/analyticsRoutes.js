import { Router } from 'express';
import { z } from 'zod';
import { 
  SensorReading, 
  Alert, 
  EmergencyIncident, 
  MaintenanceTicket, 
  RiskAnalysis, 
  Device,
  MaintenanceEvent
} from '../models/index.js';
import { requireToken } from '../middleware/auth.js';

function computeMedian(numbers) {
  if (!numbers.length) return null;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function analyticsRoutes(config, status) {
  const router = Router();

  router.use(requireToken(config));

  // ── 1. GET /api/analytics/historical - Multi-Sensor Time Series Aggregation ──
  router.get('/historical', async (req, res) => {
    try {
      const fromStr = req.query.from || new Date(Date.now() - 7 * 86400000).toISOString();
      const beforeStr = req.query.before || new Date().toISOString();
      const from = new Date(fromStr);
      const before = new Date(beforeStr);
      const deviceId = req.query.deviceId;
      const targetField = req.query.field;

      const match = {
        receivedAt: { $gte: from, $lt: before },
      };
      if (deviceId) match.deviceId = deviceId;

      const diffMs = before - from;
      const bucketMs = diffMs <= 3600000 ? 60000 : diffMs <= 86400000 ? 3600000 : 86400000;

      const unwindMatch = { 'pairs.v': { $type: 'number' } };
      if (targetField) unwindMatch['pairs.k'] = targetField;

      const trendPipeline = [
        { $match: match },
        { $project: { receivedAt: 1, pairs: { $objectToArray: '$sensors' } } },
        { $unwind: '$pairs' },
        { $match: unwindMatch },
        {
          $group: {
            _id: {
              bucket: {
                $subtract: [
                  { $toLong: '$receivedAt' },
                  { $mod: [{ $toLong: '$receivedAt' }, bucketMs] }
                ]
              },
              field: '$pairs.k'
            },
            avgValue: { $avg: '$pairs.v' },
            minValue: { $min: '$pairs.v' },
            maxValue: { $max: '$pairs.v' },
            samples: { $sum: 1 }
          }
        },
        { $sort: { '_id.bucket': 1 } }
      ];

      const trends = await SensorReading.aggregate(trendPipeline);

      res.json({
        success: true,
        from,
        before,
        bucketMs,
        trends: trends.map(t => ({
          time: new Date(t._id.bucket).toISOString(),
          field: t._id.field,
          avg: Math.round(t.avgValue * 100) / 100,
          min: Math.round(t.minValue * 100) / 100,
          max: Math.round(t.maxValue * 100) / 100,
          samples: t.samples,
        })),
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  // ── 2. GET /api/analytics/incidents-summary - Historical Incident Distribution ──
  router.get('/incidents-summary', async (req, res) => {
    try {
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
      const before = req.query.before ? new Date(req.query.before) : new Date();
      const match = { createdAt: { $gte: from, $lt: before } };
      if (req.query.deviceId) match.deviceId = req.query.deviceId;

      const [alerts, bySeverity, byKind, byField] = await Promise.all([
        Alert.find(match).lean(),
        Alert.aggregate([
          { $match: match },
          { $group: { _id: '$severity', count: { $sum: 1 } } }
        ]),
        Alert.aggregate([
          { $match: match },
          { $group: { _id: '$kind', count: { $sum: 1 } } }
        ]),
        Alert.aggregate([
          { $match: match },
          { $group: { _id: '$field', count: { $sum: 1 } } }
        ]),
      ]);

      const severityCounts = { critical: 0, high: 0, warning: 0, info: 0 };
      bySeverity.forEach(s => {
        if (s._id && severityCounts[s._id] !== undefined) severityCounts[s._id] = s.count;
      });

      const kindCounts = {};
      byKind.forEach(k => { if (k._id) kindCounts[k._id] = k.count; });

      const fieldCounts = {};
      byField.forEach(f => { if (f._id) fieldCounts[f._id] = f.count; });

      const unresolvedCount = alerts.filter(a => !a.resolvedAt).length;
      const recurringCount = alerts.filter(a => a.recurrent).length;

      res.json({
        success: true,
        from,
        before,
        totalIncidents: alerts.length,
        unresolvedCount,
        resolvedCount: alerts.length - unresolvedCount,
        recurringCount,
        bySeverity: severityCounts,
        byKind: kindCounts,
        byField: fieldCounts,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 3. GET /api/analytics/device-health - Device Health & Uptime Diagnostics ──
  router.get('/device-health', async (req, res) => {
    try {
      const offlineThresholdSeconds = config.offlineAfterSeconds || 120;
      const now = new Date();
      const offlineCutoff = new Date(now.getTime() - offlineThresholdSeconds * 1000);

      const [devices, recentFaults] = await Promise.all([
        Device.find().lean(),
        MaintenanceEvent.find({ occurredAt: { $gte: new Date(now - 7 * 86400000) } }).lean(),
      ]);

      let onlineCount = 0;
      let offlineCount = 0;
      let staleCount = 0;

      const deviceDiagnostics = devices.map(d => {
        const lastSeen = d.lastSeenAt ? new Date(d.lastSeenAt) : null;
        const isFresh = lastSeen && lastSeen >= offlineCutoff;
        const isExplicitOffline = d.online === false;
        const status = isExplicitOffline ? 'OFFLINE' : isFresh ? 'ONLINE' : 'STALE';

        if (status === 'ONLINE') onlineCount++;
        else if (status === 'OFFLINE') offlineCount++;
        else staleCount++;

        const faultsForDevice = recentFaults.filter(f => f.deviceId === d.deviceId).length;

        return {
          deviceId: d.deviceId,
          name: d.name || d.deviceId,
          buildingId: d.buildingId,
          floorId: d.floorId,
          zoneId: d.zoneId,
          status,
          lastSeenAt: d.lastSeenAt,
          firmwareVersion: d.firmwareVersion || '1.0.0',
          recentFaultsCount: faultsForDevice,
        };
      });

      res.json({
        success: true,
        totalDevices: devices.length,
        onlineCount,
        offlineCount,
        staleCount,
        devices: deviceDiagnostics,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 4. GET /api/analytics/security-summary - Surveillance & Motion Metrics ──
  router.get('/security-summary', async (req, res) => {
    try {
      const from = new Date(Date.now() - 30 * 86400000);
      const securityAlerts = await Alert.find({
        kind: 'security',
        createdAt: { $gte: from },
      }).sort({ createdAt: -1 }).limit(100).lean();

      const zoneAgg = {};
      securityAlerts.forEach(a => {
        const z = a.zoneId || 'Unspecified Zone';
        zoneAgg[z] = (zoneAgg[z] || 0) + 1;
      });

      res.json({
        success: true,
        totalSecurityEvents: securityAlerts.length,
        byZone: zoneAgg,
        recentEvents: securityAlerts.slice(0, 10).map(a => ({
          id: a._id.toString(),
          deviceId: a.deviceId,
          zoneId: a.zoneId,
          message: a.message,
          timestamp: a.observedAt || a.createdAt,
          severity: a.severity,
        })),
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 5. GET /api/analytics/sos-metrics - Emergency MTTA & MTTR Analysis ──
  router.get('/sos-metrics', async (req, res) => {
    try {
      const from = new Date(Date.now() - 90 * 86400000);
      const emergencies = await EmergencyIncident.find({ createdAt: { $gte: from } }).lean();

      const ackLatenciesSec = [];
      const resLatenciesSec = [];
      const delayedIncidents = [];

      for (const e of emergencies) {
        if (e.acknowledgedAt) {
          const ackSec = Math.round((new Date(e.acknowledgedAt) - new Date(e.createdAt)) / 1000);
          ackLatenciesSec.push(ackSec);
          if (ackSec > 300) {
            delayedIncidents.push({
              emergencyId: e.emergencyId,
              buildingId: e.buildingId,
              message: e.message,
              ackDelaySec: ackSec,
              timestamp: e.createdAt,
            });
          }
        }
        if (e.resolvedAt) {
          const resSec = Math.round((new Date(e.resolvedAt) - new Date(e.createdAt)) / 1000);
          resLatenciesSec.push(resSec);
        }
      }

      const avgMtta = ackLatenciesSec.length
        ? Math.round(ackLatenciesSec.reduce((a, b) => a + b, 0) / ackLatenciesSec.length)
        : null;
      const medianMtta = computeMedian(ackLatenciesSec);

      const avgMttr = resLatenciesSec.length
        ? Math.round(resLatenciesSec.reduce((a, b) => a + b, 0) / resLatenciesSec.length)
        : null;
      const medianMttr = computeMedian(resLatenciesSec);

      res.json({
        success: true,
        totalEmergencies: emergencies.length,
        acknowledgedCount: ackLatenciesSec.length,
        resolvedCount: resLatenciesSec.length,
        mtta: {
          averageSeconds: avgMtta,
          medianSeconds: medianMtta,
          formatted: avgMtta ? `${Math.floor(avgMtta / 60)}m ${avgMtta % 60}s` : 'N/A',
        },
        mttr: {
          averageSeconds: avgMttr,
          medianSeconds: medianMttr,
          formatted: avgMttr ? `${Math.floor(avgMttr / 60)}m ${avgMttr % 60}s` : 'N/A',
        },
        delayedResponses: delayedIncidents,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 6. GET /api/analytics/maintenance-metrics - Repair SLA & Turnaround ──
  router.get('/maintenance-metrics', async (req, res) => {
    try {
      const from = new Date(Date.now() - 90 * 86400000);
      const tickets = await MaintenanceTicket.find({ createdAt: { $gte: from } }).lean();

      const assignDurationsHrs = [];
      const repairDurationsHrs = [];

      for (const t of tickets) {
        if (t.assignedTo?.assignedAt) {
          const diff = (new Date(t.assignedTo.assignedAt) - new Date(t.createdAt)) / 3600000;
          if (diff >= 0) assignDurationsHrs.push(diff);
        }
        if (t.completedAt) {
          const diff = (new Date(t.completedAt) - new Date(t.createdAt)) / 3600000;
          if (diff >= 0) repairDurationsHrs.push(diff);
        }
      }

      const avgAssignHours = assignDurationsHrs.length
        ? Math.round((assignDurationsHrs.reduce((a, b) => a + b, 0) / assignDurationsHrs.length) * 10) / 10
        : null;
      const avgRepairHours = repairDurationsHrs.length
        ? Math.round((repairDurationsHrs.reduce((a, b) => a + b, 0) / repairDurationsHrs.length) * 10) / 10
        : null;

      const overdueCount = tickets.filter(t => t.status !== 'verified_closed' && t.status !== 'repair_completed' && new Date(t.dueAt) < new Date()).length;

      // Group tickets by location to highlight repeat issues
      const locationCounts = {};
      tickets.forEach(t => {
        const loc = t.location || t.buildingId || 'General';
        locationCounts[loc] = (locationCounts[loc] || 0) + 1;
      });

      const recurringLocations = Object.entries(locationCounts)
        .filter(([_, count]) => count >= 2)
        .map(([location, count]) => ({ location, ticketCount: count }))
        .sort((a, b) => b.ticketCount - a.ticketCount);

      res.json({
        success: true,
        totalTickets: tickets.length,
        avgAssignmentHours: avgAssignHours,
        avgRepairHours: avgRepairHours,
        overdueCount,
        recurringLocations,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 7. GET /api/analytics/anomalies - Flagged Outliers & Rule Violations ──
  router.get('/anomalies', async (req, res) => {
    try {
      const from = new Date(Date.now() - 30 * 86400000);
      const deviceId = req.query.deviceId;

      const filter = { createdAt: { $gte: from } };
      if (deviceId) filter.deviceId = deviceId;

      const [criticalAlerts, highRiskAnalyses] = await Promise.all([
        Alert.find({ ...filter, severity: { $in: ['high', 'critical'] } })
          .sort({ createdAt: -1 })
          .limit(50)
          .lean(),
        RiskAnalysis.find({ ...filter, classification: { $in: ['HIGH', 'CRITICAL'] } })
          .sort({ analyzedAt: -1 })
          .limit(50)
          .lean(),
      ]);

      const anomalies = [];

      for (const a of criticalAlerts) {
        anomalies.push({
          id: a._id.toString(),
          type: 'incident_rule',
          deviceId: a.deviceId,
          timestamp: a.observedAt || a.createdAt,
          field: a.field,
          severity: a.severity || 'critical',
          source: a.source || 'hardware',
          confidence: a.riskScore ? a.riskScore / 100 : 0.95,
          explanation: a.message,
        });
      }

      for (const r of highRiskAnalyses) {
        if (!anomalies.some(x => x.deviceId === r.deviceId && Math.abs(new Date(x.timestamp) - new Date(r.observedAt)) < 5000)) {
          const topFactor = r.factors?.[0] || {};
          anomalies.push({
            id: r._id.toString(),
            type: 'risk_engine_anomaly',
            deviceId: r.deviceId,
            timestamp: r.observedAt || r.analyzedAt,
            field: topFactor.factor || 'composite',
            severity: r.classification === 'CRITICAL' ? 'critical' : 'warning',
            source: r.source || 'hardware',
            confidence: r.score / 100,
            explanation: topFactor.message || `Composite safety score elevated to ${r.score}/100`,
          });
        }
      }

      anomalies.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      res.json({ success: true, items: anomalies.slice(0, 50), total: anomalies.length });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 8. GET /api/analytics/risk-rankings - Zone and Device Risk Prioritization ──
  router.get('/risk-rankings', async (req, res) => {
    try {
      const from = new Date(Date.now() - 30 * 86400000);

      const [alertsByDevice, alertsByZone] = await Promise.all([
        Alert.aggregate([
          { $match: { createdAt: { $gte: from } } },
          {
            $group: {
              _id: '$deviceId',
              totalIncidents: { $sum: 1 },
              criticalCount: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              warningCount: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
              infoCount: { $sum: { $cond: [{ $in: ['$severity', ['info', null]] }, 1, 0] } },
            }
          },
          { $sort: { criticalCount: -1, totalIncidents: -1 } }
        ]),
        Alert.aggregate([
          { $match: { createdAt: { $gte: from }, zoneId: { $exists: true, $ne: null } } },
          {
            $group: {
              _id: '$zoneId',
              totalIncidents: { $sum: 1 },
              criticalCount: { $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] } },
              warningCount: { $sum: { $cond: [{ $eq: ['$severity', 'warning'] }, 1, 0] } },
            }
          },
          { $sort: { criticalCount: -1, totalIncidents: -1 } }
        ]),
      ]);

      const deviceRankings = alertsByDevice.map(d => {
        const compositeScore = (d.criticalCount * 10) + (d.warningCount * 3) + (d.infoCount * 1);
        const level = d.criticalCount > 0 || compositeScore >= 30 ? 'CRITICAL'
          : compositeScore >= 15 ? 'HIGH'
          : compositeScore >= 5 ? 'MODERATE' : 'LOW';
        return {
          deviceId: d._id,
          totalIncidents: d.totalIncidents,
          criticalCount: d.criticalCount,
          warningCount: d.warningCount,
          compositeScore,
          level,
        };
      });

      const zoneRankings = alertsByZone.map(z => {
        const compositeScore = (z.criticalCount * 10) + (z.warningCount * 3);
        const level = z.criticalCount > 0 || compositeScore >= 30 ? 'CRITICAL'
          : compositeScore >= 15 ? 'HIGH'
          : compositeScore >= 5 ? 'MODERATE' : 'LOW';
        return {
          zoneId: z._id,
          totalIncidents: z.totalIncidents,
          criticalCount: z.criticalCount,
          warningCount: z.warningCount,
          compositeScore,
          level,
        };
      });

      res.json({
        success: true,
        devices: deviceRankings,
        zones: zoneRankings,
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 9. GET /api/analytics/performance - MTTA, MTTR & SLA Overview ──
  router.get('/performance', async (req, res) => {
    try {
      const from = new Date(Date.now() - 30 * 86400000);

      const [emergencies, tickets] = await Promise.all([
        EmergencyIncident.find({ createdAt: { $gte: from } }).lean(),
        MaintenanceTicket.find({ createdAt: { $gte: from } }).lean(),
      ]);

      const acknowledgedEmergencies = emergencies.filter(e => e.acknowledgedAt);
      let totalAckMs = 0;
      for (const e of acknowledgedEmergencies) {
        totalAckMs += (new Date(e.acknowledgedAt) - new Date(e.createdAt));
      }
      const mttaSeconds = acknowledgedEmergencies.length
        ? Math.round(totalAckMs / acknowledgedEmergencies.length / 1000)
        : null;

      const completedTickets = tickets.filter(t => t.completedAt);
      let totalRepairMs = 0;
      for (const t of completedTickets) {
        totalRepairMs += (new Date(t.completedAt) - new Date(t.createdAt));
      }
      const mttrHours = completedTickets.length
        ? Math.round((totalRepairMs / completedTickets.length / 3600000) * 10) / 10
        : null;

      const totalTickets = tickets.length;
      const completedCount = completedTickets.length;
      const completionRate = totalTickets > 0 ? Math.round((completedCount / totalTickets) * 100) : 100;
      const overdueCount = tickets.filter(t => t.status !== 'verified_closed' && t.status !== 'repair_completed' && new Date(t.dueAt) < new Date()).length;

      res.json({
        success: true,
        emergency: {
          total: emergencies.length,
          acknowledgedCount: acknowledgedEmergencies.length,
          mttaSeconds,
          mttaFormatted: mttaSeconds ? `${Math.floor(mttaSeconds / 60)}m ${mttaSeconds % 60}s` : 'N/A',
        },
        maintenance: {
          totalTickets,
          completedCount,
          completionRatePct: completionRate,
          overdueCount,
          mttrHours,
          mttrFormatted: mttrHours ? `${mttrHours} hours` : 'N/A',
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });

  // ── 10. GET /api/analytics/model-status - Real Status of AI/ML Pipeline ──
  router.get('/model-status', async (req, res) => {
    let pythonInfo = null;
    try {
      if (config.aiServiceUrl) {
        const response = await fetch(`${config.aiServiceUrl}/analytics/model-info`, {
          signal: AbortSignal.timeout(3000)
        });
        if (response.ok) {
          pythonInfo = await response.json();
        }
      }
    } catch {}

    res.json({
      success: true,
      serviceUrl: config.aiServiceUrl || 'http://ai_ml:8000',
      activeEngine: pythonInfo?.engine || 'python-statistical-rules-v1',
      modelVersion: pythonInfo?.version || '1.0.0',
      trainedModelLoaded: Boolean(pythonInfo?.loaded),
      futureModelReady: true,
      supportedFrameworks: ['ONNX', 'PyTorch (.pt/.pth)', 'Scikit-Learn (.pkl)'],
      datasetDirectories: {
        raw: 'ai_ml/datasets/raw/',
        processed: 'ai_ml/datasets/processed/',
        samples: 'ai_ml/datasets/samples/',
      },
      modelsDirectories: {
        trained: 'ai_ml/models/trained/',
        artifacts: 'ai_ml/models/artifacts/',
      },
      note: pythonInfo?.loaded 
        ? 'Custom trained model is active and scoring anomalies.' 
        : 'Statistical rule-based engine is active. Directory structure is prepared for future custom model weights and datasets.',
    });
  });

  // ── 11. POST /api/analytics/run-analysis - Trigger Historical Batch Analysis ──
  router.post('/run-analysis', async (req, res) => {
    try {
      const schema = z.object({
        deviceId: z.string().trim().min(1).max(128).optional(),
        field: z.string().trim().default('temperature'),
        hoursBack: z.number().int().min(1).max(720).default(24),
      });
      const body = schema.parse(req.body);

      const since = new Date(Date.now() - body.hoursBack * 3600000);
      const query = { receivedAt: { $gte: since } };
      if (body.deviceId) query.deviceId = body.deviceId;

      const readings = await SensorReading.find(query)
        .sort({ receivedAt: 1 })
        .limit(1000)
        .lean();

      const values = [];
      for (const r of readings) {
        const v = r.sensors?.get ? r.sensors.get(body.field) : r.sensors?.[body.field];
        if (typeof v === 'number') values.push(v);
      }

      if (values.length < 5) {
        return res.json({
          success: true,
          message: 'Insufficient historical data points for statistical analysis (minimum 5 required)',
          count: 0,
          anomalies: [],
        });
      }

      // Compute mean and standard deviation
      const sum = values.reduce((a, b) => a + b, 0);
      const mean = sum / values.length;
      const variance = values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (values.length - 1);
      const std = Math.sqrt(variance);

      const anomalies = [];
      if (std > 0) {
        for (const r of readings) {
          const v = r.sensors?.get ? r.sensors.get(body.field) : r.sensors?.[body.field];
          if (typeof v === 'number') {
            const zscore = (v - mean) / std;
            if (Math.abs(zscore) >= 2.5) {
              anomalies.push({
                deviceId: r.deviceId,
                observedAt: r.observedAt || r.receivedAt,
                field: body.field,
                value: v,
                mean: Math.round(mean * 100) / 100,
                std: Math.round(std * 100) / 100,
                zscore: Math.round(zscore * 100) / 100,
                explanation: `Value ${v} deviates by ${Math.round(zscore * 10) / 10} standard deviations from baseline mean of ${Math.round(mean * 10) / 10}`,
              });
            }
          }
        }
      }

      res.json({
        success: true,
        field: body.field,
        sampleCount: values.length,
        baseline: {
          mean: Math.round(mean * 100) / 100,
          std: Math.round(std * 100) / 100,
        },
        count: anomalies.length,
        anomalies: anomalies.slice(0, 50),
      });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });

  return router;
}
