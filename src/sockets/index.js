// Khởi tạo các handler Socket.io
module.exports = (io) => {
  io.on('connection', (socket) => {
    console.log(`[socket] connected: ${socket.id}`);

    // Vào / rời phòng đấu giá
    socket.on('auction:join', (auctionId) => socket.join(`auction:${auctionId}`));
    socket.on('auction:leave', (auctionId) => socket.leave(`auction:${auctionId}`));

    socket.on('disconnect', () => console.log(`[socket] disconnected: ${socket.id}`));
  });
};
