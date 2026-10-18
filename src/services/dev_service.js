// Công cụ cho FE test nhanh (chỉ đăng ký khi DEV_TOOLS=true, xem routes/dev.routes.js). Chỉ dịch đồng hồ
// trong DB; việc đóng phiên, tạo đơn, hoàn cọc, tịch thu cọc do scheduler.js làm như thật.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const auctionModel = require('../models/auction.model');
const { inTransaction } = require('./auction_engine');
const { broadcast } = require('../sockets/broadcast');

const MIN_SECONDS = 5;
const MAX_SECONDS = 3600;
const DEFAULT_SECONDS = 10;

function parseSeconds(value) {
  if (value == null) return DEFAULT_SECONDS;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < MIN_SECONDS || n > MAX_SECONDS) {
    throw new AppError(`Số giây phải là số nguyên từ ${MIN_SECONDS} đến ${MAX_SECONDS}`, 400, 'VALIDATION_ERROR');
  }
  return n;
}

// Đặt ends_at = now() + seconds cho phiên đang diễn ra, không tạm dừng.
async function endAuctionSoon({ auctionId, seconds }) {
  const secs = parseSeconds(seconds);
  const result = await inTransaction(async (client) => {
    const a = await auctionModel.lockById(client, auctionId);
    if (!a) throw new AppError('Không tìm thấy phiên đấu giá', 404, 'NOT_FOUND');
    if (a.status !== 'active' || new Date(a.ends_at) <= new Date()) {
      throw new AppError('Chỉ rút ngắn được phiên đang diễn ra', 409, 'AUCTION_ENDED');
    }
    if (a.paused) throw new AppError('Phiên đang bị tạm dừng để kiểm tra', 409, 'AUCTION_PAUSED');
    // Giờ DB (now()) để khớp với scheduler, vốn so ends_at với now() của DB khi đóng phiên.
    const { rows } = await client.query(
      `UPDATE auctions SET ends_at = now() + ($2 * interval '1 second') WHERE id = $1
       RETURNING ends_at, ceil(extract(epoch FROM ends_at - now()))::int AS remaining`,
      [auctionId, secs],
    );
    return { endsAt: rows[0].ends_at, remainingSeconds: rows[0].remaining };
  });

  // Sau COMMIT: để đồng hồ trên app tự cập nhật. Các trường giống auction:update lúc tạm dừng / tiếp tục.
  const a = await auctionModel.findById(pool, auctionId);
  broadcast(`auction:${auctionId}`, 'auction:update', {
    auctionId: String(auctionId),
    reason: 'dev_time',
    status: a.status,
    paused: a.paused,
    pausedAt: a.pausedAt,
    endsAt: result.endsAt,
    remainingSeconds: result.remainingSeconds,
    currentPrice: a.currentPrice,
    bidCount: a.bidCount,
  });
  return { auctionId: String(auctionId), endsAt: result.endsAt, remainingSeconds: result.remainingSeconds };
}

// Đưa payment_deadline của đơn chưa thanh toán về quá khứ; scheduler sẽ huỷ đơn và tịch thu cọc.
async function expireOrderPayment({ orderId }) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, payment_status FROM orders WHERE id = $1 FOR UPDATE`, [orderId]);
    const o = rows[0];
    if (!o) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    if (o.payment_status === 'paid') throw new AppError('Đơn hàng đã được thanh toán', 409, 'ALREADY_PAID');
    if (o.payment_status === 'expired') throw new AppError('Đơn hàng đã quá hạn thanh toán', 409, 'PAYMENT_EXPIRED');
    const upd = await client.query(
      `UPDATE orders SET payment_deadline = now() - interval '1 second' WHERE id = $1 RETURNING payment_deadline`,
      [orderId],
    );
    return { orderId: String(orderId), paymentDeadline: upd.rows[0].payment_deadline };
  });
}

module.exports = { endAuctionSoon, expireOrderPayment };
