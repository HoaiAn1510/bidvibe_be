// Số người đang xem một phiên = số tài khoản khác nhau có socket trong phòng auction:{id} CỦA TIẾN TRÌNH NÀY
// (một tài khoản mở nhiều kết nối chỉ tính 1). Không gom qua các backend: mỗi backend đếm riêng
// (khi demo chỉ chạy một backend nên số chính xác). Xem docs/socket.md mục auction:viewers.
// io được lấy lúc gọi (không require ở đầu file) để tránh vòng require với sockets/index.js.
const getIo = () => require('./index').getIo();

const roomOf = (auctionId) => `auction:${auctionId}`;

// excludeSocketId: bỏ qua một socket (đang ngắt kết nối nhưng chưa rời phòng).
async function countViewers(auctionId, { excludeSocketId } = {}) {
  const io = getIo();
  if (!io) return 0;
  const sockets = await io.in(roomOf(auctionId)).fetchSockets();
  const accounts = new Set();
  for (const s of sockets) {
    if (s.id === excludeSocketId) continue;
    const u = s.data && s.data.user;
    accounts.add(u ? `${u.kind}:${u.id}` : `socket:${s.id}`);
  }
  return accounts.size;
}

// Phát auction:viewers { auctionId, viewers } vào phòng. Xếp hàng theo từng phiên để lần phát cuối luôn
// phản ánh trạng thái mới nhất (đếm xong mới phát, không để hai lần đếm phát đảo thứ tự).
const queues = new Map();

function emitViewers(auctionId, opts) {
  const key = String(auctionId);
  const run = (queues.get(key) || Promise.resolve())
    .then(async () => {
      const io = getIo();
      if (!io) return;
      const viewers = await countViewers(key, opts);
      io.to(roomOf(key)).emit('auction:viewers', { auctionId: key, viewers });
    })
    .catch((err) => console.error('[viewers]', err.message))
    .finally(() => { if (queues.get(key) === run) queues.delete(key); });
  queues.set(key, run);
  return run;
}

module.exports = { countViewers, emitViewers };
