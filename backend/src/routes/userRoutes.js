import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { User, ROLES, ROLE_PERMISSIONS, hashPassword } from '../models/index.js';
import { requireToken, requireRole } from '../middleware/auth.js';

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  search: z.string().trim().max(100).optional(),
});

const createUserSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().email().toLowerCase(),
  password: z.string().min(6).max(200).default('ResillioX@2026'),
  phone: z.string().trim().max(30).optional(),
  company: z.string().trim().max(100).default('ResillioX'),
  role: z.enum(ROLES).default('student'),
  department: z.string().trim().max(100).optional(),
});

const updateUserSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().max(30).optional(),
  company: z.string().trim().max(100).optional(),
  role: z.enum(ROLES).optional(),
  department: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
});

export function userRoutes(config) {
  const router = Router();

  // All user management routes require admin role
  router.use(requireToken(config), requireRole('admin'));

  // GET /api/users
  router.get('/', async (req, res) => {
    const q = listQuerySchema.parse(req.query);
    const filter = {};

    if (q.role) filter.role = q.role;
    if (q.status === 'active') filter.isActive = true;
    if (q.status === 'inactive') filter.isActive = false;

    if (q.search) {
      filter.$or = [
        { name: { $regex: q.search, $options: 'i' } },
        { email: { $regex: q.search, $options: 'i' } },
        { department: { $regex: q.search, $options: 'i' } },
      ];
    }

    const [items, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    const sanitized = items.map(u => ({
      id: u._id.toString(),
      userId: u.userId,
      name: u.name,
      email: u.email,
      phone: u.phone,
      company: u.company,
      role: u.role,
      department: u.department,
      isActive: u.isActive,
      lastLoginAt: u.lastLoginAt,
      createdAt: u.createdAt,
    }));

    res.json({ success: true, items: sanitized, total, page: q.page, limit: q.limit });
  });

  // POST /api/users
  router.post('/', async (req, res) => {
    const body = createUserSchema.parse(req.body);

    const exists = await User.findOne({ email: body.email }).lean();
    if (exists) {
      return res.status(409).json({ success: false, message: 'User with this email already exists' });
    }

    const { salt, hash } = hashPassword(body.password);
    const userId = 'usr_' + randomUUID().slice(0, 8);

    const user = await User.create({
      userId,
      name: body.name,
      email: body.email,
      phone: body.phone || '',
      company: body.company || 'ResillioX',
      passwordHash: hash,
      salt,
      role: body.role,
      department: body.department || '',
      isActive: true,
    });

    res.status(201).json({
      success: true,
      item: {
        id: user._id.toString(),
        userId: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        company: user.company,
        role: user.role,
        department: user.department,
        isActive: user.isActive,
        createdAt: user.createdAt,
      },
    });
  });

  // GET /api/users/:id
  router.get('/:id', async (req, res) => {
    const id = req.params.id;
    const user = await User.findOne({
      $or: [{ userId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    }).lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    res.json({
      success: true,
      item: {
        id: user._id.toString(),
        userId: user.userId,
        name: user.name,
        email: user.email,
        phone: user.phone,
        company: user.company,
        role: user.role,
        department: user.department,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
    });
  });

  // PATCH /api/users/:id
  router.patch('/:id', async (req, res) => {
    const id = req.params.id;
    const body = updateUserSchema.parse(req.body);

    const targetUser = await User.findOne({
      $or: [{ userId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Protect against demoting or deactivating the last active admin
    if (targetUser.role === 'admin' && (body.role !== undefined && body.role !== 'admin' || body.isActive === false)) {
      const activeAdminCount = await User.countDocuments({ role: 'admin', isActive: true });
      if (activeAdminCount <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot deactivate or change role of the last active administrator' });
      }
    }

    Object.assign(targetUser, body);
    await targetUser.save();

    res.json({
      success: true,
      item: {
        id: targetUser._id.toString(),
        userId: targetUser.userId,
        name: targetUser.name,
        email: targetUser.email,
        phone: targetUser.phone,
        company: targetUser.company,
        role: targetUser.role,
        department: targetUser.department,
        isActive: targetUser.isActive,
        updatedAt: targetUser.updatedAt,
      },
    });
  });

  // DELETE /api/users/:id (Deactivate)
  router.delete('/:id', async (req, res) => {
    const id = req.params.id;
    const targetUser = await User.findOne({
      $or: [{ userId: id }, ...(id.match(/^[0-9a-fA-F]{24}$/) ? [{ _id: id }] : [])]
    });

    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (targetUser.role === 'admin') {
      const activeAdminCount = await User.countDocuments({ role: 'admin', isActive: true });
      if (activeAdminCount <= 1) {
        return res.status(400).json({ success: false, message: 'Cannot deactivate or delete the last active administrator' });
      }
    }

    targetUser.isActive = false;
    await targetUser.save();

    res.json({ success: true, message: 'User deactivated successfully' });
  });

  return router;
}
