import { mongoose } from '../config/database.js';

const { Schema } = mongoose;

const timelineEntrySchema = new Schema({
  action: { 
    type: String, 
    required: true, 
    enum: ['triggered', 'acknowledged', 'dispatched', 'buzzer_silenced', 'buzzer_activated', 'resolved', 'cancelled', 'maintenance_linked'] 
  },
  actor: { type: String, required: true },
  role: { type: String, default: 'operator' },
  timestamp: { type: Date, default: Date.now },
  notes: { type: String, maxlength: 500, default: '' },
}, { _id: false });

const emergencySchema = new Schema({
  emergencyId: { type: String, required: true, unique: true, index: true },
  alertId: { type: Schema.Types.ObjectId, ref: 'Alert' },
  deviceId: { type: String, maxlength: 128, default: 'manual' },
  buildingId: { type: String, maxlength: 128, default: 'Building-1' },
  floorId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  room: { type: String, maxlength: 100 },
  status: { 
    type: String, 
    enum: ['active', 'acknowledged', 'responding', 'resolved', 'cancelled'], 
    default: 'active',
    index: true 
  },
  triggerSource: { 
    type: String, 
    enum: ['hardware', 'simulation', 'web_ui', 'operator'], 
    default: 'web_ui' 
  },
  severity: { type: String, enum: ['warning', 'critical'], default: 'critical' },
  reportedBy: {
    userId: String,
    name: { type: String, default: 'Anonymous / SOS' },
    email: String,
    role: { type: String, default: 'student' },
    phone: String,
  },
  message: { type: String, required: true, maxlength: 500 },
  buzzerState: { type: String, enum: ['active', 'silenced', 'off'], default: 'active' },
  timeline: { type: [timelineEntrySchema], default: [] },
  acknowledgedAt: Date,
  acknowledgedBy: {
    userId: String,
    name: String,
    role: String,
  },
  responseDispatchedAt: Date,
  responderUnit: { type: String, maxlength: 100 },
  resolvedAt: Date,
  resolvedBy: {
    userId: String,
    name: String,
    role: String,
  },
  resolutionNotes: { type: String, maxlength: 1000 },
  linkedTicketId: { type: String, maxlength: 64 },
}, { timestamps: true, versionKey: false });

emergencySchema.index({ status: 1, createdAt: -1 });
emergencySchema.index({ buildingId: 1, status: 1 });
emergencySchema.index({ deviceId: 1, createdAt: -1 });

export const EmergencyIncident = mongoose.model('EmergencyIncident', emergencySchema);
