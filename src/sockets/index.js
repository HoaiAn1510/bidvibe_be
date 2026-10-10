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

// Ngắt mọi kết nối socket đang mở của một tài khoản (gọi khi Admin khoá tài khoản).
//   accountId  id của accounts (Bidder/Seller) hoặc ops_accounts nếu kind = 'ops'
//   options    { kind: 'account' | 'ops' = 'account', reason?: string }
// Trước khi ngắt, gửi `account:disconnected` { code: 'ACCOUNT_SUSPENDED', message } để app hiện lý do
// và không tự kết nối lại. Trả về Promise<number>: số kết nối đã ngắt (0 nếu không online
// hoặc server socket chưa khởi tạo). Gọi SAU khi giao dịch khoá tài khoản đã COMMIT.
registerSockets.disconnectAccount = async (accountId, { kind = 'account', reason } = {}) => {
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

module.exports = registerSockets;
