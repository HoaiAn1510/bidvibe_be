const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/db');

// Sự kiện server -> client (chi tiết: docs/socket.md):
//   auction:update        lượt giá mới (reason 'bid') hoặc tạm dừng / tiếp tục (reason 'paused' | 'resumed')
//   auction:ended         { auctionId, hasWinner, cancelled? }
//   notification:new      { id, type, title, createdAt }   (phòng user:<id>)
//   account:disconnected  { code, message }  ngay trước khi server ngắt kết nối (disconnectAccount)
// Sự kiện client -> server:
//   auction:join <auctionId> / auction:leave <auctionId>

// Phòng riêng theo tài khoản. accounts.id và ops_accounts.id là hai dãy số riêng nên phải tách tiền tố.
const accountRoom = (kind, id) => (kind === 'ops' ? `ops:${id}` : `user:${id}`);

module.exports = (io) => {
  // Bắt buộc JWT hợp lệ VÀ tài khoản còn hoạt động (giống requireAuth của REST):
  // tài khoản bị khoá không kết nối lại được sau khi bị ngắt.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token
      || (socket.handshake.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return next(new Error('UNAUTHORIZED'));
    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      return next(new Error('UNAUTHORIZED'));
    }
    try {
      const table = payload.kind === 'ops' ? 'ops_accounts' : 'accounts';
      const { rows } = await pool.query(`SELECT status FROM ${table} WHERE id = $1`, [payload.sub]);
      if (!rows[0]) return next(new Error('UNAUTHORIZED'));
      if (rows[0].status !== 'active') return next(new Error('ACCOUNT_SUSPENDED'));
    } catch (err) {
      console.error('[socket] kiểm tra tài khoản lỗi:', err.message);
      return next(new Error('INTERNAL_ERROR'));
    }
    socket.data.user = { id: String(payload.sub), kind: payload.kind, role: payload.role };
    next();
  });

  io.on('connection', (socket) => {
    const { id, kind } = socket.data.user;
    // user:<id> nhận thông báo (bị vượt giá, thắng phiên...); ops:<id> chỉ để ngắt khi bị khoá.
    socket.join(accountRoom(kind, id));

    socket.on('auction:join', (auctionId) => socket.join(`auction:${auctionId}`));
    socket.on('auction:leave', (auctionId) => socket.leave(`auction:${auctionId}`));
  });
};

module.exports.accountRoom = accountRoom;
