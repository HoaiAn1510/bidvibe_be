const jwt = require('jsonwebtoken');
const env = require('../config/env');

// Sự kiện server -> client:
//   auction:update  { auctionId, currentPrice, bidCount, endsAt, bid: { who, amount, at } }
//   auction:ended   { auctionId, hasWinner }
//   notification:new { id, type, title, createdAt }   (gửi vào phòng user:<id>)
// Sự kiện client -> server:
//   auction:join <auctionId> / auction:leave <auctionId>
module.exports = (io) => {
  // Bắt buộc xác thực JWT khi kết nối: io(url, { auth: { token } })
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token
      || (socket.handshake.headers.authorization || '').replace(/^Bearer /, '');
    if (!token) return next(new Error('UNAUTHORIZED'));
    try {
      const payload = jwt.verify(token, env.jwtSecret);
      socket.data.user = { id: String(payload.sub), kind: payload.kind, role: payload.role };
      next();
    } catch {
      next(new Error('UNAUTHORIZED'));
    }
  });

  io.on('connection', (socket) => {
    const { id, kind } = socket.data.user;
    // Phòng riêng của người dùng để đẩy thông báo (bị vượt giá, thắng phiên...)
    if (kind === 'account') socket.join(`user:${id}`);

    socket.on('auction:join', (auctionId) => socket.join(`auction:${auctionId}`));
    socket.on('auction:leave', (auctionId) => socket.leave(`auction:${auctionId}`));
  });
};
