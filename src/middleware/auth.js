const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { AppError } = require('./errorHandler');

// Xác thực JWT tự ký từ header: Authorization: Bearer <token>
// Payload token: { sub: id, kind: 'account' | 'ops', role }
const requireAuth = (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Thiếu token xác thực', 401, 'UNAUTHORIZED');

    const payload = jwt.verify(token, env.jwtSecret);
    req.user = { id: payload.sub, kind: payload.kind, role: payload.role };
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError('Token không hợp lệ hoặc đã hết hạn', 401, 'UNAUTHORIZED'));
  }
};

// Chỉ cho phép tiếp tục nếu req.user.role nằm trong danh sách role cho phép.
// Dùng sau requireAuth: router.get('/x', requireAuth, requireRole('admin'), handler)
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new AppError('Thiếu token xác thực', 401, 'UNAUTHORIZED'));
  if (!roles.includes(req.user.role)) {
    return next(new AppError('Bạn không có quyền thực hiện thao tác này', 403, 'FORBIDDEN'));
  }
  next();
};

module.exports = { requireAuth, requireRole };
