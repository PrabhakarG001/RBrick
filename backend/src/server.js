import mqtt from 'mqtt';
import { settings } from './config/settings.js';
import { connectDatabase, mongoose } from './config/database.js';
import { ensureIndexes } from './models/index.js';
import { startMqtt } from './services/mqttService.js';
import { startMqttV1 } from './services/mqttServiceV1.js';
import { attachRealtime } from './services/realtime.js';
import { createApp } from './app.js';
import { databaseFailure } from './config/databaseErrors.js';
import { createAiServiceClient } from './services/aiServiceClient.js';
import { storeSecurityAwareTelemetry,recordSecurityAwareState } from './services/securityMqttAdapter.js';
import { ensureSecurityRules,reconcileSecurityCameras } from './services/securityService.js';
import { EmergencyService } from './services/emergencyService.js';
import { createEsp32MqttSubscriber } from './services/sensorIngestionService.js';

let config;
try { config = settings(); } catch {
  console.error('Invalid backend configuration; check field mappings, rules and MQTT settings (values omitted)');
  process.exit(1);
}
const status = { database: false, mqtt: false, persisted: 0, rejected: 0, persistenceFailures: 0, socketClients: 0 };
const emergencyService = new EmergencyService(status);
const aiService = createAiServiceClient(config, status);
const requiresAi = config.mqttEnabled && config.payloadFormat === 'resilliox-v1';
if (requiresAi) await aiService.healthcheck();
const aiTimer = requiresAi ? setInterval(() => aiService.healthcheck(), 30000).unref() : null;
let mqttClient;
let connecting = false;
let closing = false;
let lastDatabaseFailure;
function reportDatabaseFailure(error) {
  const failure = databaseFailure(error);
  status.databaseFailure = failure.code;
  if (failure.code !== lastDatabaseFailure) {
    console.error(`Atlas [${failure.code}]: ${failure.message} Connection retries continue every 10 seconds.`);
    lastDatabaseFailure = failure.code;
  }
}
mongoose.connection.on('disconnected', () => { status.database = false; });
mongoose.connection.on('error', reportDatabaseFailure);
// Driver reconnects after established connections; validate indexes again before readiness.
async function establishDatabase() {
  if (connecting || closing || status.database) return;
  connecting = true;
  try {
    const connected = mongoose.connection.readyState === 1 || await connectDatabase(config);
    if (connected) {
      await ensureIndexes();
      await ensureSecurityRules();
      status.database = true;
      status.databaseFailure = null;
      lastDatabaseFailure = undefined;
      console.log('Atlas connected and indexes ready');
      if (!mqttClient) {
        mqttClient = config.payloadFormat === 'resilliox-v1'
          ? startMqttV1(config, status, { broadcast: realtime.broadcast, predict: aiService.predict,storeTelemetry:storeSecurityAwareTelemetry,recordState:recordSecurityAwareState })
          : startMqtt(config, status);
      }
    }
  } catch (error) {
    reportDatabaseFailure(error);
  } finally { connecting = false; }
}
let realtime;
let esp32MqttClient;
const services = {
  emergencyService,
  aiClient: aiService,
  broadcast: (event, payload) => realtime?.broadcast(event, payload),
};
const app = createApp(config, status, services);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`IoT API listening on port ${config.port}`);
  if (!config.uri) console.warn('MONGODB_URI missing; database routes will return 503');
  if (config.apiToken.length < 32) console.warn('IOT_API_TOKEN must have at least 32 characters');
  if (!config.mqttEnabled) console.log('MQTT disabled until its contract is configured');
});
realtime = attachRealtime(server, config, status);
emergencyService.setRealtime(realtime);
emergencyService.setMqttPublisher((topic, msg) => {
  if (mqttClient && typeof mqttClient.publish === 'function') {
    mqttClient.publish(topic, msg);
  }
});
if (config.mqttEnabled && (process.env.ESP32_MQTT_URL || config.mqttUrl)) {
  esp32MqttClient = createEsp32MqttSubscriber(config, status, {
    connect: mqtt.connect,
    aiClient: aiService,
    broadcast: (event, payload) => realtime?.broadcast(event, payload),
    emergencyService,
  });
}
await establishDatabase();
const timer = setInterval(establishDatabase, 10000);
let securitySweep=false;
const securityTimer=setInterval(async()=>{
  if(!status.database||securitySweep)return;
  securitySweep=true;
  try{await reconcileSecurityCameras();}catch{console.warn('Security camera timeout reconciliation unavailable');}
  finally{securitySweep=false;}
},10000).unref();
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  clearInterval(securityTimer);
  if (aiTimer) clearInterval(aiTimer);
  const deadline = setTimeout(() => process.exit(1), 10000).unref();
  if (esp32MqttClient && typeof esp32MqttClient.endAsync === 'function') await esp32MqttClient.endAsync(true);
  if (mqttClient) await mqttClient.endAsync(true);
  await new Promise(resolve => realtime.io.close(resolve));
  await new Promise(resolve => server.close(resolve));
  await mongoose.disconnect();
  clearTimeout(deadline);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
