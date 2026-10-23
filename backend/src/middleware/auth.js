import { timingSafeEqual, createHmac } from 'node:crypto';
import { User, ROLE_PERMISSIONS } from '../models/index.js';

export function signToken(payload, secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now() })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function decodeAndVerifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const expectedSig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const sigBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSig);
  if (sigBuffer.length !== expectedBuffer.length || !timingSafeEqual(sigBuffer, expectedBuffer)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data;
  } catch {
    return null;
  }
}

export function requireToken(config) {
  return async (req, res, next) => {
    const authHeader = req.get('authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, message: 'Authorization header with Bearer token required' });
    }

    const token = authHeader.slice(7).trim();

    // 1. Direct IoT operator token match (fast path for firmware, scripts, integration tests)
    if (config.apiToken && config.apiToken.length >= 32) {
      const actual = Buffer.from(token);
      const expected = Buffer.from(config.apiToken);
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        req.user = {
          userId: 'operator-system',
          name: 'System Operator',
          email: 'operator@rbrick.local',
          role: 'admin',
          permissions: ['*'],
          isOperator: true,
        };
        return next();
      }
    }

    // 2. User signed token verification
    const secret = config.apiToken || 'resilliox-default-secure-signing-key-32chars';
    const decoded = decodeAndVerifyToken(token, secret);
    if (!decoded || !decoded.userId) {
      return res.status(401).json({ success: false, message: 'Invalid or expired authentication token' });
    }

    // Attach user information from token or database
    try {
      if (req.app?.locals?.databaseConnected || true) {
        const dbUser = await User.findOne({ userId: decoded.userId }).lean();
        if (dbUser) {
          if (!dbUser.isActive) {
            return res.status(403).json({ success: false, message: 'Account is deactivated' });
          }
          req.user = {
            id: dbUser._id.toString(),
            userId: dbUser.userId,
            name: dbUser.name,
            email: dbUser.email,
            phone: dbUser.phone,
            company: dbUser.company,
            role: dbUser.role,
            department: dbUser.department,
            permissions: ROLE_PERMISSIONS[dbUser.role] || [],
          };
          return next();
        }
      }

      // Fallback to decoded token data if database record lookup is skipped
      req.user = {
        userId: decoded.userId,
        name: decoded.name || 'User',
        email: decoded.email || '',
        role: decoded.role || 'student',
        permissions: ROLE_PERMISSIONS[decoded.role] || ['status:view_basic'],
      };
      return next();
    } catch (err) {
      return res.status(503).json({ success: false, message: 'Authentication verification service error' });
    }
  };
}

export function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (req.user.role === 'admin' || req.user.permissions?.includes('*')) {
      return next();
    }
    if (allowedRoles.includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ 
      success: false, 
      message: `Access denied. Requires one of: ${allowedRoles.join(', ')}` 
    });
  };
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    if (req.user.permissions?.includes('*') || req.user.permissions?.includes(permission)) {
      return next();
    }
    return res.status(403).json({ 
      success: false, 
      message: `Access denied. Missing permission: ${permission}` 
    });
  };
}
