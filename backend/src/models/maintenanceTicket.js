import { mongoose } from '../config/database.js';

const { Schema } = mongoose;

export const TICKET_CATEGORIES = [
  'electrical',
  'plumbing',
  'hvac',
  'structural',
  'fire_safety',
  'sensor_iot',
  'general'
];

export const TICKET_PRIORITIES = ['low', 'medium', 'normal', 'high', 'critical'];

export const TICKET_STATUSES = [
  'reported',
  'assigned',
  'in_progress',
  'repair_completed',
  'verified_closed',
  'reopened'
];

const ticketPhotoSchema = new Schema({
  photoId: { type: String, required: true },
  filename: { type: String, required: true, maxlength: 200 },
  contentType: { type: String, required: true, maxlength: 64 },
  byteSize: { type: Number, required: true, max: 10 * 1024 * 1024 },
  caption: { type: String, maxlength: 200, default: '' },
  storagePath: { type: String },
  url: { type: String },
  data: { type: String }, // Optional Base64 fallback
  uploadedAt: { type: Date, default: Date.now },
  uploadedBy: {
    userId: String,
    name: String,
  },
}, { _id: false });

const ticketNoteSchema = new Schema({
  noteId: { type: String, required: true },
  author: { type: String, required: true },
  role: { type: String, default: 'staff' },
  text: { type: String, required: true, maxlength: 1000 },
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const ticketHistorySchema = new Schema({
  action: { type: String, required: true },
  fromStatus: String,
  toStatus: String,
  actor: { type: String, required: true },
  role: { type: String, default: 'operator' },
  timestamp: { type: Date, default: Date.now },
  notes: { type: String, maxlength: 1000, default: '' },
}, { _id: false });

const maintenanceTicketSchema = new Schema({
  ticketId: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true, maxlength: 200, trim: true },
  description: { type: String, required: true, maxlength: 2000, trim: true },
  buildingId: { type: String, maxlength: 128, default: 'Building-1' },
  floorId: { type: String, maxlength: 128 },
  zoneId: { type: String, maxlength: 128 },
  room: { type: String, maxlength: 100 },
  location: { type: String, maxlength: 200, default: '' },
  category: { type: String, enum: TICKET_CATEGORIES, default: 'general', index: true },
  priority: { type: String, enum: TICKET_PRIORITIES, default: 'normal', index: true },
  status: { type: String, enum: TICKET_STATUSES, default: 'reported', index: true },
  source: { 
    type: String, 
    enum: ['manual_report', 'safety_event', 'emergency_incident', 'iot_alert'], 
    default: 'manual_report' 
  },
  deviceId: { type: String, maxlength: 128 },
  alertId: { type: Schema.Types.ObjectId, ref: 'Alert' },
  emergencyId: { type: String, maxlength: 64 },
  reporter: {
    userId: String,
    name: { type: String, default: 'Building Occupant' },
    email: String,
    role: { type: String, default: 'student' },
    phone: String,
  },
  assignedTo: {
    userId: String,
    name: String,
    email: String,
    role: String,
    assignedAt: Date,
  },
  repairDetails: {
    completedAt: Date,
    completedBy: {
      userId: String,
      name: String,
    },
    workPerformed: { type: String, maxlength: 2000 },
    partsUsed: { type: String, maxlength: 1000 },
    laborHours: { type: Number, min: 0 },
    notes: { type: String, maxlength: 1000 },
    photoUrl: String,
  },
  verificationDetails: {
    verifiedAt: Date,
    verifiedBy: {
      userId: String,
      name: String,
    },
    notes: { type: String, maxlength: 1000 },
    rating: { type: Number, min: 1, max: 5 },
  },
  reopenDetails: {
    reopenedAt: Date,
    reopenedBy: {
      userId: String,
      name: String,
    },
    reason: { type: String, maxlength: 1000 },
  },
  photos: { type: [ticketPhotoSchema], default: [] },
  notes: { type: [ticketNoteSchema], default: [] },
  history: { type: [ticketHistorySchema], default: [] },
  dueAt: { type: Date, required: true },
  completedAt: Date,
  verifiedAt: Date,
}, { timestamps: true, versionKey: false });

maintenanceTicketSchema.index({ status: 1, priority: 1, dueAt: 1 });
maintenanceTicketSchema.index({ 'assignedTo.userId': 1, status: 1 });
maintenanceTicketSchema.index({ category: 1, createdAt: -1 });
maintenanceTicketSchema.index({ deviceId: 1, createdAt: -1 });
maintenanceTicketSchema.index({ alertId: 1 });

export const MaintenanceTicket = mongoose.model('MaintenanceTicket', maintenanceTicketSchema);
