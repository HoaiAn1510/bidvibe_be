const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { pool } = require('../config/db');
const { emitViewers } = require('./viewers');

// Sự kiện server -> client (chi tiết: docs/socket.md):
//   auction:update        lượt giá mới (reason 'bid'), tạm dừng / tiếp tục (reason 'paused' | 'resumed'), hoặc đổi giờ kết thúc
//                         bằng API dev (reason 'dev_time', chỉ khi DEV_TOOLS=true)
//   auction:ended         { auctionId, hasWinner, cancelled? }
//   auction:viewers       { auctionId, viewers }  số tài khoản đang xem phiên (khi có người vào / rời / ngắt)
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

    // Vào / rời phòng phiên thì phát lại số người đang xem (auction:viewers) cho cả phòng.
    socket.on('auction:join', async (auctionId) => {
      await socket.join(`auction:${auctionId}`);
      emitViewers(auctionId);
    });
    socket.on('auction:leave', async (auctionId) => {
      await socket.leave(`auction:${auctionId}`);
      emitViewers(auctionId);
    });
    // 'disconnecting' (chưa rời phòng) để biết socket đang ở những phòng phiên nào; loại chính nó khi đếm.
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (room.startsWith('auction:')) emitViewers(room.slice('auction:'.length), { excludeSocketId: socket.id });
      }
    });
  });
};

module.exports.accountRoom = accountRoom;
