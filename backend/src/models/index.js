import { mongoose } from '../config/database.js';
import { securityModels } from './security.js';
import { User, ROLES, ROLE_PERMISSIONS, hashPassword, verifyPassword } from './user.js';
import { EmergencyIncident } from './emergency.js';
import { MaintenanceTicket, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from './maintenanceTicket.js';
const { Schema } = mongoose;
const deviceId = { type: String, required: true, maxlength: 128 };
const readingSchema = new Schema({
  deviceId,
  eventId: { type: String, maxlength: 128 },
  observedAt: { type: Date, required: true },
  receivedAt: { type: Date, required: true },
  sensors: { type: Map, of: Schema.Types.Mixed, required: true },
  topic: { type: String, required: true },
  // resilliox-v1 extensions (optional so flat contracts keep working).
  buildingId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  source: { type: String, enum: ['hardware', 'simulation'] },
  firmwareVersion: { type: String, maxlength: 32 },
  health: { type: Map, of: String },
  analysisStatus: { type: String, enum: ['complete', 'unavailable'] },
  analysisError: { type: String, enum: ['timeout', 'unavailable', 'invalid_response'] },
}, { versionKey: false });
readingSchema.index({ deviceId: 1, observedAt: -1 });
readingSchema.index({ receivedAt: -1 });
readingSchema.index({ deviceId: 1, eventId: 1 }, {
  unique: true, partialFilterExpression: { eventId: { $type: 'string' } },
});
const alertSchema = new Schema({
  deviceId,
  readingId: { type: Schema.Types.ObjectId, required: function() { return this.kind !== 'security'; } },
  kind: { type: String, enum: ['safety', 'sos', 'fault', 'security'], required: true },
  field: { type: String, required: true },
  message: { type: String, required: true },
  observedAt: { type: Date, required: true },
  acknowledgedAt: Date,
  resolvedAt: Date,
  resolution: { type: String, maxlength: 1000 },
  severity: { type: String, enum: ['info', 'warning', 'high', 'critical'] },
  securityEventId: { type: Schema.Types.ObjectId, ref: 'SecurityEvent' },
  activeSecurityKey: { type: String, maxlength: 400 },
  acknowledgedBy: String, resolvedBy: String, demoScope: String,
  // resilliox-v1 extensions.
  zoneId: { type: String, maxlength: 128 },
  incidentId: { type: String, maxlength: 256 },
  source: { type: String, enum: ['hardware', 'simulation','operator','system'] },
  riskScore: { type: Number, min: 0, max: 100 },
  riskClassification: { type: String, enum: ['NORMAL', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'] },
  recurrent: Boolean,
}, { timestamps: true, versionKey: false });
alertSchema.index({ deviceId: 1, createdAt: -1 });
alertSchema.index({ createdAt: -1 });
alertSchema.index({ activeSecurityKey: 1 }, { unique: true, partialFilterExpression: { activeSecurityKey: { $type: 'string' } } });
const deviceSchema = new Schema({
  deviceId: { ...deviceId, unique: true },
  lastSeenAt: Date,
  name: { type: String, maxlength: 100 },
  area: { type: String, maxlength: 100 },
  // resilliox-v1 extensions.
  buildingId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  firmwareVersion: { type: String, maxlength: 32 },
  floorId: { type: String, maxlength: 128 },
  online: Boolean,
  lastStatusAt: Date,
  lastAvailability: { type: String, enum: ['online', 'offline'] },
  lastAvailabilityAt: Date,
  cameraOnline: Boolean,
  cameraStatusAt: Date,
  cameraSource: { type: String, enum: ['hardware','simulation'] },
  securityType: { type: String, enum: ['pir','camera','access'] },
  securitySource: { type: String, enum: ['hardware','simulation'] },
  securityDemoScope: String,
  securityVersion: { type: Number, default: 0 },
  motionActive: Boolean, lastMotionAt: Date,
}, { timestamps: true, versionKey: false });
const maintenanceSchema = new Schema({
  deviceId,
  kind: { type: String, enum: ['maintenance', 'fault'], required: true },
  note: { type: String, required: true, maxlength: 1000 },
  occurredAt: { type: Date, required: true },
}, { timestamps: true, versionKey: false });
maintenanceSchema.index({ deviceId: 1, occurredAt: -1 });
maintenanceSchema.index({ occurredAt: -1 });
// Risk engine output per analyzed reading (collection: risk_analyses).
const riskAnalysisSchema = new Schema({
  deviceId,
  messageId: { type: String, maxlength: 128 },
  readingId: { type: Schema.Types.ObjectId },
  observedAt: { type: Date, required: true },
  analyzedAt: { type: Date, required: true },
  score: { type: Number, required: true, min: 0, max: 100 },
  classification: { type: String, enum: ['NORMAL', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL'], required: true },
  factors: { type: [Schema.Types.Mixed], default: [] },
  incidents: { type: [Schema.Types.Mixed], default: [] },
  dataQuality: Schema.Types.Mixed,
  features: { type: Map, of: Schema.Types.Mixed },
  modelVersion: { type: String, maxlength: 64 },
  engineVersion: { type: String, maxlength: 32 },
  stale: Boolean,
  zoneId: { type: String, maxlength: 128 },
  source: { type: String, enum: ['hardware', 'simulation'] },
}, { versionKey: false });
riskAnalysisSchema.index({ deviceId: 1, analyzedAt: -1 });
riskAnalysisSchema.index({ analyzedAt: -1 });
riskAnalysisSchema.index({ classification: 1, analyzedAt: -1 });
export const SensorReading = mongoose.model('SensorReading', readingSchema);
export const Alert = mongoose.model('Alert', alertSchema);
export const Device = mongoose.model('Device', deviceSchema);
export const RiskAnalysis = mongoose.model('RiskAnalysis', riskAnalysisSchema);
export const MaintenanceEvent = mongoose.model('MaintenanceEvent', maintenanceSchema);
const taskSchema = new Schema({
  deviceId,
  alertId: { type: Schema.Types.ObjectId, ref: 'Alert' },
  incidentId: { type: String, maxlength: 256 },
  buildingId: { type: String, maxlength: 128 },
  floorId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  source: { type: String, enum: ['hardware','simulation'] },
  riskScore: { type: Number, min: 0, max: 100 },
  riskClassification: { type: String, enum: ['NORMAL','LOW','MODERATE','HIGH','CRITICAL'] },
  // Present only on active incident-linked tasks. Unique across open/in_progress.
  activeIncidentKey: { type: String, maxlength: 400 },
  description: { type: String, required: true, maxlength: 1000 },
  priority: { type: String, enum: ['low', 'normal', 'high', 'critical'], default: 'normal' },
  status: { type: String, enum: ['open', 'in_progress', 'completed'], default: 'open' },
  dueAt: { type: Date, required: true },
  completedAt: Date,
}, { timestamps: true, versionKey: false });
taskSchema.index({ deviceId: 1, dueAt: 1 });
taskSchema.index({ status: 1, dueAt: 1 });
taskSchema.index({ activeIncidentKey: 1 }, { unique: true,
  partialFilterExpression: { activeIncidentKey: { $type: 'string' } } });
export const MaintenanceTask = mongoose.model('MaintenanceTask', taskSchema);
// ESP32-CAM snapshot metadata + bounded JPEG bytes. Snapshots never travel over
// MQTT; they are fetched server-side from a configured camera URL only.
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024; // 2 MiB hard cap per snapshot.
const cameraSnapshotSchema = new Schema({
  deviceId,
  buildingId: { type: String, maxlength: 128 },
  floorId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  contentType: { type: String, required: true, maxlength: 64 },
  byteSize: { type: Number, required: true, min: 1, max: MAX_SNAPSHOT_BYTES },
  capturedAt: { type: Date, required: true },
  source: { type: String, enum: ['hardware', 'simulation'] },
  // Optional links to the incident this snapshot was taken for.
  alertIds: { type: [Schema.Types.ObjectId], default: [] },
  demoScope: String,
  image: { type: Buffer, required: true, select: false },
}, { versionKey: false });
cameraSnapshotSchema.index({ deviceId: 1, capturedAt: -1 });
cameraSnapshotSchema.index({ capturedAt: -1 });
export const CameraSnapshot = mongoose.model('CameraSnapshot', cameraSnapshotSchema);
export const MAX_CAMERA_SNAPSHOT_BYTES = MAX_SNAPSHOT_BYTES;

export {
  User, ROLES, ROLE_PERMISSIONS, hashPassword, verifyPassword,
  EmergencyIncident,
  MaintenanceTicket, TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES,
};

export async function ensureIndexes() {
  for (const model of [SensorReading, Alert, Device, RiskAnalysis, MaintenanceEvent, MaintenanceTask, CameraSnapshot, User, EmergencyIncident, MaintenanceTicket, ...securityModels]) await model.createIndexes();
}
