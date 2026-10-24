import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createApp } from '../src/app.js';
import {
  validateEsp32Payload,
  adaptEsp32Features,
  processSensorIngestion,
  createEsp32MqttSubscriber,
  MODEL_FEATURE_NAMES,
  MODEL_TARGET_NAMES,
} from '../src/services/sensorIngestionService.js';
import { AiServiceError } from '../src/services/aiServiceClient.js';

// Mock AI client that emulates multi-label ML model predictions
function createMockAiClient(mode = 'normal') {
  return {
    async predictMultiLabel(features) {
      if (mode === 'failure') {
        throw new AiServiceError('unavailable');
      }
      if (mode === 'timeout') {
        throw new AiServiceError('timeout');
      }

      // Emulate 10 targets from MultiLabelIoTModel
      const predictedLabels = {};
      const probabilities = {};
      const thresholds = {
        event_fire_suspected: 0.23,
        event_smoke_suspected: 0.37,
        event_combustible_gas_suspected: 0.42,
        event_unauthorized_intrusion: 0.32,
        event_vibration_anomaly: 0.11,
        event_structural_vibration_review: 0.05,
        event_heat_risk: 0.19,
        event_high_humidity_mold_risk: 0.25,
        event_device_fault: 0.31,
        event_network_degradation: 0.27,
      };

      const activeEvents = [];

      // Detect multiple events if conditions met
      const temp = features.temperature_c ?? 22;
      const gas = features.mq2_adc_raw_0_4095 ?? 200;
      const flame = features.flame_detected_normalized ?? 0;
      const hum = features.humidity_rh_pct ?? 50;

      for (const tgt of MODEL_TARGET_NAMES) {
        let prob = 0.01;
        if (tgt === 'event_heat_risk' && temp > 45) {
          prob = 0.85;
        } else if (tgt === 'event_fire_suspected' && flame === 1) {
          prob = 0.92;
        } else if (tgt === 'event_combustible_gas_suspected' && gas > 2000) {
          prob = 0.88;
        } else if (tgt === 'event_high_humidity_mold_risk' && hum > 80) {
          prob = 0.75;
        }
        probabilities[tgt] = prob;
        const isActive = prob >= (thresholds[tgt] || 0.5) ? 1 : 0;
        predictedLabels[tgt] = isActive;
        if (isActive === 1) {
          activeEvents.push(tgt);
        }
      }

      const emergencyOverride = Boolean(features.sos_button_pressed === 1);

      return {
        model_version: 'iot-building-safety-multilabel-v1.0.0',
        predicted_labels: predictedLabels,
        probabilities,
        thresholds_used: thresholds,
        active_events: activeEvents,
        active_event_count: activeEvents.length,
        emergency_override: emergencyOverride,
        sos_triggered: emergencyOverride,
        disclaimer: 'Simulated synthetic sensor dataset only; not validated against physical hardware.',
      };
    },
  };
}

// ── Test 1: Valid ESP32 JSON payload ──
test('Shared ingestion processes valid ESP32 JSON payload with honest feature mapping', async () => {
  const payload = {
    building: 'Engineering-Hall',
    area: 'Lab-301',
    temperature: 24.5,
    humidity: 50.0,
    gas_value: 350,
    fire: 0,
    smoke: 0,
    motion: 0,
    vibration: 0.05,
    tilt: 0,
    sos: 0,
    mpu_connected: 1,
    alarm: 0,
    buzzer_on: 0,
    wifi_rssi: -62,
  };

  const adapted = adaptEsp32Features(payload);
  assert.equal(adapted.features.temperature_c, 24.5);
  assert.equal(adapted.features.humidity_rh_pct, 50.0);
  assert.equal(adapted.features.mq2_adc_raw_0_4095, 350);
  assert.equal(adapted.features.pir_motion_detected, 0);
  assert.equal(adapted.features.flame_detected_normalized, 0);
  assert.equal(adapted.features.wifi_rssi_dbm, -62);
  assert.equal(adapted.features.zone_id, 'Lab-301');
  assert.equal(adapted.features.sos_button_pressed, 0);
  assert.equal(adapted.sosPressed, false);

  // Absent features are NOT fabricated with 0
  assert.equal(Object.hasOwn(adapted.features, 'mpu_ax_g'), false);
  assert.equal(Object.hasOwn(adapted.features, 'mpu_gx_dps'), false);
  assert.equal(Object.hasOwn(adapted.features, 'camera_motion_score_0_100'), false);
  assert.equal(Object.hasOwn(adapted.features, 'esp32_3v3_rail_v'), false);

  // Ingestion with mock AI
  const aiClient = createMockAiClient('normal');
  const result = await processSensorIngestion(payload, { aiClient });

  assert.equal(result.success, true);
  assert.equal(result.status, 'processed');
  assert.equal(result.area, 'Lab-301');
  assert.equal(result.building, 'Engineering-Hall');
  assert.equal(result.emergency_override, false);
  assert.equal(result.ml_predictions.activeEventCount, 0);
  assert.equal(Object.keys(result.ml_predictions.predictedLabels).length, 10);
  assert.equal(Object.keys(result.ml_predictions.probabilities).length, 10);
  assert.equal(result.sensor_coverage.suppliedCount, 7);
  assert.equal(result.sensor_coverage.coverageStatus, 'reduced');
  assert.equal(result.sensor_coverage.missingCount, 31);
});

// ── Test 2: Multiple simultaneous predicted events ──
test('Shared ingestion correctly predicts and returns multiple simultaneous hazard events', async () => {
  const payload = {
    building: 'Warehouse-A',
    area: 'Storage-East',
    temperature: 55.0, // High temperature -> event_heat_risk
    humidity: 85.0,    // High humidity -> event_high_humidity_mold_risk
    gas_value: 2600,   // High combustible gas -> event_combustible_gas_suspected
    fire: 1,           // Flame detected -> event_fire_suspected
    motion: 1,
    sos: 0,
    wifi_rssi: -85,
  };

  const aiClient = createMockAiClient('normal');
  const broadcastEvents = [];
  const broadcast = (event, data) => broadcastEvents.push({ event, data });

  const result = await processSensorIngestion(payload, { aiClient, broadcast });

  assert.equal(result.success, true);
  assert.equal(result.ml_predictions.activeEventCount >= 3, true);
  assert.equal(result.ml_predictions.activeEvents.includes('event_heat_risk'), true);
  assert.equal(result.ml_predictions.activeEvents.includes('event_fire_suspected'), true);
  assert.equal(result.ml_predictions.activeEvents.includes('event_combustible_gas_suspected'), true);
  assert.equal(result.ml_predictions.activeEvents.includes('event_high_humidity_mold_risk'), true);
  assert.equal(result.classification, 'CRITICAL');

  // Verify real-time broadcast included multi-label predictions
  const riskBroadcast = broadcastEvents.find(e => e.event === 'risk_update');
  assert.ok(riskBroadcast);
  assert.equal(riskBroadcast.data.ml.activeEventCount >= 3, true);
  assert.equal(riskBroadcast.data.classification, 'CRITICAL');
});

// ── Test 3: SOS override when model event predictions are otherwise inactive ──
test('SOS triggers immediate deterministic emergency override even when all model events are inactive', async () => {
  const payload = {
    building: 'Dorm-B',
    area: 'Room-102',
    temperature: 21.0, // perfectly normal
    humidity: 45.0,    // normal
    gas_value: 120,    // clean air
    fire: 0,
    motion: 0,
    sos: 1,            // Physical hardware SOS pressed!
    wifi_rssi: -50,
  };

  const aiClient = createMockAiClient('normal');
  const broadcastEvents = [];
  const broadcast = (event, data) => broadcastEvents.push({ event, data });

  let emergencyTriggered = false;
  const emergencyService = {
    async triggerEmergency(details) {
      emergencyTriggered = true;
      assert.equal(details.severity, 'critical');
      assert.equal(details.buildingId, 'Dorm-B');
      return { emergencyId: 'em_123', status: 'active' };
    },
  };

  const result = await processSensorIngestion(payload, {
    aiClient,
    broadcast,
    emergencyService,
  });

  assert.equal(result.success, true);
  assert.equal(result.emergency_override, true);
  assert.equal(result.sos_triggered, true);
  assert.equal(result.ml_predictions.activeEventCount, 0); // No ML events active
  assert.equal(result.classification, 'CRITICAL');
  assert.equal(result.score, 100);
  assert.equal(emergencyTriggered, true);

  // Broadcasts SOS event
  const sosBroadcast = broadcastEvents.find(e => e.event === 'sos_event');
  assert.ok(sosBroadcast);
  assert.equal(sosBroadcast.data.buildingId, 'Dorm-B');
});

// ── Test 4: Missing sensor readings and incomplete sensor coverage reporting ──
test('Incomplete sensor readings honestly report reduced sensor coverage and missing features', async () => {
  // Only temperature provided
  const sparsePayload = {
    building: 'Tower-1',
    temperature: 23.0,
  };

  const adapted = adaptEsp32Features(sparsePayload);
  assert.equal(adapted.sensorCoverage.suppliedCount, 1);
  assert.equal(adapted.sensorCoverage.totalCount, 38);
  assert.equal(adapted.sensorCoverage.missingCount, 37);
  assert.equal(adapted.sensorCoverage.coverageStatus, 'reduced');
  assert.equal(adapted.sensorCoverage.suppliedFeatures.includes('temperature_c'), true);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('humidity_rh_pct'), true);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('mq2_adc_raw_0_4095'), true);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('mpu_ax_g'), true);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('camera_motion_score_0_100'), true);
  assert.match(adapted.sensorCoverage.note, /partial sensor coverage/i);

  const aiClient = createMockAiClient('normal');
  const result = await processSensorIngestion(sparsePayload, { aiClient });
  assert.equal(result.sensor_coverage.suppliedCount, 1);
  assert.equal(result.sensor_coverage.coverageStatus, 'reduced');
});

// ── Test 5: Malformed payloads and model-service failures ──
test('Validation rejects malformed payloads and handles model-service failures gracefully', async () => {
  // 5a. Non-object payload
  assert.throws(() => validateEsp32Payload(null));
  assert.throws(() => validateEsp32Payload('not-json'));
  assert.throws(() => validateEsp32Payload([1, 2, 3]));

  // 5b. Invalid types for sensor values
  assert.throws(() => validateEsp32Payload({ temperature: 'seventy-five' }));
  assert.throws(() => validateEsp32Payload({ humidity: { percent: 50 } }));
  assert.throws(() => validateEsp32Payload({ gas_value: 'high' }));

  // 5c. Model-service failure (service down / 503)
  const failingAiClient = createMockAiClient('failure');
  const validPayload = {
    building: 'Hall-A',
    area: 'Room-1',
    temperature: 25.0,
    humidity: 50.0,
  };

  const resultFailure = await processSensorIngestion(validPayload, { aiClient: failingAiClient });
  assert.equal(resultFailure.success, true);
  assert.equal(resultFailure.status, 'partial');
  assert.equal(resultFailure.ml_predictions, null);
  assert.equal(resultFailure.ml_error, 'unavailable');
  assert.ok(resultFailure.sensor_coverage);

  // 5d. Model-service timeout
  const timeoutAiClient = createMockAiClient('timeout');
  const resultTimeout = await processSensorIngestion(validPayload, { aiClient: timeoutAiClient });
  assert.equal(resultTimeout.status, 'partial');
  assert.equal(resultTimeout.ml_predictions, null);
  assert.equal(resultTimeout.ml_error, 'timeout');
});

// ── Test 6: Shared ingestion called through both HTTP and mocked MQTT transports ──
test('Shared ingestion operates identically across both HTTP and mocked MQTT transports', async () => {
  const config = {
    port: 5000,
    apiToken: '01234567890123456789012345678901',
    mqttEnabled: true,
    mqttUrl: 'mqtt://localhost:1883',
    contract: { fields: {}, rules: [], display: {} },
  };
  const status = { database: false, mqtt: true };
  const aiClient = createMockAiClient('normal');

  const sharedPayload = {
    building: 'Science-Center',
    area: 'Chem-Lab',
    temperature: 28.0,
    humidity: 48.0,
    gas_value: 310,
    fire: 0,
    motion: 0,
    sos: 0,
    wifi_rssi: -58,
  };

  // Transport A: Direct execution / HTTP router invocation
  const httpResult = await processSensorIngestion(sharedPayload, {
    config,
    status,
    aiClient,
    transport: 'http',
  });
  assert.equal(httpResult.transport, 'http');
  assert.equal(httpResult.building, 'Science-Center');
  assert.equal(httpResult.area, 'Chem-Lab');
  assert.equal(httpResult.ml_predictions.modelVersion, 'iot-building-safety-multilabel-v1.0.0');

  // Transport B: Mocked MQTT Subscriber
  let capturedMqttResult = null;
  const mockMqttClient = new EventEmitter();
  mockMqttClient.subscribe = (topic, opts, cb) => {
    if (cb) cb(null);
  };

  const subscriber = createEsp32MqttSubscriber(config, status, {
    connect: () => mockMqttClient,
    aiClient,
    processPayload: async (payload, opts) => {
      capturedMqttResult = await processSensorIngestion(payload, opts);
      return capturedMqttResult;
    },
  });
  assert.ok(subscriber);

  // Simulate incoming MQTT message packet on configured topic
  const messageBuffer = Buffer.from(JSON.stringify(sharedPayload));
  mockMqttClient.emit('message', 'resilliox/sensor', messageBuffer);

  // Allow async handler to run
  await new Promise(resolve => setImmediate(resolve));

  assert.ok(capturedMqttResult);
  assert.equal(capturedMqttResult.transport, 'mqtt');
  assert.equal(capturedMqttResult.building, httpResult.building);
  assert.equal(capturedMqttResult.area, httpResult.area);
  assert.equal(capturedMqttResult.emergency_override, httpResult.emergency_override);
  assert.deepEqual(capturedMqttResult.ml_predictions.predictedLabels, httpResult.ml_predictions.predictedLabels);
  assert.deepEqual(capturedMqttResult.sensor_coverage, httpResult.sensor_coverage);
});

// ── Test 7: Actual ESP32 firmware payload with exact string enums ──
test('Actual ESP32 firmware payload formats are supported with honest feature mapping and coverage audit', async () => {
  const firmwarePayload = {
    building: 'Engineering-Tower',
    area: 'Lab-204',
    fire: 'SAFE',
    smoke: 'NORMAL',
    gas_value: 450,
    motion: 'NONE',
    vibration: 'NORMAL',
    tilt: 1.25,
    temperature: 24.5,
    humidity: 45.0,
    sos: false,
    mpu_connected: true,
    alarm: 'NORMAL',
    buzzer_on: false,
    wifi_rssi: -65,
  };

  // 7a. Verify schema parsing
  const validated = validateEsp32Payload(firmwarePayload);
  assert.equal(validated.fire, 'SAFE');
  assert.equal(validated.smoke, 'NORMAL');
  assert.equal(validated.motion, 'NONE');
  assert.equal(validated.vibration, 'NORMAL');
  assert.equal(validated.alarm, 'NORMAL');
  assert.equal(validated.tilt, 1.25);
  assert.equal(validated.mpu_connected, true);
  assert.equal(validated.buzzer_on, false);

  // 7b. Verify honest feature adaptation
  const adapted = adaptEsp32Features(validated);
  assert.equal(adapted.features.temperature_c, 24.5);
  assert.equal(adapted.features.humidity_rh_pct, 45.0);
  assert.equal(adapted.features.mq2_adc_raw_0_4095, 450);
  assert.equal(adapted.features.flame_detected_normalized, 0.0);
  assert.equal(adapted.features.pir_motion_detected, 0);
  assert.equal(adapted.features.wifi_rssi_dbm, -65);
  assert.equal(adapted.features.zone_id, 'Lab-204');

  // 7c. Audit: vibration is NOT mapped to sw420, acceleration, or vibration RMS
  assert.equal(Object.hasOwn(adapted.features, 'sw420_digital_state'), false);
  assert.equal(Object.hasOwn(adapted.features, 'mpu_ax_g'), false);
  assert.equal(Object.hasOwn(adapted.features, 'vibration_duration_s'), false);
  assert.equal(Object.hasOwn(adapted.features, 'vibration'), false);

  // 7d. Audit: tilt is NOT mapped to model features (tilt_angle_deg is not in model)
  assert.equal(Object.hasOwn(adapted.features, 'tilt_angle_deg'), false);
  assert.equal(Object.hasOwn(adapted.features, 'tilt'), false);

  // 7e. Audit: mpu_connected is handled as device health, NOT a model feature
  assert.equal(Object.hasOwn(adapted.features, 'mpu_connected'), false);

  // 7f. Audit: Coverage accurately describes the 7 supplied model features
  assert.equal(adapted.sensorCoverage.suppliedCount, 7);
  assert.equal(adapted.sensorCoverage.totalCount, 38);
  assert.equal(adapted.sensorCoverage.coveragePct, 18.4);
  assert.equal(adapted.sensorCoverage.missingCount, 31);
  assert.equal(adapted.sensorCoverage.coverageStatus, 'reduced');

  // 7g. Test when fire is DANGER and motion is DETECTED
  const dangerPayload = {
    ...firmwarePayload,
    fire: 'DANGER',
    motion: 'DETECTED',
  };
  const dangerAdapted = adaptEsp32Features(dangerPayload);
  assert.equal(dangerAdapted.features.flame_detected_normalized, 1.0);
  assert.equal(dangerAdapted.features.pir_motion_detected, 1);

  // 7h. End-to-end ingestion returns firmware status and accurate coverage
  const aiClient = createMockAiClient('normal');
  const result = await processSensorIngestion(firmwarePayload, { aiClient });
  assert.equal(result.success, true);
  assert.equal(result.firmware_status.mpu_connected, true);
  assert.equal(result.firmware_status.buzzer_active, false);
  assert.equal(result.firmware_status.alarm_active, 'NORMAL');
  assert.equal(result.firmware_status.smoke_flag, 'NORMAL');
  assert.equal(result.firmware_status.vibration_raw, 'NORMAL');
  assert.equal(result.firmware_status.tilt, 1.25);
  assert.equal(result.sensor_coverage.suppliedCount, 7);
  assert.equal(result.sensor_coverage.coveragePct, 18.4);
});

// ── Test 8: Malformed values are rejected and never silently treated as safe ──
test('Validation strictly rejects malformed values and does not silently treat them as safe', () => {
  // 8a. Invalid fire strings must be rejected
  assert.throws(() => validateEsp32Payload({ fire: 'BURNING' }));
  assert.throws(() => validateEsp32Payload({ fire: 'HOT' }));
  assert.throws(() => validateEsp32Payload({ fire: 'SAFE_ISH' }));

  // 8b. Invalid motion strings must be rejected
  assert.throws(() => validateEsp32Payload({ motion: 'RUNNING' }));
  assert.throws(() => validateEsp32Payload({ motion: 'WALKING' }));

  // 8c. Invalid smoke strings must be rejected
  assert.throws(() => validateEsp32Payload({ smoke: 'SMOKY' }));

  // 8d. Invalid vibration strings must be rejected
  assert.throws(() => validateEsp32Payload({ vibration: 'SHAKING' }));

  // 8e. Invalid alarm strings must be rejected
  assert.throws(() => validateEsp32Payload({ alarm: 'PANIC' }));
});

// ── Test 9: ESP32 format payload with sos: true triggers independent override during service failure ──
test('ESP32-format payload with sos: true triggers independent emergency override even when ML service is unavailable', async () => {
  const sosFirmwarePayload = {
    building: 'Hospital-Wing',
    area: 'ICU-Emergency',
    fire: 'SAFE',
    smoke: 'NORMAL',
    gas_value: 180,
    motion: 'NONE',
    vibration: 'NORMAL',
    tilt: 0.1,
    temperature: 22.0,
    humidity: 40.0,
    sos: true, // Physical SOS activated
    mpu_connected: true,
    alarm: 'SOS',
    buzzer_on: true,
    wifi_rssi: -55,
  };

  // Inference service is down/failing
  const failingAiClient = createMockAiClient('failure');
  let emergencyTriggered = false;
  const emergencyService = {
    async triggerEmergency(details) {
      emergencyTriggered = true;
      assert.equal(details.severity, 'critical');
      assert.equal(details.buildingId, 'Hospital-Wing');
      return { emergencyId: 'sos_icu_1', status: 'active' };
    },
  };

  const broadcastEvents = [];
  const broadcast = (event, data) => broadcastEvents.push({ event, data });

  const result = await processSensorIngestion(sosFirmwarePayload, {
    aiClient: failingAiClient,
    emergencyService,
    broadcast,
  });

  // Verify independent emergency override
  assert.equal(result.success, true);
  assert.equal(result.emergency_override, true);
  assert.equal(result.sos_triggered, true);
  assert.equal(result.classification, 'CRITICAL');
  assert.equal(result.score, 100);
  assert.equal(result.ml_predictions, null); // No fabricated predictions!
  assert.equal(result.ml_error, 'unavailable');
  assert.equal(emergencyTriggered, true);

  // SOS event broadcasted
  const sosBroadcast = broadcastEvents.find(e => e.event === 'sos_event');
  assert.ok(sosBroadcast);
  assert.equal(sosBroadcast.data.buildingId, 'Hospital-Wing');

  // Verify firmware status preserved without attempting to disable buzzer
  assert.equal(result.firmware_status.buzzer_active, true);
  assert.equal(result.firmware_status.alarm_active, 'SOS');
});

// ── Test 10: Null temperature and humidity readings accurately drop coverage ──
test('Null temperature and humidity readings drop supplied coverage to 5/38 without fabricating zeros', async () => {
  const nullReadingPayload = {
    building: 'Office-Tower',
    area: 'Floor-1',
    fire: 'SAFE',
    smoke: 'NORMAL',
    gas_value: 320,
    motion: 'NONE',
    vibration: 'NORMAL',
    temperature: null, // DHT sensor failed or disconnected
    humidity: null,    // DHT sensor failed or disconnected
    sos: false,
    wifi_rssi: -70,
  };

  const validated = validateEsp32Payload(nullReadingPayload);
  const adapted = adaptEsp32Features(validated);

  // Exactly 5 features supplied: zone_id, gas_value, flame_detected_normalized, pir_motion_detected, wifi_rssi_dbm
  assert.equal(adapted.sensorCoverage.suppliedCount, 5);
  assert.equal(adapted.sensorCoverage.missingCount, 33);
  assert.equal(adapted.sensorCoverage.coveragePct, 13.2);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('temperature_c'), true);
  assert.equal(adapted.sensorCoverage.missingFeatures.includes('humidity_rh_pct'), true);
  assert.equal(Object.hasOwn(adapted.features, 'temperature_c'), false);
  assert.equal(Object.hasOwn(adapted.features, 'humidity_rh_pct'), false);
});

// ── Test 11: GET /sensor/latest and /sensor/history work with in-memory fallback when database is disconnected ──
test('GET /sensor/latest and /sensor/history return 200 with in-memory fallback when database is offline', async () => {
  const config = {
    port: 5000,
    apiToken: 'test-token-32-chars-long-valid!!',
    contract: { fields: {}, display: {}, rules: [] },
    mqttEnabled: false,
    payloadFormat: 'resilliox-v1',
    uri: '',
  };
  const status = { database: false, mqtt: false };
  const mockAi = createMockAiClient('normal');
  const app = createApp(config, status, { aiClient: mockAi });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. GET /sensor/latest before ingestion should return 200 with source: 'none' or 'memory' without crashing
    const resEmpty = await fetch(`http://127.0.0.1:${port}/sensor/latest`);
    assert.equal(resEmpty.status, 200);
    const bodyEmpty = await resEmpty.json();
    assert.equal(bodyEmpty.success, true);
    assert.ok(['none', 'memory'].includes(bodyEmpty.source));

    // 2. Ingest a sensor payload via POST /sensor
    const postPayload = {
      deviceId: 'esp32_inmem_test_unit',
      temperature: 26.2,
      humidity: 52.0,
      gas_value: 340,
      fire: 0,
      smoke: 0,
      motion: 0,
      vibration: 0,
      sos: 0,
      wifi_rssi: -58,
    };
    const postRes = await fetch(`http://127.0.0.1:${port}/sensor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(postPayload),
    });
    assert.equal(postRes.status, 200);
    const postBody = await postRes.json();
    assert.equal(postBody.success, true);

    // 3. GET /sensor/latest after ingestion should return the newly ingested reading from memory
    const resLatest = await fetch(`http://127.0.0.1:${port}/sensor/latest?deviceId=esp32_inmem_test_unit`);
    assert.equal(resLatest.status, 200);
    const bodyLatest = await resLatest.json();
    assert.equal(bodyLatest.success, true);
    assert.equal(bodyLatest.reading.deviceId, 'esp32_inmem_test_unit');
    assert.equal(bodyLatest.reading.sensors.temperature, 26.2);
    assert.equal(bodyLatest.reading.sensors.gas_value, 340);
    assert.equal(bodyLatest.source, 'memory');

    // 4. GET /sensor/history should return array of items from in-memory cache
    const resHistory = await fetch(`http://127.0.0.1:${port}/sensor/history?deviceId=esp32_inmem_test_unit&limit=10`);
    assert.equal(resHistory.status, 200);
    const bodyHistory = await resHistory.json();
    assert.equal(bodyHistory.success, true);
    assert.ok(Array.isArray(bodyHistory.items));
    assert.ok(bodyHistory.items.length >= 1);
    assert.equal(bodyHistory.items[0].deviceId, 'esp32_inmem_test_unit');
  } finally {
    server.close();
  }
});

test('HTTP /sensor endpoints allow CORS and handle OPTIONS preflight from frontend dashboard', async () => {
  const config = {
    port: 0,
    apiToken: '012345678901234567890123456789012',
    mqttEnabled: false,
    payloadFormat: 'resilliox-v1',
    contract: { fields: {}, rules: [] },
  };
  const status = { database: false, mqtt: false };
  const mockAi = createMockAiClient('normal');
  const app = createApp(config, status, { aiClient: mockAi });

  const server = app.listen(0);
  const port = server.address().port;

  try {
    // 1. GET /sensor/latest with Origin header should have CORS and CORP cross-origin
    const getRes = await fetch(`http://127.0.0.1:${port}/sensor/latest`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    assert.equal(getRes.status, 200);
    assert.equal(getRes.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.equal(getRes.headers.get('cross-origin-resource-policy'), 'cross-origin');

    // 2. OPTIONS /sensor preflight request from browser
    const optRes = await fetch(`http://127.0.0.1:${port}/sensor`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Content-Type',
      },
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok(optRes.headers.get('access-control-allow-methods').includes('POST'));
  } finally {
    server.close();
  }
});

