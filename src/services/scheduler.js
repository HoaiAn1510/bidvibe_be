// Tiến trình nền phía server: đóng phiên hết giờ và xử lý đơn quá hạn thanh toán.
// Poll mỗi vài giây theo index idx_auctions_status_ends / idx_orders_payment_deadline.
//
// Nhiều backend cùng trỏ một database (mỗi người một `npm run dev`) đều chạy scheduler. Để tại một thời điểm chỉ
// MỘT backend làm việc, mỗi lượt tick lấy khoá advisory của Postgres pg_try_advisory_lock(SCHEDULER_LOCK_KEY) trên một
// client riêng của pool; không lấy được (backend khác đang chạy lượt của họ) thì bỏ lượt này. Làm xong thì
// pg_advisory_unlock rồi mới trả client. Khoá là khoá phiên: backend đang giữ bị tắt / mất kết nối thì Postgres tự nhả,
// lượt sau backend khác lấy được. Phải dùng Session pooler của Supabase (cổng 5432), như LISTEN của pause_listener.
const { pool } = require('../config/db');
const engine = require('./auction_engine');
const payout = require('./payout_service'); // BE2: tự giải ngân sau 72 giờ

// Hằng số riêng của BidVibe cho khoá scheduler: 0x424944565343 = ASCII "BIDVSC". Các khoá advisory khác trong code
// (cờ gian lận) dùng pg_advisory_xact_lock với hashtextextended nên không trùng.
const SCHEDULER_LOCK_KEY = 0x424944565343;
const INTERVAL_MS = 5000;
let timer = null;
let running = false;
let isLeader = false;

// Chỉ log khi đổi trạng thái (không log mỗi 5 giây).
function setLeader(value) {
  if (value === isLeader) return;
  isLeader = value;
  console.log(value
    ? '[scheduler] backend này đang làm scheduler chính'
    : '[scheduler] backend này thôi làm scheduler chính (backend khác đang giữ khoá)');
}

async function runJobs() {
  const closed = await engine.closeExpiredAuctions();
  if (closed.length) console.log(`[scheduler] đã đóng ${closed.length} phiên (${closed.map((c) => `#${c.auctionId}`).join(', ')})`);
  const expired = await engine.processPaymentTimeouts();
  if (expired.length) console.log(`[scheduler] ${expired.length} đơn quá hạn thanh toán`);
  const released = await payout.releaseOverduePayouts(); // BE2, tắt bằng AUTO_PAYOUT_ENABLED=false
  if (released.length) console.log(`[scheduler] tự giải ngân ${released.length} đơn`);
}

async function tick() {
  if (running) return; // không chạy chồng nếu lượt trước chưa xong
  running = true;
  let client = null;
  let broken = false; // nhả khoá lỗi: huỷ hẳn kết nối để Postgres nhả khoá phiên
  try {
    client = await pool.connect();
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS got', [SCHEDULER_LOCK_KEY]);
    if (!rows[0].got) {
      setLeader(false);
      return;
    }
    setLeader(true);
    try {
      await runJobs();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]).catch(() => { broken = true; });
    }
  } catch (err) {
    console.error('[scheduler]', err.message);
  } finally {
    if (client) client.release(broken || undefined);
    running = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, INTERVAL_MS);
  tick();
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  isLeader = false;
}

module.exports = { start, stop, tick, SCHEDULER_LOCK_KEY };
