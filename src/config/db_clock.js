// Độ lệch giữa giờ database và giờ máy chạy backend, để serverTime trong REST / socket là GIỜ DATABASE
// (cùng đồng hồ với ends_at, scheduler đóng phiên, tạm dừng / tiếp tục) chứ không phải giờ máy.
//   offset = now() của DB - giờ máy (lấy điểm giữa lúc gửi và lúc nhận để bù nửa độ trễ mạng)
// Đo lúc khởi động và mỗi 60 giây. Đo lỗi (mạng rớt, pool đang bận) thì giữ độ lệch cũ, không làm sập server.
const { pool } = require('./db');

const REMEASURE_MS = 60_000;

let offsetMs = 0;
let timer = null;
let failing = false;

// executor chỉ để test truyền vào một đối tượng có .query giả (mô phỏng lỗi).
async function measure(executor = pool) {
  try {
    const sentAt = Date.now();
    const { rows } = await executor.query('SELECT now() AS t');
    const receivedAt = Date.now();
    offsetMs = new Date(rows[0].t).getTime() - (sentAt + receivedAt) / 2;
    failing = false;
    return true;
  } catch (err) {
    // Chỉ log lần đầu của một đợt lỗi, tránh tràn log mỗi 60 giây khi database còn mất kết nối.
    if (!failing) console.error(`[db_clock] đo độ lệch giờ database lỗi, giữ độ lệch cũ (${Math.round(offsetMs)} ms): ${err.message}`);
    failing = true;
    return false;
  }
}

function start() {
  if (timer) return;
  measure();
  timer = setInterval(measure, REMEASURE_MS);
  timer.unref();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// Giờ database ước tính ngay lúc này = giờ máy + độ lệch.
const serverNow = () => new Date(Date.now() + offsetMs);
const serverTimeIso = () => serverNow().toISOString();
const getOffsetMs = () => offsetMs;
// Chỉ cho test: đặt độ lệch để kiểm tra serverTime áp dụng độ lệch.
const setOffsetForTest = (ms) => { offsetMs = ms; };

module.exports = { measure, start, stop, serverNow, serverTimeIso, getOffsetMs, setOffsetForTest, REMEASURE_MS };
