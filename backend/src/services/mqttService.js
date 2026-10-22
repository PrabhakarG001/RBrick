import mqtt from 'mqtt';
import { createPayloadParser } from './payload.js';
import { storeReading } from './ingest.js';

export function startMqtt(config, status, { connect = mqtt.connect, store = storeReading } = {}) {
  if (!config.mqttEnabled) return null;
  const parse = createPayloadParser(config.contract);
  const client = connect(config.mqttUrl, {
    username: config.mqttUsername, password: config.mqttPassword,
    clientId: config.mqttClientId, clean: false, protocolVersion: 4,
    reconnectPeriod: 5000, connectTimeout: 10000, resubscribe: true,
    queueQoSZero: false,
  });
  client.on('connect', () => {
    client.subscribe(config.mqttTopic, { qos: 1 }, (error, granted) => {
      status.mqtt = !error && granted?.length > 0 && granted.every(item => item.qos !== 128);
      console.log(status.mqtt ? 'MQTT subscription ready' : 'MQTT subscription failed');
    });
  });
  for (const event of ['offline', 'close', 'error']) client.on(event, () => { status.mqtt = false; });
  // Serial processing/backpressure. QoS 1 is acknowledged only after persistence.
  client.handleMessage = (packet, done) => {
    let reading;
    try {
      if (packet.payload.length > 16384) throw new Error('Payload too large');
      reading = parse(JSON.parse(packet.payload.toString('utf8')));
    } catch {
      status.rejected += 1;
      console.warn('MQTT message rejected: invalid payload (contents omitted)');
      done(); // Poison messages must not block the subscription.
      return;
    }
    store(reading, packet.topic, config.contract.rules).then(result => {
      status.persisted += result.duplicate ? 0 : 1;
      done();
    }).catch(() => {
      status.persistenceFailures += 1;
      console.error('MQTT persistence failed; reconnecting without acknowledging');
      // Do not acknowledge this message. Broker's persistent QoS 1 session can
      // redeliver it after reconnect. QoS 0 has no delivery guarantee.
      client.stream.destroy();
      done(new Error('Persistence unavailable'));
    });
  };
  return client;
}
