// Tranh chấp (BE2). Bidder/Seller mở trên đơn của mình (Kho tự mở khi kiểm hàng mismatch,
// xem fulfilment_service.inspect). Admin phán quyết:
//   refund: hoàn tiền về ví người mua qua wallet_service.refund (BE1) trong cùng giao dịch;
//           payout_status giữ 'disputed' (schema không có trạng thái "đã hoàn"), listing -> 'cancelled'.
//   keep:   giữ nguyên giao dịch, payout_status -> 'released' (giải ngân cho Seller).
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const walletService = require('./wallet_service');
const { createNotification, emitNotification } = require('./notification_service');
const { lockOrder, paidAmount } = require('./fulfilment_service');
const validate = require('../utils/validate');

const conflict = (message, code) => new AppError(message, 409, code);
const notify = (client, accountId, type, title) => createNotification(client, { accountId, type, title });
const WHO = { bidder: 'Người mua', seller: 'Người bán', warehouse: 'Kho' };

async function open(user, input = {}) {
  const orderId = validate.int(input.orderId, 'orderId', { min: 1 });
  const title = validate.text(input.title, 'Tiêu đề', { max: 200 });
  const reason = validate.text(input.reason, 'Lý do', { max: 2000 });

  const result = await inTransaction(async (client) => {
    const o = await lockOrder(client, String(orderId));
    const ownerId = user.role === 'bidder' ? o.bidder_id : o.seller_id;
    if (String(ownerId) !== String(user.id)) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    if (o.payment_status !== 'paid') throw conflict('Chỉ mở tranh chấp cho đơn đã thanh toán', 'INVALID_STATE');
    if (o.payout_status === 'released') throw conflict('Đơn đã giải ngân, không thể mở tranh chấp', 'ALREADY_RELEASED');
    if (o.payout_status === 'disputed') throw conflict('Đơn này đang có tranh chấp chờ xử lý', 'DISPUTE_OPEN');

    const escrow = await paidAmount(client, o);
    const d = await client.query(
      `INSERT INTO disputes (order_id, source, reporter_id, title, escrow_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [o.id, user.role, user.id, title, escrow],
    );
    const disputeId = d.rows[0].id;
    await client.query('INSERT INTO dispute_timeline (dispute_id, note) VALUES ($1, $2), ($1, $3)', [
      disputeId,
      `${WHO[user.role]} mở tranh chấp: ${reason}`,
      'Khoản ký quỹ được giữ lại cho tới khi Admin phán quyết.',
    ]);
    await client.query(`UPDATE orders SET payout_status = 'disputed' WHERE id = $1`, [o.id]);
    const other = user.role === 'bidder' ? o.seller_id : o.bidder_id;
    const note = await notify(client, other, 'dispute', `${WHO[user.role]} đã mở tranh chấp cho đơn "${o.title}": ${title}`);
    return { disputeId, note };
  });
  emitNotification(result.note);
  return getOne(result.disputeId);
}

const DISPUTE_SELECT = `
  SELECT d.id, d.order_id, d.source, d.reporter_id, d.title, d.status, d.escrow_amount, d.resolution,
         rb.name AS resolved_by, l.title AS item_title, o.final_price, o.payout_status,
         o.bidder_id, buyer.full_name AS buyer_name, o.seller_id, sl.store_name,
         (SELECT json_agg(json_build_object('note', t.note, 'at', t.at) ORDER BY t.at, t.id)
            FROM dispute_timeline t WHERE t.dispute_id = d.id) AS timeline
  FROM disputes d
  JOIN orders o ON o.id = d.order_id
  JOIN auctions a ON a.id = o.auction_id
  JOIN listings l ON l.id = a.listing_id
  JOIN accounts buyer ON buyer.id = o.bidder_id
  JOIN sellers sl ON sl.account_id = o.seller_id
  LEFT JOIN ops_accounts rb ON rb.id = d.resolved_by
`;

function toView(r) {
  return {
    id: r.id,
    orderId: r.order_id,
    itemTitle: r.item_title,
    source: r.source,
    reporterId: r.reporter_id,
    title: r.title,
    status: r.status,
    escrowAmount: Number(r.escrow_amount),
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    finalPrice: Number(r.final_price),
    payoutStatus: r.payout_status,
    buyer: { id: r.bidder_id, name: r.buyer_name },
    seller: { id: r.seller_id, storeName: r.store_name },
    timeline: r.timeline || [],
  };
}

async function getOne(disputeId) {
  const { rows } = await pool.query(`${DISPUTE_SELECT} WHERE d.id = $1`, [disputeId]);
  if (!rows[0]) throw new AppError('Không tìm thấy tranh chấp', 404, 'NOT_FOUND');
  return toView(rows[0]);
}

async function listMine(user) {
  const col = user.role === 'bidder' ? 'o.bidder_id' : 'o.seller_id';
  const { rows } = await pool.query(`${DISPUTE_SELECT} WHERE ${col} = $1 ORDER BY d.id DESC`, [user.id]);
  return rows.map(toView);
}

async function listForAdmin({ status, limit, offset }) {
  const params = [];
  let where = '';
  if (status) { params.push(validate.oneOf(status, ['open', 'resolved'], 'Trạng thái')); where = 'WHERE d.status = $1'; }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${DISPUTE_SELECT} ${where} ORDER BY (d.status = 'open') DESC, d.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(toView);
}

async function resolve(adminId, disputeId, input = {}) {
  const resolution = validate.oneOf(input.resolution, ['refund', 'keep'], 'Phán quyết');
  const note = validate.text(input.note, 'Ghi chú', { max: 2000, required: false });

  const notes = await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, order_id, status, escrow_amount, title FROM disputes WHERE id = $1 FOR UPDATE',
      [disputeId],
    );
    const d = rows[0];
    if (!d) throw new AppError('Không tìm thấy tranh chấp', 404, 'NOT_FOUND');
    if (d.status !== 'open') throw conflict('Tranh chấp này đã được xử lý', 'ALREADY_RESOLVED');
    const o = await lockOrder(client, d.order_id);
    const amount = Number(d.escrow_amount);
    const fmt = `${amount.toLocaleString('vi-VN')}đ`;
    const out = [];

    if (resolution === 'refund') {
      await walletService.refund(client, { bidderId: o.bidder_id, amount, auctionId: o.auction_id }); // BE1
      await client.query(
        `UPDATE listings SET status = 'cancelled'
         WHERE id = (SELECT listing_id FROM auctions WHERE id = $1)`,
        [o.auction_id],
      );
      out.push(await notify(client, o.bidder_id, 'refund', `Tranh chấp "${d.title}" đã xử lý: hoàn ${fmt} về ví của bạn.`));
      out.push(await notify(client, o.seller_id, 'dispute', `Tranh chấp "${d.title}" đã xử lý: hoàn tiền cho người mua.`));
    }

    await client.query(
      `UPDATE disputes SET status = 'resolved', resolution = $2, resolved_by = $3 WHERE id = $1`,
      [d.id, resolution, adminId],
    );
    await client.query('INSERT INTO dispute_timeline (dispute_id, note) VALUES ($1, $2)', [
      d.id,
      resolution === 'refund'
        ? `Admin phán quyết: hoàn ${fmt} cho người mua.${note ? ` ${note}` : ''}`
        : `Admin phán quyết: giữ nguyên giao dịch, giải ngân cho người bán.${note ? ` ${note}` : ''}`,
    ]);

    if (resolution === 'keep') {
      // Còn tranh chấp khác đang mở trên cùng đơn thì chưa giải ngân.
      const others = await client.query(
        `SELECT 1 FROM disputes WHERE order_id = $1 AND status = 'open' AND id <> $2`,
        [o.id, d.id],
      );
      if (!others.rowCount) {
        await client.query(`UPDATE orders SET payout_status = 'released' WHERE id = $1`, [o.id]);
      }
      out.push(await notify(client, o.seller_id, 'payout', others.rowCount
        ? `Tranh chấp "${d.title}" đã xử lý: giữ nguyên giao dịch. Đơn còn tranh chấp khác nên chưa giải ngân.`
        : `Tranh chấp "${d.title}" đã xử lý: giữ nguyên giao dịch, đơn được giải ngân.`));
      out.push(await notify(client, o.bidder_id, 'dispute', `Tranh chấp "${d.title}" đã xử lý: giữ nguyên giao dịch.`));
    }
    return out;
  });
  notes.forEach(emitNotification);
  return getOne(disputeId);
}

module.exports = { open, listMine, listForAdmin, resolve };
