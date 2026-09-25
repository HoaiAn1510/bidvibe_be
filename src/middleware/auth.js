const { auth } = require('../config/firebase');
const { AppError } = require('./errorHandler');

// Xác thực Firebase ID token từ header: Authorization: Bearer <token>
const verifyToken = async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new AppError('Thiếu token xác thực', 401, 'UNAUTHORIZED');

    req.user = await auth.verifyIdToken(token);
    next();
  } catch (err) {
    next(err instanceof AppError ? err : new AppError('Token không hợp lệ', 401, 'UNAUTHORIZED'));
  }
};

module.exports = { verifyToken };
