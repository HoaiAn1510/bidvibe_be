const registerAuctionSocket = require('./auction_socket');

const { accountRoom } = registerAuctionSocket;

let ioInstance = null;

// Khởi tạo các handler Socket.io
const registerSockets = (io) => {
  ioInstance = io;
  registerAuctionSocket(io);
};

// Cho service đẩy sự kiện real-time mà không cần truyền io qua từng hàm.
// Trả về null khi chưa khởi tạo (ví dụ chạy script/test không có server).
registerSockets.getIo = () => ioInstance;

// Ngắt socket của tài khoản trong RIÊNG tiến trình này. pause_listener.js cũng gọi hàm này khi nhận
// lệnh 'disconnect' từ backend khác qua kênh bidvibe_events.
registerSockets.disconnectLocal = async (accountId, { kind = 'account', reason } = {}) => {
  const io = ioInstance;
  if (!io || accountId == null) return 0;
  const room = accountRoom(kind === 'ops' ? 'ops' : 'account', String(accountId));
  const sockets = await io.in(room).fetchSockets();
  if (!sockets.length) return 0;
  io.to(room).emit('account:disconnected', {
    code: 'ACCOUNT_SUSPENDED',
    message: reason || 'Tài khoản đã bị tạm khoá',
  });
  io.in(room).disconnectSockets(true);
  return sockets.length;
};

// Ngắt mọi kết nối socket đang mở của một tài khoản (gọi khi Admin khoá tài khoản).
//   accountId  id của accounts (Bidder/Seller) hoặc ops_accounts nếu kind = 'ops'
//   options    { kind: 'account' | 'ops' = 'account', reason?: string }
// Trước khi ngắt, gửi `account:disconnected` { code: 'ACCOUNT_SUSPENDED', message } để app hiện lý do
// và không tự kết nối lại. Đồng thời gửi lệnh qua kênh bidvibe_events để các backend khác cùng
// database cũng gửi account:disconnected rồi ngắt socket của tài khoản này.
// Trả về Promise<number>: số kết nối đã ngắt ở RIÊNG tiến trình này (0 nếu không online ở đây hoặc
// server socket chưa khởi tạo); kết nối ở tiến trình khác không được đếm. Gọi SAU khi giao dịch
// khoá tài khoản đã COMMIT.
registerSockets.disconnectAccount = async (accountId, { kind = 'account', reason } = {}) => {
  if (accountId == null) return 0;
  const k = kind === 'ops' ? 'ops' : 'account';
  require('./broadcast').publish({ command: 'disconnect', accountId: String(accountId), kind: k, reason: reason || null });
  return registerSockets.disconnectLocal(accountId, { kind: k, reason });
};

module.exports = registerSockets;
