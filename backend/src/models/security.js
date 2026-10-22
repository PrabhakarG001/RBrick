// Security records reuse Device, CameraSnapshot and Alert from index.js.
// Motion/access history share one event collection rather than duplicate logs.
import { mongoose } from '../config/database.js';
const { Schema } = mongoose;
const source = { type: String, enum: ['simulation','hardware','operator','system'], required: true };
const demoScope = { type: String, maxlength: 64 };
const zone = new Schema({
  zoneId: { type: String, required: true, unique: true }, name: { type: String, required: true, maxlength: 100 },
  restricted: { type: Boolean, default: false }, timeZone: { type: String, default: 'UTC' }, demoScope,
  eventVersion: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
const event = new Schema({
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true }, severity: { type: String, enum: ['info','warning','high','critical'], default: 'info' },
  zoneId: String, deviceId: String, visitorId: String, visitId: { type: Schema.Types.ObjectId, ref: 'VisitorVisit' },
  snapshotId: { type: Schema.Types.ObjectId, ref: 'CameraSnapshot' },
  source, occurredAt: { type: Date, required: true }, receivedAt: { type: Date, required: true },
  description: { type: String, required: true, maxlength: 500 }, demoScope,
}, { versionKey: false });
event.index({ occurredAt: -1, _id: -1 });
event.index({ zoneId: 1, type: 1, receivedAt: -1 });
event.index({ deviceId: 1, occurredAt: -1 });
const visitor = new Schema({
  visitorId: { type: String, required: true, unique: true },
  name: { type: String, required: true, maxlength: 100 }, company: { type: String, maxlength: 100, default: '' },
  purpose: { type: String, maxlength: 300, default: '' }, source, demoScope,
  visitVersion: { type: Number, default: 0 },
}, { timestamps: true, versionKey: false });
visitor.index({ name: 1, createdAt: -1 });
const visit = new Schema({
  visitorId: { type: String, required: true }, zoneId: { type: String, required: true },
  checkedInAt: { type: Date, required: true }, checkedOutAt: Date,
  // Removed atomically on checkout. Unique index prevents concurrent check-ins.
  activeVisitorKey: String, source, demoScope,
}, { versionKey: false });
visit.index({ activeVisitorKey: 1 }, { unique: true, partialFilterExpression: { activeVisitorKey: { $type: 'string' } } });
visit.index({ visitorId: 1, checkedInAt: -1 });
const rule = new Schema({
  key: { type: String, required: true, unique: true }, enabled: { type: Boolean, default: true },
  severity: { type: String, enum: ['warning','high','critical'], default: 'high' },
  windowSeconds: { type: Number, default: 60, min: 1, max: 86400 },
  threshold: { type: Number, default: 3, min: 2, max: 1000 },
  timeoutSeconds: { type: Number, default: 120, min: 10, max: 86400 },
  startMinute: { type: Number, default: 480, min: 0, max: 1439 },
  endMinute: { type: Number, default: 1080, min: 0, max: 1439 },
  days: { type: [Number], default: [1,2,3,4,5] },
}, { timestamps: true, versionKey: false });
const audit = new Schema({
  auditId: { type: String, required: true, unique: true }, action: { type: String, required: true },
  actor: { type: String, required: true }, reference: String, source,
  occurredAt: { type: Date, required: true }, description: { type: String, maxlength: 500 }, demoScope,
}, { versionKey: false });
audit.index({ occurredAt: -1, _id: -1 });
// Application paths expose insert/list only. No audit update/delete endpoints.
for (const schema of [event,audit]) {
  for (const method of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace'])
    schema.pre(method, function() { throw new Error('Security history is append-only'); });
}
const notification = new Schema({
  alertId: { type: Schema.Types.ObjectId, ref: 'Alert', required: true, unique: true },
  message: { type: String, required: true, maxlength: 500 }, source,
  createdAt: { type: Date, required: true }, readAt: Date, demoScope,
}, { versionKey: false });
notification.index({ createdAt: -1 });
const simulation = new Schema({
  key: { type: String, unique: true, required: true }, running: { type: Boolean, default: false },
  startedAt: Date, stoppedAt: Date,
}, { versionKey: false });
export const SecurityZone = mongoose.model('SecurityZone', zone);
export const SecurityEvent = mongoose.model('SecurityEvent', event);
export const Visitor = mongoose.model('Visitor', visitor);
export const VisitorVisit = mongoose.model('VisitorVisit', visit);
export const SecurityRule = mongoose.model('SecurityRule', rule);
export const SecurityAudit = mongoose.model('SecurityAudit', audit);
export const SecurityNotification = mongoose.model('SecurityNotification', notification);
export const SecuritySimulation = mongoose.model('SecuritySimulation', simulation);
export const securityModels = [SecurityZone,SecurityEvent,Visitor,VisitorVisit,SecurityRule,SecurityAudit,SecurityNotification,SecuritySimulation];
