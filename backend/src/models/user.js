import { mongoose } from '../config/database.js';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const { Schema } = mongoose;

export const ROLES = [
  'student',
  'faculty_staff',
  'security_guard',
  'maintenance_staff',
  'facility_manager',
  'admin'
];

export const ROLE_PERMISSIONS = {
  student: [
    'emergency:trigger',
    'maintenance:create',
    'status:view_basic'
  ],
  faculty_staff: [
    'emergency:trigger',
    'maintenance:create',
    'status:view_basic',
    'building:view'
  ],
  security_guard: [
    'emergency:trigger',
    'emergency:acknowledge',
    'emergency:respond',
    'security:view',
    'security:manage',
    'visitors:manage',
    'cameras:view',
    'maintenance:create'
  ],
  maintenance_staff: [
    'emergency:trigger',
    'maintenance:create',
    'maintenance:view_assigned',
    'maintenance:work',
    'maintenance:upload_photo',
    'status:view_basic'
  ],
  facility_manager: [
    'emergency:trigger',
    'emergency:acknowledge',
    'emergency:respond',
    'emergency:resolve',
    'maintenance:create',
    'maintenance:assign',
    'maintenance:work',
    'maintenance:verify',
    'maintenance:close',
    'security:view',
    'analytics:view',
    'reports:export',
    'building:manage'
  ],
  admin: [
    '*' // Full administrative access
  ]
};

const userSchema = new Schema({
  userId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true, maxlength: 100, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  phone: { type: String, maxlength: 30, default: '' },
  company: { type: String, maxlength: 100, default: 'ResillioX' },
  passwordHash: { type: String, required: true, select: false },
  salt: { type: String, required: true, select: false },
  role: { type: String, enum: ROLES, default: 'student', index: true },
  department: { type: String, maxlength: 100, default: '' },
  isActive: { type: Boolean, default: true },
  lastLoginAt: Date,
}, { timestamps: true, versionKey: false });

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  const hashBuffer = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  if (hashBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(hashBuffer, expectedBuffer);
}

export const User = mongoose.model('User', userSchema);
