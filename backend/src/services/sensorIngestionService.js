import { z } from 'zod';
import { mongoose } from '../config/database.js';
import { SensorReading, Alert, Device, RiskAnalysis } from '../models/index.js';
import { AiServiceError } from './aiServiceClient.js';

// The exact 38 model feature names from iot_building_safety_multilabel.joblib
export const MODEL_FEATURE_NAMES = [
  'zone_id', 'monitoring_role', 'zone_restricted', 'is_after_hours', 'authorized_access_window',
  'mpu_ax_g', 'mpu_ay_g', 'mpu_az_g', 'mpu_accel_magnitude_g', 'mpu_accel_delta_from_baseline_g',
  'mpu_gx_dps', 'mpu_gy_dps', 'mpu_gz_dps', 'mpu_gyro_magnitude_dps',
  'sw420_digital_state', 'sw420_pulse_count_10s', 'vibration_duration_s',
  'temperature_c', 'humidity_rh_pct', 'humidity_high_duration_min',
  'mq2_adc_raw_0_4095', 'mq2_baseline_adc', 'mq2_delta_from_baseline_pct',
  'pir_motion_detected', 'flame_detected_normalized', 'flame_adc_raw_0_4095',
  'esp32_cam_frame_ok', 'camera_motion_score_0_100', 'camera_person_confidence_0_100',
  'camera_smoke_confidence_0_100', 'camera_flame_confidence_0_100',
  'esp32_3v3_rail_v', 'esp32_board_temp_c',
  'wifi_rssi_dbm', 'packet_loss_pct', 'mqtt_latency_ms',
  'sensor_read_fail_count', 'sensor_values_stale_sec'
];

export const MODEL_TARGET_NAMES = [
  'event_fire_suspected',
  'event_smoke_suspected',
  'event_combustible_gas_suspected',
  'event_unauthorized_intrusion',
  'event_vibration_anomaly',
  'event_structural_vibration_review',
  'event_heat_risk',
  'event_high_humidity_mold_risk',
  'event_device_fault',
  'event_network_degradation'
];

// In-memory telemetry cache for real-time reads when MongoDB is unavailable/disconnected
const inMemoryReadings = [];
const inMemoryLatestPerDevice = new Map();
const inMemoryLatestRiskPerDevice = new Map();

export function getInMemoryLatestReading(deviceId) {
  if (deviceId) return inMemoryLatestPerDevice.get(deviceId) || null;
  return inMemoryReadings[0] || null;
}

export function getInMemoryLatestRisk(deviceId) {
  if (deviceId) return inMemoryLatestRiskPerDevice.get(deviceId) || null;
  const values = Array.from(inMemoryLatestRiskPerDevice.values());
  return values[values.length - 1] || null;
}

export function getInMemoryHistory({ deviceId, limit = 30 } = {}) {
  let list = inMemoryReadings;
  if (deviceId) {
    list = list.filter(r => r.deviceId === deviceId);
  }
  return list.slice(0, limit);
}

// ESP32 input payload validation schema
const booleanOrBinary = z.union([
  z.boolean(),
  z.number().int().min(0).max(1),
  z.literal('0'),
  z.literal('1'),
  z.literal('true'),
  z.literal('false'),
]);

const numericOrNull = z.union([
  z.number().finite(),
  z.null(),
]);

export const esp32PayloadSchema = z.object({
  building: z.string().trim().max(128).optional(),
  area: z.string().trim().max(128).optional(),
  deviceId: z.string().trim().max(128).optional(),
  device_id: z.string().trim().max(128).optional(),
  messageId: z.string().trim().max(128).optional(),
  message_id: z.string().trim().max(128).optional(),
  timestamp: z.string().optional(),
  source: z.enum(['hardware', 'simulation']).optional(),
  // Actual measured sensor readings from ESP32
  temperature: numericOrNull.optional(),
  humidity: numericOrNull.optional(),
  gas_value: numericOrNull.optional(),
  fire: z.union([z.enum(['DANGER', 'SAFE']), booleanOrBinary]).nullable().optional(),
  motion: z.union([z.enum(['DETECTED', 'NONE']), booleanOrBinary]).nullable().optional(),
  wifi_rssi: numericOrNull.optional(),
  sos: booleanOrBinary.nullable().optional(),
  // Hardware status and existing local rule flags (not model inputs)
  smoke: z.union([z.enum(['HIGH', 'NORMAL']), booleanOrBinary]).nullable().optional(),
  vibration: z.union([z.enum(['DETECTED', 'NORMAL']), z.boolean(), z.number().finite()]).nullable().optional(),
  tilt: numericOrNull.optional(),
  mpu_connected: booleanOrBinary.nullable().optional(),
  alarm: z.union([z.enum(['NORMAL', 'FIRE', 'GAS', 'MOTION', 'VIBRATION', 'SOS']), booleanOrBinary]).nullable().optional(),
  buzzer_on: booleanOrBinary.nullable().optional(),
}).passthrough();

/**
 * Validates the raw ESP32 payload against the schema.
 */
export function validateEsp32Payload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    throw new z.ZodError([{ code: 'custom', message: 'Payload must be a JSON object', path: [] }]);
  }
  return esp32PayloadSchema.parse(rawPayload);
}

/**
 * Maps honest sensor measurements from ESP32 payload to ML feature names.
 * Does not fabricate missing values, does not replace missing readings with zero,
 * and tracks exactly which features are supplied vs missing.
 */
export function adaptEsp32Features(payload) {
  const features = {};
  const supplied = [];

  // 1. Context: zone_id from area
  if (payload.area != null && String(payload.area).trim() !== '') {
    features.zone_id = String(payload.area).trim();
    supplied.push('zone_id');
  }

  // 2. Temperature: temperature -> temperature_c
  if (typeof payload.temperature === 'number' && Number.isFinite(payload.temperature)) {
    features.temperature_c = payload.temperature;
    supplied.push('temperature_c');
  }

  // 3. Humidity: humidity -> humidity_rh_pct
  if (typeof payload.humidity === 'number' && Number.isFinite(payload.humidity)) {
    features.humidity_rh_pct = payload.humidity;
    supplied.push('humidity_rh_pct');
  }

  // 4. Gas: gas_value -> mq2_adc_raw_0_4095
  if (typeof payload.gas_value === 'number' && Number.isFinite(payload.gas_value)) {
    features.mq2_adc_raw_0_4095 = payload.gas_value;
    supplied.push('mq2_adc_raw_0_4095');
  }

  // 5. Motion: motion ("DETECTED" / "NONE" / boolean / binary) -> pir_motion_detected (0 or 1)
  if (payload.motion !== undefined && payload.motion !== null) {
    if (payload.motion === 'DETECTED' || payload.motion === true || payload.motion === 1 || payload.motion === '1' || payload.motion === 'true') {
      features.pir_motion_detected = 1;
      supplied.push('pir_motion_detected');
    } else if (payload.motion === 'NONE' || payload.motion === false || payload.motion === 0 || payload.motion === '0' || payload.motion === 'false') {
      features.pir_motion_detected = 0;
      supplied.push('pir_motion_detected');
    } else {
      throw new z.ZodError([{ code: 'custom', message: `Invalid motion value: '${payload.motion}'. Expected 'DETECTED' or 'NONE'`, path: ['motion'] }]);
    }
  }

  // 6. Fire: fire ("DANGER" / "SAFE" / boolean / binary) -> flame_detected_normalized (0.0 or 1.0)
  if (payload.fire !== undefined && payload.fire !== null) {
    if (payload.fire === 'DANGER' || payload.fire === true || payload.fire === 1 || payload.fire === '1' || payload.fire === 'true') {
      features.flame_detected_normalized = 1.0;
      supplied.push('flame_detected_normalized');
    } else if (payload.fire === 'SAFE' || payload.fire === false || payload.fire === 0 || payload.fire === '0' || payload.fire === 'false') {
      features.flame_detected_normalized = 0.0;
      supplied.push('flame_detected_normalized');
    } else {
      throw new z.ZodError([{ code: 'custom', message: `Invalid fire value: '${payload.fire}'. Expected 'DANGER' or 'SAFE'`, path: ['fire'] }]);
    }
  }

  // 7. Network: wifi_rssi -> wifi_rssi_dbm
  if (typeof payload.wifi_rssi === 'number' && Number.isFinite(payload.wifi_rssi)) {
    features.wifi_rssi_dbm = payload.wifi_rssi;
    supplied.push('wifi_rssi_dbm');
  }

  // Independent SOS emergency override check
  const sosPressed = Boolean(
    payload.sos === true || payload.sos === 1 || payload.sos === '1' || payload.sos === 'true'
  );
  features.sos_button_pressed = sosPressed ? 1 : 0;

  // Compute coverage against all 38 model features
  const suppliedSet = new Set(supplied);
  const missing = MODEL_FEATURE_NAMES.filter(f => !suppliedSet.has(f));
  const suppliedCount = supplied.length;
  const totalCount = MODEL_FEATURE_NAMES.length;
  const coveragePct = Math.round((suppliedCount / totalCount) * 1000) / 10;

  const sensorCoverage = {
    suppliedCount,
    totalCount,
    missingCount: missing.length,
    coveragePct,
    suppliedFeatures: supplied,
    missingFeatures: missing,
    coverageStatus: missing.length === 0 ? 'full' : 'reduced',
    note: missing.length > 0
      ? `ESP32 firmware provides partial sensor coverage (${suppliedCount}/${totalCount} features, ${coveragePct}%). Absent features (raw MPU axes, gyro, SW420, gas baseline, camera, electrical rails) are imputed via model pipeline.`
      : 'Full sensor coverage.'
  };

  return {
    features,
    suppliedFeatures: supplied,
    missingFeatures: missing,
    sosPressed,
    sensorCoverage,
  };
}

/**
 * Shared ingestion, normalization, inference and persistence logic.
 * Called by both HTTP POST /sensor and the MQTT subscriber.
 */
export async function processSensorIngestion(rawPayload, options = {}) {
  const {
    config = {},
    status = {},
    aiClient = null,
    broadcast = () => {},
    emergencyService = null,
    transport = 'http',
  } = options;

  // 1. Validation
  const validated = validateEsp32Payload(rawPayload);

  // 2. Feature Adaptation & Missing Feature Accounting
  const adaptation = adaptEsp32Features(validated);
  const { features, sosPressed, sensorCoverage } = adaptation;

  // 3. Identity and timing
  const buildingId = validated.building || 'building-1';
  const zoneId = validated.area || 'zone-1';
  const deviceId = validated.deviceId || validated.device_id || `esp32_${buildingId}_${zoneId}`.replace(/[^A-Za-z0-9_:.-]/g, '_');
  const messageId = validated.messageId || validated.message_id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const observedAt = validated.timestamp ? new Date(validated.timestamp) : new Date();
  const source = validated.source || 'hardware';
  const now = new Date();

  // 4. Hardware/firmware status fields (kept distinct from ML inputs/outputs)
  const firmwareStatus = {
    smoke_flag: validated.smoke ?? null,
    alarm_active: validated.alarm ?? null,
    buzzer_active: validated.buzzer_on ?? null,
    mpu_connected: validated.mpu_connected ?? null,
    tilt: validated.tilt ?? null,
    vibration_raw: validated.vibration ?? null,
  };

  // 5. Independent SOS Safety Override
  let sosIncident = null;
  if (sosPressed) {
    if (emergencyService && typeof emergencyService.triggerEmergency === 'function') {
      try {
        sosIncident = await emergencyService.triggerEmergency({
          deviceId,
          buildingId,
          zoneId,
          message: 'Hardware emergency SOS button triggered on ESP32 device',
          severity: 'critical',
          source,
        });
      } catch (err) {
        console.warn('EmergencyService trigger error (non-fatal):', err.message);
      }
    }
    broadcast('sos_event', {
      deviceId,
      buildingId,
      zoneId,
      message: 'Emergency SOS button pressed on device',
      observedAt: observedAt.toISOString(),
      source,
    });
  }

  // 6. ML Inference via existing model interface
  let mlPredictions = null;
  let analysisStatus = 'unavailable';
  let analysisError = null;

  if (aiClient && typeof aiClient.predictMultiLabel === 'function') {
    try {
      const mlRaw = await aiClient.predictMultiLabel(features);
      if (mlRaw && mlRaw.predicted_labels) {
        mlPredictions = {
          modelVersion: mlRaw.model_version || 'iot-building-safety-multilabel-v1.0.0',
          predictedLabels: mlRaw.predicted_labels,
          predictions: mlRaw.predicted_labels,
          probabilities: mlRaw.probabilities,
          thresholdsUsed: mlRaw.thresholds_used,
          thresholds: mlRaw.thresholds_used,
          activeEvents: mlRaw.active_events || [],
          activeEventCount: mlRaw.active_event_count || 0,
          emergencyOverride: mlRaw.emergency_override || sosPressed,
          sosTriggered: mlRaw.sos_triggered || sosPressed,
          sensorCoverage,
          disclaimer: mlRaw.disclaimer || 'Simulated synthetic sensor dataset only; not validated against physical hardware.',
        };
        analysisStatus = 'complete';
      }
    } catch (err) {
      if (err instanceof AiServiceError) {
        analysisError = err.code;
      } else {
        analysisError = 'unavailable';
      }
      console.warn(`ML multi-label inference unavailable for device ${deviceId} (${analysisError})`);
    }
  } else {
    analysisError = 'client_not_configured';
  }

  // Determine overall classification and score
  const activeCount = mlPredictions?.activeEventCount ?? 0;
  const classification = sosPressed ? 'CRITICAL'
    : (activeCount >= 2 ? 'CRITICAL' : activeCount === 1 ? 'HIGH' : 'NORMAL');
  const score = sosPressed ? 100 : Math.min(100, activeCount * 40);

  // 7. Persistence (if MongoDB connected)
  let savedReadingId = null;
  const isDbConnected = Boolean(mongoose.connection && mongoose.connection.readyState === 1);

  if (isDbConnected) {
    try {
      const [savedReading] = await SensorReading.create([{
        deviceId,
        eventId: messageId,
        observedAt,
        receivedAt: now,
        sensors: {
          temperature: validated.temperature ?? null,
          humidity: validated.humidity ?? null,
          gas_value: validated.gas_value ?? null,
          fire: validated.fire ?? null,
          motion: validated.motion ?? null,
          wifi_rssi: validated.wifi_rssi ?? null,
          sos: validated.sos ?? null,
          smoke: validated.smoke ?? null,
          vibration: validated.vibration ?? null,
          tilt: validated.tilt ?? null,
          mpu_connected: validated.mpu_connected ?? null,
          alarm: validated.alarm ?? null,
          buzzer_on: validated.buzzer_on ?? null,
        },
        topic: transport === 'mqtt' ? (config.mqttTopic || 'resilliox/sensor') : 'http/sensor',
        buildingId,
        zoneId,
        source,
        analysisStatus,
        analysisError,
        ml: mlPredictions,
      }]);
      savedReadingId = savedReading._id;

      // Persist RiskAnalysis if ML succeeded or SOS pressed
      if (mlPredictions || sosPressed) {
        await RiskAnalysis.create([{
          deviceId,
          messageId,
          readingId: savedReadingId,
          observedAt,
          analyzedAt: now,
          score,
          classification,
          factors: (mlPredictions?.activeEvents || []).map(ev => ({
            factor: ev,
            contribution: 35,
            message: `Predicted event: ${ev.replace(/^event_/, '').replace(/_/g, ' ')}`,
            probability: mlPredictions.probabilities[ev],
          })),
          features: new Map(Object.entries(features)),
          modelVersion: mlPredictions?.modelVersion || 'iot-building-safety-multilabel-v1.0.0',
          engineVersion: '1.0.0',
          stale: false,
          zoneId,
          source,
          ml: mlPredictions,
        }]);
      }

      // If SOS pressed, persist critical Alert
      if (sosPressed) {
        await Alert.create([{
          deviceId,
          readingId: savedReadingId,
          kind: 'sos',
          field: 'sos',
          message: 'Physical SOS button pressed on device',
          observedAt,
          zoneId,
          incidentId: `${deviceId}:sos:${messageId}`,
          source,
          severity: 'critical',
          riskScore: 100,
          riskClassification: 'CRITICAL',
          recurrent: false,
        }]);
      }

      // If ML detected critical events, persist alerts
      if (mlPredictions && mlPredictions.activeEvents.length > 0) {
        const alertDocs = mlPredictions.activeEvents.map(eventKey => ({
          deviceId,
          readingId: savedReadingId,
          kind: 'safety',
          field: eventKey,
          message: `ML model detected: ${eventKey.replace(/^event_/, '').replace(/_/g, ' ')}`,
          observedAt,
          zoneId,
          incidentId: `${deviceId}:${eventKey}:${messageId}`,
          source,
          severity: eventKey.includes('fire') || eventKey.includes('gas') ? 'critical' : 'warning',
          riskScore: score,
          riskClassification: classification,
          recurrent: false,
        }));
        await Alert.insertMany(alertDocs);
      }

      // Update Device status
      await Device.updateOne({ deviceId }, {
        $max: { lastSeenAt: now },
        $set: {
          online: true,
          buildingId,
          zoneId,
          area: validated.area || undefined,
        }
      }, { upsert: true });

      if (status) {
        status.persisted = (status.persisted || 0) + 1;
      }
    } catch (dbErr) {
      console.warn('MongoDB persistence error in sensor ingestion (non-fatal):', dbErr.message);
      if (status) {
        status.persistenceFailures = (status.persistenceFailures || 0) + 1;
      }
    }
  }

  // 7b. In-memory cache update (guarantees latest and history reads work even without DB)
  const inMemReading = {
    _id: `mem_${messageId}`,
    deviceId,
    eventId: messageId,
    observedAt,
    receivedAt: now,
    sensors: {
      temperature: validated.temperature ?? null,
      humidity: validated.humidity ?? null,
      gas_value: validated.gas_value ?? null,
      fire: validated.fire ?? null,
      motion: validated.motion ?? null,
      wifi_rssi: validated.wifi_rssi ?? null,
      sos: validated.sos ?? null,
      smoke: validated.smoke ?? null,
      vibration: validated.vibration ?? null,
      tilt: validated.tilt ?? null,
      mpu_connected: validated.mpu_connected ?? null,
      alarm: validated.alarm ?? null,
      buzzer_on: validated.buzzer_on ?? null,
    },
    topic: transport === 'mqtt' ? (config.mqttTopic || 'resilliox/sensor') : 'http/sensor',
    buildingId,
    zoneId,
    source,
    analysisStatus,
    analysisError,
    ml: mlPredictions,
  };
  inMemoryReadings.unshift(inMemReading);
  if (inMemoryReadings.length > 100) inMemoryReadings.pop();
  inMemoryLatestPerDevice.set(deviceId, inMemReading);

  if (mlPredictions || sosPressed) {
    const inMemRisk = {
      _id: `mem_risk_${messageId}`,
      deviceId,
      messageId,
      observedAt,
      analyzedAt: now,
      score,
      classification,
      factors: (mlPredictions?.activeEvents || []).map(ev => ({
        factor: ev,
        contribution: 35,
        message: `Predicted event: ${ev.replace(/^event_/, '').replace(/_/g, ' ')}`,
        probability: mlPredictions.probabilities?.[ev],
      })),
      features: features,
      modelVersion: mlPredictions?.modelVersion || 'iot-building-safety-multilabel-v1.0.0',
      stale: false,
      zoneId,
      source,
      ml: mlPredictions,
    };
    inMemoryLatestRiskPerDevice.set(deviceId, inMemRisk);
  }

  // 8. Real-time broadcasts
  broadcast('sensor_update', {
    deviceId,
    zoneId,
    buildingId,
    messageId,
    observedAt: observedAt.toISOString(),
    receivedAt: now.toISOString(),
    source,
    sensors: {
      temperature: validated.temperature ?? null,
      humidity: validated.humidity ?? null,
      gas_value: validated.gas_value ?? null,
      fire: validated.fire ?? null,
      motion: validated.motion ?? null,
      wifi_rssi: validated.wifi_rssi ?? null,
      sos: validated.sos ?? null,
    },
    analysisStatus,
  });

  if (mlPredictions) {
    broadcast('risk_update', {
      deviceId,
      zoneId,
      messageId,
      score,
      classification,
      source,
      modelVersion: mlPredictions.modelVersion,
      analyzedAt: now.toISOString(),
      ml: mlPredictions,
    });
  }

  broadcast('device_status', {
    deviceId,
    zoneId,
    state: 'online',
    online: true,
    at: Date.now(),
  });

  // 9. Standardized Response
  return {
    success: true,
    status: analysisStatus === 'complete' ? 'processed' : 'partial',
    deviceId,
    building: buildingId,
    area: zoneId,
    messageId,
    transport,
    emergency_override: sosPressed || Boolean(mlPredictions?.emergencyOverride),
    sos_triggered: sosPressed,
    firmware_status: firmwareStatus,
    sensor_coverage: sensorCoverage,
    ml_predictions: mlPredictions,
    ml_error: analysisError,
    classification,
    score,
    observedAt: observedAt.toISOString(),
  };
}

/**
 * Creates an MQTT subscriber for ESP32 sensor topics using the shared ingestion logic.
 */
export function createEsp32MqttSubscriber(config, status, deps = {}) {
  const {
    connect = null,
    processPayload = processSensorIngestion,
    aiClient = null,
    broadcast = () => {},
    emergencyService = null,
  } = deps;

  const mqttUrl = process.env.ESP32_MQTT_URL || config.mqttUrl;
  const mqttTopic = process.env.ESP32_MQTT_TOPIC || 'resilliox/sensor';

  if (!mqttUrl || !connect) {
    return null;
  }

  const client = connect(mqttUrl, {
    username: process.env.ESP32_MQTT_USERNAME || config.mqttUsername,
    password: process.env.ESP32_MQTT_PASSWORD || config.mqttPassword,
    clientId: process.env.ESP32_MQTT_CLIENT_ID || `${config.mqttClientId || 'resilliox'}_esp32_sub`,
    clean: false,
    protocolVersion: 4,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  client.on('connect', () => {
    client.subscribe(mqttTopic, { qos: 1 }, (err) => {
      if (!err) {
        console.log(`ESP32 MQTT subscriber connected to ${mqttTopic}`);
      }
    });
  });

  client.on('message', async (topic, messageBuffer) => {
    try {
      const json = JSON.parse(messageBuffer.toString('utf8'));
      await processPayload(json, {
        config,
        status,
        aiClient,
        broadcast,
        emergencyService,
        transport: 'mqtt',
      });
    } catch (err) {
      if (status) status.rejected = (status.rejected || 0) + 1;
      console.warn('Rejected invalid ESP32 MQTT sensor payload:', err.message);
    }
  });

  return client;
}
