import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { User, ROLES, ROLE_PERMISSIONS, hashPassword, verifyPassword } from '../models/index.js';
import { signToken, requireToken } from '../middleware/auth.js';

const emailSchema = z.string().trim().email().toLowerCase();
const phoneSchema = z.string().trim().max(30).optional();
const nameSchema = z.string().trim().min(2).max(100);

const loginSchema = z.object({
  email: z.string().trim().email().toLowerCase().optional(),
  phone: z.string().trim().optional(),
  password: z.string().min(1).max(200).optional(),
  name: z.string().trim().max(100).optional(),
  company: z.string().trim().max(100).optional(),
  isSignUp: z.boolean().optional(),
});

const registerSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  password: z.string().min(6).max(200).optional(),
  phone: phoneSchema,
  company: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).default('student'),
  department: z.string().trim().max(100).optional(),
});

const updateProfileSchema = z.object({
  name: nameSchema.optional(),
  phone: phoneSchema,
  company: z.string().trim().max(100).optional(),
  department: z.string().trim().max(100).optional(),
});

export function authRoutes(config, status) {
  const router = Router();
  const secret = config.apiToken || 'resilliox-default-secure-signing-key-32chars';

  // Seed default administrator if database is connected and no users exist
  const ensureDefaultAdmin = async () => {
    try {
      if (!status.database) return;
      const count = await User.countDocuments();
      if (count === 0) {
        const { salt, hash } = hashPassword('Admin@12345');
        await User.create({
          userId: 'usr_admin_' + randomUUID().slice(0, 8),
          name: 'System Administrator',
          email: 'admin@resilliox.local',
          phone: '+919999999999',
          company: 'RBrick Admin',
          passwordHash: hash,
          salt,
          role: 'admin',
          department: 'Building Operations & Safety',
          isActive: true,
        });
        console.log('Default administrator account created: admin@resilliox.local');
      }
    } catch (err) {
      // Non-blocking in case of concurrency or index collision
    }
  };

  // POST /api/auth/login
  router.post('/login', async (req, res) => {
    await ensureDefaultAdmin();
    const body = loginSchema.parse(req.body);

    let query = {};
    if (body.email) query.email = body.email;
    else if (body.phone) query.phone = body.phone;
    else return res.status(400).json({ success: false, message: 'Email or phone number is required' });

    let user = await User.findOne(query).select('+passwordHash +salt');

    // If account doesn't exist but isSignUp flag is present from the frontend form
    if (!user && (body.isSignUp || body.name)) {
      const { salt, hash } = hashPassword(body.password || 'ResillioX@2026');
      const userId = 'usr_' + randomUUID().slice(0, 8);
      user = await User.create({
        userId,
        name: body.name || 'Building Occupant',
        email: body.email || `user_${userId}@rbrick.local`,
        phone: body.phone || '',
        company: body.company || 'RBrick Occupant',
        passwordHash: hash,
        salt,
        role: 'student',
        department: 'Campus',
        isActive: true,
        lastLoginAt: new Date(),
      });
    } else if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials or user not found' });
    } else {
      // Verify password if user has password set and password is provided in request
      if (body.password && user.passwordHash && user.salt) {
        const valid = verifyPassword(body.password, user.salt, user.passwordHash);
        if (!valid) {
          return res.status(401).json({ success: false, message: 'Incorrect password' });
        }
      }
      if (!user.isActive) {
        return res.status(403).json({ success: false, message: 'Account is deactivated. Contact an administrator.' });
      }
      user.lastLoginAt = new Date();
      await user.save();
    }

    const tokenPayload = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    const token = signToken(tokenPayload, secret);
    const safeUser = {
      id: user._id.toString(),
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      company: user.company,
      role: user.role,
      department: user.department,
      permissions: ROLE_PERMISSIONS[user.role] || [],
      lastLoginAt: user.lastLoginAt,
    };

    res.json({ success: true, token, user: safeUser });
  });

  // POST /api/auth/register
  router.post('/register', async (req, res) => {
    await ensureDefaultAdmin();
    const body = registerSchema.parse(req.body);

    const existing = await User.findOne({ email: body.email }).lean();
    if (existing) {
      return res.status(409).json({ success: false, message: 'Email is already registered' });
    }

    const { salt, hash } = hashPassword(body.password || 'ResillioX@2026');
    const userId = 'usr_' + randomUUID().slice(0, 8);

    const user = await User.create({
      userId,
      name: body.name,
      email: body.email,
      phone: body.phone || '',
      company: body.company || 'RBrick',
      passwordHash: hash,
      salt,
      role: body.role || 'student',
      department: body.department || '',
      isActive: true,
      lastLoginAt: new Date(),
    });

    const tokenPayload = {
      userId: user.userId,
      name: user.name,
      email: user.email,
      role: user.role,
    };

    const token = signToken(tokenPayload, secret);
    const safeUser = {
      id: user._id.toString(),
      userId: user.userId,
      name: user.name,
      email: user.email,
      phone: user.phone,
      company: user.company,
      role: user.role,
      department: user.department,
      permissions: ROLE_PERMISSIONS[user.role] || [],
    };

    res.status(201).json({ success: true, token, user: safeUser });
  });

  // GET /api/auth/me
  router.get('/me', requireToken(config), async (req, res) => {
    res.json({ success: true, user: req.user });
  });

  // PUT /api/auth/profile
  router.put('/profile', requireToken(config), async (req, res) => {
    const body = updateProfileSchema.parse(req.body);
    const user = await User.findOneAndUpdate(
      { userId: req.user.userId },
      { $set: body },
      { returnDocument: 'after', runValidators: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, message: 'User profile not found' });
    }

    res.json({
      success: true,
      user: {
        id: user._id.toString(),
        userId: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        company: user.company,
        role: user.role,
        department: user.department,
        permissions: ROLE_PERMISSIONS[user.role] || [],
      },
    });
  });

  // POST /api/auth/logout
  router.post('/logout', (req, res) => {
    res.json({ success: true, message: 'Logged out successfully' });
  });

  return router;
}
