// rbrick-v1 MQTT subscriber.
//
// Subscribes to the documented topic set (mqtt/README.md, IoT/README.md):
//   building/+/+/+/telemetry, .../events, .../status, .../availability,
//   building/+/+/+/camera/status
//
// Responsibilities: payload validation, topic/payload identity checks,
// deduplication (message_id), risk analysis, MongoDB persistence and
// Socket.IO broadcasts. QoS 1 is acknowledged only after persistence.

import mqtt from 'mqtt';
import { parseTopic, parseChannelMessage } from './telemetrySchema.js';
import { storeTelemetryV1, storeEventV1, recordDeviceState } from './ingestV1.js';
import { DEFAULT_V1_TOPICS } from './telemetrySchema.js';
import { createAiServiceClient } from './aiServiceClient.js';
import { SecurityError } from './securityService.js';

const MAX_PAYLOAD_BYTES = 16384;

/**
 * @param {object} config  settings() result (v1 payload format)
 * @param {object} status  shared status object
 * @param {object} deps    { connect?, broadcast?, storeTelemetry?, storeEvent?, recordState? }
 */
export function startMqttV1(config, status, deps = {}) {
  if (!config.mqttEnabled) return null;
  const {
    connect = mqtt.connect,
    broadcast = () => {},
    storeTelemetry = storeTelemetryV1,
    storeEvent = storeEventV1,
    recordState = recordDeviceState,
    predict = createAiServiceClient(config, status).predict,
  } = deps;

  const topics = config.mqttTopics?.length ? config.mqttTopics : [...DEFAULT_V1_TOPICS];
  const client = connect(config.mqttUrl, {
    username: config.mqttUsername, password: config.mqttPassword,
    clientId: config.mqttClientId, clean: false, protocolVersion: 4,
    reconnectPeriod: 5000, connectTimeout: 10000, resubscribe: true,
    queueQoSZero: false,
  });

  client.on('connect', () => {
    status.mqttConnectedAt = new Date().toISOString();
    // Force a fresh SUBACK even when MQTT.js caches a persistent-session
    // subscription. Otherwise its empty cached result looks like failure.
    const subscriptions = Object.fromEntries(topics.map(topic => [topic, { qos: 1 }]));
    client.subscribe({ ...subscriptions, resubscribe: true }, { qos: 1 }, (error, granted) => {
      status.mqtt = !error && granted?.length > 0 && granted.every(item => item.qos !== 128);
      console.log(status.mqtt
        ? `MQTT v1 subscription ready (${topics.length} topics)`
        : 'MQTT v1 subscription failed');
    });
    // Publish backend "online" marker on its own status topic? No — the
    // backend is a subscriber, not a device. Devices own their availability.
  });
  client.on('reconnect', () => {
    status.mqttReconnects = (status.mqttReconnects ?? 0) + 1;
    status.mqtt = false;
  });
  for (const event of ['offline', 'close', 'error']) {
    client.on(event, () => { status.mqtt = false; });
  }

  client.handleMessage = (packet, done) => {
    let message;
    try {
      if (packet.payload.length > MAX_PAYLOAD_BYTES) throw new Error('Payload too large');
      const topicInfo = parseTopic(packet.topic);
      if (!topicInfo) throw new Error('Unknown topic shape');
      if (topicInfo.channel === 'events' && packet.retain) throw new Error('Retained emergency replay rejected');
      message = parseChannelMessage(topicInfo.channel, packet.topic,
        packet.payload.toString('utf8'));
    } catch {
      status.rejected += 1;
      console.warn('MQTT v1 message rejected: invalid payload or topic (contents omitted)');
      done();
      return;
    }

    const finish = (handler) => handler()
      .then(result => {
        done();
        return result;
      })
      .catch(error => {
        if(error instanceof SecurityError&&error.status>=400&&error.status<500){
          status.rejected+=1;console.warn('MQTT security event rejected: registered identity mismatch (contents omitted)');done();return null;
        }
        status.persistenceFailures += 1;
        console.error('MQTT v1 persistence failed; reconnecting to allow broker redelivery');
        client.stream.destroy();
        done(new Error('Persistence unavailable'));
        return null;
      });

    if (message.channel === 'telemetry') {
      finish(() => storeTelemetry(message, {
        predict,
        staleAfterSeconds: config.offlineAfterSeconds,
      })).then(result => {
        if (!result) return;
        if (result.duplicate) return;
        // Re-analysis uses the original durable payload, even if an ID is
        // redelivered with altered values. Broadcast only what was persisted.
        message = result.message ?? message;
        if (result.newReading !== false) status.persisted += 1;
        broadcast('sensor_update', {
          deviceId: message.device_id, zoneId: message.zone_id,
          messageId: message.message_id,
          buildingId: message.building_id, source: message.source,
          observedAt: message.observedAt.toISOString(), sensors: message.sensors,
          receivedAt: new Date().toISOString(),
          health: message.health, analysisStatus: result.analysisStatus,
        });
        if (result.risk) {
          broadcast('risk_update', {
            deviceId: message.device_id, zoneId: message.zone_id,
            messageId: message.message_id,
            score: result.risk.score, classification: result.risk.classification,
            factors: result.risk.factors, stale: result.risk.stale,
            source: message.source, modelVersion: result.risk.modelVersion,
            engineVersion: result.risk.engineVersion,
            analyzedAt: result.analysis?.analyzedAt?.toISOString?.() ?? new Date().toISOString(),
          });
        }
        for (const alert of result.alerts ?? []) {
          broadcast('new_alert', {
            id: alert._id, deviceId: alert.deviceId, zoneId: alert.zoneId,
            kind: alert.kind, severity: alert.severity, message: alert.message,
            incidentId: alert.incidentId, observedAt: alert.observedAt,
            source: message.source,
          });
          if (alert.kind === 'sos') {
            broadcast('sos_event', {
              id: alert._id, deviceId: alert.deviceId, zoneId: alert.zoneId,
              message: alert.message, observedAt: alert.observedAt,
              source: message.source,
            });
          }
        }
      });
      return;
    }

    if (message.channel === 'events') {
      finish(() => storeEvent(message)).then(alert => {
        if (!alert) return; // duplicate delivery, already processed
        status.persisted += 1;
        broadcast('new_alert', {
          id: alert._id, deviceId: alert.deviceId, zoneId: alert.zoneId,
          kind: alert.kind, severity: alert.severity, message: alert.message,
          incidentId: alert.incidentId, observedAt: alert.observedAt,
          source: message.source,
        });
        if (alert.kind === 'sos') {
          broadcast('sos_event', {
            id: alert._id, deviceId: alert.deviceId, zoneId: alert.zoneId,
            message: alert.message, observedAt: alert.observedAt,
            source: message.source,
          });
        }
      });
      return;
    }

    // status / availability / camera status: device bookkeeping only.
    finish(() => recordState({
      deviceId: message.device_id, buildingId: message.building_id ?? message.buildingId ?? null,
      zoneId: message.zone_id ?? message.zoneId ?? null,
      state: message.channel === 'camera/status' ? message.state : message.state,
      source: message.source, firmwareVersion: message.firmware_version,
      messageId:message.message_id,observedAt:message.observedAt,
      kind: message.channel === 'availability' ? 'availability'
        : message.channel === 'camera/status' ? 'camera' : 'status',
    })).then(applied => {
      if (!applied) return;
      broadcast('device_status', {
        deviceId: message.device_id, zoneId: message.zone_id ?? null,
        state: message.state, channel: message.channel,
        source: message.source,
      });
    });
  };
  return client;
}
