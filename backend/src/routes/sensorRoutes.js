import { Router } from 'express';
import { z } from 'zod';
import { mongoose } from '../config/database.js';
import {
  processSensorIngestion,
  getInMemoryLatestReading,
  getInMemoryLatestRisk,
  getInMemoryHistory,
} from '../services/sensorIngestionService.js';
import { SensorReading, RiskAnalysis } from '../models/index.js';

export function sensorRoutes(config, status, services = {}) {
  const router = Router();

  router.post('/', async (req, res) => {
    try {
      const result = await processSensorIngestion(req.body, {
        config,
        status,
        aiClient: services.aiClient,
        broadcast: services.broadcast,
        emergencyService: services.emergencyService,
        transport: 'http',
      });
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          success: false,
          message: 'Invalid sensor payload',
          errors: error.errors,
        });
      }
      console.error('Sensor ingestion error:', error.message);
      res.status(500).json({
        success: false,
        message: 'Internal server error during sensor ingestion',
      });
    }
  });

  router.get('/info', async (req, res) => {
    try {
      if (services.aiClient?.getMultiLabelInfo) {
        const info = await services.aiClient.getMultiLabelInfo();
        return res.json({ success: true, info });
      }
      res.json({
        success: true,
        info: {
          model_name: 'iot_building_safety_multilabel',
          feature_count: 38,
          target_count: 10,
          status: 'configured',
        },
      });
    } catch (e) {
      res.status(503).json({ success: false, message: 'Model info service unavailable' });
    }
  });

  router.get('/latest', async (req, res) => {
    try {
      const deviceId = req.query.deviceId;
      const deviceFilter = deviceId ? { deviceId } : {};
      let latestReading = null;
      let latestRisk = null;

      const isDbConnected = Boolean(status?.database && mongoose.connection && mongoose.connection.readyState === 1);
      if (isDbConnected) {
        try {
          [latestReading, latestRisk] = await Promise.all([
            SensorReading.findOne(deviceFilter).sort({ receivedAt: -1 }).lean(),
            RiskAnalysis.findOne(deviceFilter).sort({ analyzedAt: -1 }).lean(),
          ]);
        } catch (dbErr) {
          console.warn('Database query error in /sensor/latest, falling back to in-memory:', dbErr.message);
          latestReading = null;
          latestRisk = null;
        }
      }

      if (!latestReading) {
        latestReading = getInMemoryLatestReading(deviceId);
      }
      if (!latestRisk) {
        latestRisk = getInMemoryLatestRisk(deviceId);
      }

      res.json({
        success: true,
        reading: latestReading,
        risk: latestRisk,
        ml: latestRisk?.ml || latestReading?.ml || null,
        source: isDbConnected && latestReading?._id && !String(latestReading._id).startsWith('mem_') ? 'database' : (latestReading ? 'memory' : 'none'),
      });
    } catch (e) {
      console.error('Diagnostic - Error fetching latest sensor data:', e);
      res.status(500).json({ success: false, message: 'Error fetching latest sensor data', error: e.message });
    }
  });

  router.get('/history', async (req, res) => {
    try {
      const deviceId = req.query.deviceId;
      const deviceFilter = deviceId ? { deviceId } : {};
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
      let items = [];

      const isDbConnected = Boolean(status?.database && mongoose.connection && mongoose.connection.readyState === 1);
      if (isDbConnected) {
        try {
          items = await SensorReading.find(deviceFilter)
            .sort({ receivedAt: -1 })
            .limit(limit)
            .lean();
        } catch (dbErr) {
          console.warn('Database query error in /sensor/history, falling back to in-memory:', dbErr.message);
          items = [];
        }
      }

      if (!items || items.length === 0) {
        items = getInMemoryHistory({ deviceId, limit });
      }

      res.json({
        success: true,
        items,
        count: items.length,
      });
    } catch (e) {
      console.error('Diagnostic - Error fetching sensor history:', e);
      res.status(500).json({ success: false, message: 'Error fetching sensor history', error: e.message });
    }
  });

  return router;
}

