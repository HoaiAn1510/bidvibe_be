// Phát sự kiện real-time đúng khi nhiều backend (mỗi người một `npm run dev`) cùng trỏ một database.
// Socket.io chỉ phát cho socket nối vào CHÍNH tiến trình này, nên mỗi sự kiện được:
//   1. phát ngay cho socket của tiến trình hiện tại;
//   2. gửi pg_notify trên kênh 'bidvibe_events' với JSON { origin, room, event, payload }.
// pause_listener.js LISTEN kênh này (trên cùng kết nối LISTEN sẵn có) và phát lại cho socket của
// tiến trình nó, bỏ qua tin do chính tiến trình gửi (origin trùng).
// Gọi SAU COMMIT. Lỗi NOTIFY chỉ ghi log, không làm hỏng request.
const crypto = require('crypto');
const { pool } = require('../config/db');

const CHANNEL = 'bidvibe_events';
// Mã ngẫu nhiên của tiến trình: nhận lại tin của chính mình thì bỏ qua.
const ORIGIN = crypto.randomBytes(8).toString('hex');
// pg_notify giới hạn payload dưới 8000 byte.
const MAX_BYTES = 8000;

const pending = new Set();

// io được lấy lúc gọi (không require ở đầu file) để tránh vòng require với sockets/index.js.
const getIo = () => require('./index').getIo();

function emitLocal(room, event, payload) {
  const io = getIo();
  if (io) io.to(room).emit(event, payload);
}

// Gửi một tin lên kênh. message: { room, event, payload } hoặc lệnh { command, ... }.
function publish(message) {
  const text = JSON.stringify({ origin: ORIGIN, ...message });
  if (Buffer.byteLength(text) >= MAX_BYTES) {
    console.warn(`[realtime] tin ${message.event || message.command} quá ${MAX_BYTES} byte, chỉ phát trong tiến trình này`);
    return;
  }
  const p = pool.query('SELECT pg_notify($1, $2)', [CHANNEL, text])
    .catch((err) => {
      // Script / test đã đóng pool trước khi NOTIFY kịp chạy: không có gì để báo.
      if (!/pool after calling end/i.test(err.message)) console.error('[realtime] gửi pg_notify lỗi:', err.message);
    })
    .finally(() => pending.delete(p));
  pending.add(p);
}

function broadcast(room, event, payload) {
  emitLocal(room, event, payload);
  publish({ room, event, payload });
}

// Chờ các NOTIFY đang gửi (gọi trước pool.end() khi tắt server).
const drain = () => Promise.allSettled([...pending]);

module.exports = { CHANNEL, ORIGIN, broadcast, publish, emitLocal, drain };
