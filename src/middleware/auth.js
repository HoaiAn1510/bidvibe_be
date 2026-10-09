const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/db');
const { AppError } = require('./errorHandler');

// Xác thực JWT tự ký từ header: Authorization: Bearer <token>
// Payload token: { sub: id, kind: 'account' | 'ops', role }
// Token còn hạn chưa đủ: kiểm tra lại trạng thái tài khoản trong DB (một truy vấn theo khoá
// chính) để tài khoản bị khoá không dùng tiếp được token cũ.
const requireAuth = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Thiếu token xác thực', 401, 'UNAUTHORIZED');

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw new AppError('Token không hợp lệ hoặc đã hết hạn', 401, 'UNAUTHORIZED');
    }

    const table = payload.kind === 'ops' ? 'ops_accounts' : 'accounts';
    const { rows } = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [payload.sub]);
    if (!rows[0]) throw new AppError('Tài khoản không còn tồn tại', 401, 'UNAUTHORIZED');
    if (rows[0].status !== 'active') {
      throw new AppError('Tài khoản đã bị tạm khoá', 403, 'ACCOUNT_SUSPENDED');
    }

    req.user = { id: String(payload.sub), kind: payload.kind, role: payload.role };
    next();
  } catch (err) {
    next(err);
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
