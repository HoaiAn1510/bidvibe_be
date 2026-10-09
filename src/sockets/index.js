const registerAuctionSocket = require('./auction_socket');

let ioInstance = null;

// Khởi tạo các handler Socket.io
const registerSockets = (io) => {
  ioInstance = io;
  registerAuctionSocket(io);
};

// Cho service đẩy sự kiện real-time mà không cần truyền io qua từng hàm.
// Trả về null khi chưa khởi tạo (ví dụ chạy script/test không có server).
registerSockets.getIo = () => ioInstance;

module.exports = registerSockets;
