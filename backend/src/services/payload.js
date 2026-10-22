import { z } from 'zod';
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_:.\-]+$/);
export function createPayloadParser(contract) {
  const shape = {
    [contract.deviceField]: id,
    [contract.eventField]: id.optional(),
    [contract.timeField]: z.iso.datetime({ offset: true }).optional(),
  };
  for (const [field, type] of Object.entries(contract.fields)) {
    shape[field] = (type === 'number' ? z.number().finite() : z.boolean()).optional();
  }
  const schema = z.object(shape).strict();
  return (input, now = new Date()) => {
    if (!Object.keys(contract.fields).length) throw new Error('Sensor contract not configured');
    const payload = schema.parse(input);
    const sensors = Object.fromEntries(Object.keys(contract.fields)
      .filter(field => payload[field] !== undefined).map(field => [field, payload[field]]));
    if (!Object.keys(sensors).length) throw new Error('At least one sensor value is required');
    const observedAt = payload[contract.timeField] ? new Date(payload[contract.timeField]) : now;
    if (observedAt.getTime() > now.getTime() + 300000) throw new Error('Timestamp is too far in the future');
    return {
      deviceId: payload[contract.deviceField],
      ...(payload[contract.eventField] ? { eventId: payload[contract.eventField] } : {}),
      observedAt, receivedAt: now, sensors,
    };
  };
}
export function evaluateRules(sensors, rules) {
  const operators = { gt: (a, b) => a > b, gte: (a, b) => a >= b,
    lt: (a, b) => a < b, lte: (a, b) => a <= b, eq: (a, b) => a === b };
  return rules.filter(rule => Object.hasOwn(sensors, rule.field)
    && operators[rule.operator](sensors[rule.field], rule.value));
}
