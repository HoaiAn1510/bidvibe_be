// Giải ngân cho Seller (BE2). Quyết định mặc định: Seller chưa có ví, giải ngân chỉ đổi
// orders.payout_status 'pending' -> 'released' (tiền coi như chuyển ngoài hệ thống).
const { pool } = require('../config/db');
const env = require('../config/env');
const { inTransaction } = require('./auction_engine');
const { createNotification, emitNotification } = require('./notification_service');

// `client` đang trong giao dịch, `order` đã được khoá FOR UPDATE và còn payout_status = 'pending'.
// Trả về các thông báo để nơi gọi emitNotification() sau COMMIT.
async function releasePayout(client, order, { auto }) {
  await client.query(`UPDATE orders SET payout_status = 'released' WHERE id = $1`, [order.id]);
  const notes = [await createNotification(client, {
    accountId: order.seller_id,
    type: 'payout',
    title: auto
      ? `Đã tự động giải ngân đơn "${order.title}" (quá 72 giờ sau khi giao, người mua không phản hồi).`
      : `Người mua đã xác nhận nhận hàng, đơn "${order.title}" đã được giải ngân.`,
  })];
  if (auto) {
    notes.push(await createNotification(client, {
      accountId: order.bidder_id,
      type: 'info',
      title: `Đơn "${order.title}" đã hoàn tất: quá 72 giờ sau khi giao, hệ thống tự xác nhận.`,
    }));
  }
  return notes;
}

const ORDER_FOR_PAYOUT = `
  SELECT o.id, o.bidder_id, o.seller_id, o.payout_status, o.payout_deadline, o.delivered_confirmed_at,
         l.title
  FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
`;

// Job nền: đơn đã giao, quá payout_deadline mà người mua chưa xác nhận và không có tranh chấp.
// Tắt bằng AUTO_PAYOUT_ENABLED=false. Chỉ chạy khi scheduler được start (src/app.js khi chạy
// server trực tiếp), không chạy khi require app trong test.
async function releaseOverduePayouts() {
  if (!env.autoPayoutEnabled) return [];
  const { rows } = await pool.query(
    `SELECT id FROM orders
     WHERE payout_status = 'pending' AND payout_deadline < now() AND delivered_confirmed_at IS NULL
     ORDER BY payout_deadline`,
  );
  const released = [];
  for (const { id } of rows) {
    try {
      const notes = await inTransaction(async (client) => {
        const r = await client.query(
          `${ORDER_FOR_PAYOUT}
           WHERE o.id = $1 AND o.payout_status = 'pending' AND o.payout_deadline < now()
             AND o.delivered_confirmed_at IS NULL
           FOR UPDATE OF o SKIP LOCKED`,
          [id],
        );
        if (!r.rows[0]) return null;
        return releasePayout(client, r.rows[0], { auto: true });
      });
      if (notes) { notes.forEach(emitNotification); released.push(id); }
    } catch (err) {
      console.error(`[payout] lỗi tự giải ngân đơn ${id}:`, err.message);
    }
  }
  return released;
}

module.exports = { ORDER_FOR_PAYOUT, releasePayout, releaseOverduePayouts };
