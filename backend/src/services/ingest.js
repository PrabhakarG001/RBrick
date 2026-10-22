import { mongoose } from '../config/database.js';
import { SensorReading, Alert, Device } from '../models/index.js';
import { evaluateRules } from './payload.js';

export async function storeReading(reading, topic, rules) {
  try {
    return await mongoose.connection.transaction(async session => {
      const [saved] = await SensorReading.create([{ ...reading, topic }], { session });
      const alerts = evaluateRules(reading.sensors, rules).map(rule => ({
        deviceId: reading.deviceId, readingId: saved._id, kind: rule.kind,
        field: rule.field, message: rule.message, observedAt: reading.observedAt,
        severity: rule.severity || (rule.kind === 'sos' ? 'critical' : 'warning'),
      }));
      if (alerts.length) await Alert.insertMany(alerts, { session });
      await Device.updateOne({ deviceId: reading.deviceId }, {
        $max: { lastSeenAt: reading.receivedAt },
      }, { upsert: true, session });
      return { duplicate: false, id: saved._id };
    });
  } catch (error) {
    if (error.code === 11000 && reading.eventId) {
      const existing = await SensorReading.findOne({ deviceId: reading.deviceId, eventId: reading.eventId }).lean();
      if (existing) return { duplicate: true, id: existing._id };
    }
    throw error;
  }
}
