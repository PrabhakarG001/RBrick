import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { requireToken } from './middleware/auth.js';
import { iotRoutes } from './routes/iotRoutes.js';
import { systemRoutes } from './routes/systemRoutes.js';
import { cameraRoutes } from './routes/cameraRoutes.js';
import { securityRoutes } from './routes/securityRoutes.js';
import { authRoutes } from './routes/authRoutes.js';
import { userRoutes } from './routes/userRoutes.js';
import { emergencyRoutes } from './routes/emergencyRoutes.js';
import { maintenanceRoutes } from './routes/maintenanceRoutes.js';
import { analyticsRoutes } from './routes/analyticsRoutes.js';
import { dashboardRoutes } from './routes/dashboardRoutes.js';
import { sensorRoutes } from './routes/sensorRoutes.js';
import { EmergencyService } from './services/emergencyService.js';
import { SecurityError } from './services/securityService.js';
import { SENSOR_NAMES_LIST, NUMERIC_SENSORS_LIST } from './services/telemetrySchema.js';

export function createApp(config, status, services = {}) {
  const app = express();
  const emergencyService = services.emergencyService || new EmergencyService(status);
  app.disable('x-powered-by');
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });
  app.use(express.json({ limit: '10mb' }));
  app.get('/api/health/live', (req, res) => res.json({ success: true, status: 'alive' }));
  app.get('/api/health/ready', (req, res) => {
    const aiRequired = config.mqttEnabled && config.payloadFormat === 'resilliox-v1';
    const ready = status.database && (!config.mqttEnabled || status.mqtt) && (!aiRequired || status.ai === true) && config.apiToken.length >= 32;
    res.status(ready ? 200 : 503).json({ success: Boolean(ready), database: status.database ? 'connected' : 'unavailable',
      mqtt: config.mqttEnabled ? (status.mqtt ? 'subscribed' : 'unavailable') : 'disabled',
      ai: aiRequired ? (status.ai === true ? 'available' : status.ai === false ? 'unavailable' : 'unknown') : 'not_required',
      authentication: config.apiToken.length >= 32 ? 'configured' : 'not_configured',
      databaseError: status.database ? null : (status.databaseFailure || 'not_connected') });
  });
  app.get('/api/iot/status', requireToken(config), (req, res) => res.json({ success: true,
    ai: { available: status.ai ?? null, modelVersion: 'python-rules-v1', lastError: status.aiLastError ?? null },
    database: status.database ? 'connected' : 'unavailable',
    mqtt: config.mqttEnabled ? (status.mqtt ? 'subscribed' : 'unavailable') : 'disabled',
    databaseError: status.database ? null : (status.databaseFailure || 'not_connected'),
    fields: config.contract.fields, display: config.contract.display, rules: config.contract.rules,
    offlineAfterSeconds: config.offlineAfterSeconds,
    // v1 dashboard needs the fixed sensor vocabulary when no flat display
    // mapping is configured. Names come from the shared schema, never guessed.
    payloadFormat: config.payloadFormat,
    v1Sensors: config.payloadFormat === 'resilliox-v1'
      ? SENSOR_NAMES_LIST.map(name => ({ name, kind: NUMERIC_SENSORS_LIST.includes(name) ? 'number' : 'boolean' }))
      : [],
  }));
  // Phase 6 system endpoints. /api/health is public; everything else under
  // /api/devices, /api/readings, /api/alerts, /api/system requires the same
  // operator token and a connected database (handled inside systemRoutes
  // callers via the shared status object).
  app.use('/api', systemRoutes(config, status));
  const databaseRequired = (req, res, next) => {
    if (!status.database) return res.status(503).json({ success: false, message: 'Atlas database unavailable' });
    next();
  };
  // Module 6: Authentication & User Management
  app.use('/api/auth', authRoutes(config, status));
  app.use('/api/users', databaseRequired, userRoutes(config));

  // Module 3: SOS & Emergency Response
  app.use('/api/emergency', databaseRequired, emergencyRoutes(config, emergencyService));
  app.use('/api/sos', databaseRequired, emergencyRoutes(config, emergencyService));

  // Module 4: Maintenance Management
  app.use('/api/maintenance', databaseRequired, maintenanceRoutes(config));

  // Module 5: Historical Analytics & AI/ML
  app.use('/api/analytics', databaseRequired, analyticsRoutes(config, status));

  // Module 6: Central Dashboard & Cross-Module Summaries
  app.use('/api/dashboard', databaseRequired, dashboardRoutes(config, status));

  // Camera routes mount first so /api/iot/cameras/* is not shadowed by the
  // generic /api/iot router. Both share token + database guards.
  app.use('/api/iot/cameras', requireToken(config), databaseRequired, cameraRoutes(config, status));
  app.use('/api/iot', requireToken(config), databaseRequired, iotRoutes(config, status));
  app.use('/api/security', securityRoutes(config, status));
  // Shared ESP32 sensor ingestion endpoint (compatible with firmware HTTP POST /sensor)
  app.use('/sensor', sensorRoutes(config, status, services));
  app.use('/api/sensor', sensorRoutes(config, status, services));
  app.use((req, res) => res.status(404).json({ success: false, message: 'Endpoint not implemented by the IoT API' }));
  app.use((error, req, res, next) => {
    if(error instanceof SecurityError)return res.status(error.status).json({success:false,message:error.message});
    if(error.code===11000)return res.status(409).json({success:false,message:'Record already exists or action conflicts with current state'});
    if (error instanceof z.ZodError || error.type === 'entity.parse.failed') {
      return res.status(400).json({ success: false, message: 'Invalid request' });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ success: false, message: 'Request too large' });
    console.error(`API operation failed (${error.name || 'Error'}; details omitted)`);
    res.status(503).json({ success: false, message: 'Operation unavailable; check database connectivity' });
  });
  return app;
}
