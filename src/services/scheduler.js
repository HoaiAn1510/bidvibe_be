// Tiến trình nền phía server: đóng phiên hết giờ và xử lý đơn quá hạn thanh toán.
// Poll mỗi vài giây theo index idx_auctions_status_ends / idx_orders_payment_deadline.
const engine = require('./auction_engine');
const payout = require('./payout_service'); // BE2: tự giải ngân sau 72 giờ

const INTERVAL_MS = 5000;
let timer = null;
let running = false;

async function tick() {
  if (running) return; // không chạy chồng nếu lượt trước chưa xong
  running = true;
  try {
    const closed = await engine.closeExpiredAuctions();
    if (closed.length) console.log(`[scheduler] đã đóng ${closed.length} phiên`);
    const expired = await engine.processPaymentTimeouts();
    if (expired.length) console.log(`[scheduler] ${expired.length} đơn quá hạn thanh toán`);
    const released = await payout.releaseOverduePayouts(); // BE2, tắt bằng AUTO_PAYOUT_ENABLED=false
    if (released.length) console.log(`[scheduler] tự giải ngân ${released.length} đơn`);
  } catch (err) {
    console.error('[scheduler]', err.message);
  } finally {
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
}

module.exports = { start, stop, tick };
