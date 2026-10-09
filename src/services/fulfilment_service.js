// Sau bán (BE2): Seller gửi hàng về kho -> Kho nhận, kiểm, đóng gói, gửi, giao -> Bidder xác
// nhận -> giải ngân. Đơn hàng (orders) do BE1 tạo; BE2 chỉ cập nhật phần kho và payout.
//
// Schema không có cột "Seller đã gửi": khi Seller báo gửi, tạo warehouse_receipts với
// received_at = NULL (đang trên đường về kho). Giai đoạn của đơn suy ra từ các bảng:
//   awaiting_payment | payment_expired | awaiting_seller_shipment | in_transit_to_warehouse |
//   inspecting | inspection_failed | inspected | packed | shipped | delivered | completed
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const { createNotification, emitNotification } = require('./notification_service');
const { releasePayout } = require('./payout_service');
const validate = require('../utils/validate');

const PAYOUT_WINDOW_HOURS = 72;
const FEE_RATE = 0.05;        // khớp auction_engine.js (BE1)
const SHIPPING_FEE = 40_000;  // khớp auction_engine.js (BE1)
const roundThousand = (n) => Math.round(n / 1000) * 1000;

const STAGES = [
  'awaiting_payment', 'payment_expired', 'awaiting_seller_shipment', 'in_transit_to_warehouse',
  'inspecting', 'inspection_failed', 'inspected', 'packed', 'shipped', 'delivered', 'completed',
];

const STAGE_SQL = `
  CASE
    WHEN o.payment_status = 'awaiting_payment' THEN 'awaiting_payment'
    WHEN o.payment_status = 'expired' THEN 'payment_expired'
    WHEN r.id IS NULL THEN 'awaiting_seller_shipment'
    WHEN r.received_at IS NULL THEN 'in_transit_to_warehouse'
    WHEN r.inspection_result IS NULL THEN 'inspecting'
    WHEN r.inspection_result = 'mismatch' THEN 'inspection_failed'
    WHEN s.id IS NULL THEN 'inspected'
    WHEN s.status = 'packing' THEN 'packed'
    WHEN s.status = 'shipped' THEN 'shipped'
    WHEN o.payout_status = 'released' THEN 'completed'
    ELSE 'delivered'
  END`;

const ORDER_SELECT = `
  SELECT o.id, o.auction_id, o.bidder_id, o.seller_id, o.final_price, o.payment_status,
         o.payment_deadline, o.payout_status, o.payout_deadline, o.delivered_confirmed_at, o.created_at,
         l.title, c.code AS category,
         buyer.full_name AS buyer_name, buyer.phone AS buyer_phone,
         sl.store_name,
         r.id AS receipt_id, r.order_code, r.received_at, r.inspection_result, r.inspection_notes,
         ins.name AS inspected_by,
         s.id AS shipment_id, s.status AS shipment_status, s.tracking_code, s.updated_at AS shipment_updated_at,
         sa.id AS addr_id, sa.recipient_name AS addr_name, sa.phone AS addr_phone, sa.address_line AS addr_line,
         sa.ward AS addr_ward, sa.district AS addr_district, sa.city AS addr_city,
         ${STAGE_SQL} AS stage
  FROM orders o
  JOIN auctions a ON a.id = o.auction_id
  JOIN listings l ON l.id = a.listing_id
  JOIN categories c ON c.id = l.category_id
  JOIN accounts buyer ON buyer.id = o.bidder_id
  JOIN sellers sl ON sl.account_id = o.seller_id
  LEFT JOIN warehouse_receipts r ON r.order_id = o.id
  LEFT JOIN ops_accounts ins ON ins.id = r.inspected_by
  LEFT JOIN shipments s ON s.order_id = o.id
  LEFT JOIN addresses sa ON sa.id = o.shipping_address_id
`;

// Địa chỉ giao hàng chỉ hiện cho kho và chính người mua (người bán không cần biết).
function shippingAddress(r) {
  if (!r.addr_id) return null;
  return {
    id: r.addr_id,
    recipientName: r.addr_name,
    phone: r.addr_phone,
    addressLine: r.addr_line,
    ward: r.addr_ward,
    district: r.addr_district,
    city: r.addr_city,
  };
}

function toView(r, { withBuyerContact = false, withAddress = withBuyerContact } = {}) {
  return {
    id: r.id,
    auctionId: r.auction_id,
    title: r.title,
    category: r.category,
    finalPrice: Number(r.final_price),
    paymentStatus: r.payment_status,
    paymentDeadline: r.payment_deadline,
    payoutStatus: r.payout_status,
    payoutDeadline: r.payout_deadline,
    deliveredConfirmedAt: r.delivered_confirmed_at,
    stage: r.stage,
    seller: { id: r.seller_id, storeName: r.store_name },
    buyer: withBuyerContact
      ? { id: r.bidder_id, name: r.buyer_name, phone: r.buyer_phone }
      : { id: r.bidder_id },
    warehouse: r.receipt_id
      ? {
        orderCode: r.order_code,
        receivedAt: r.received_at,
        inspectionResult: r.inspection_result,
        inspectionNotes: r.inspection_notes,
        inspectedBy: r.inspected_by,
      }
      : null,
    shipment: r.shipment_id
      ? { status: r.shipment_status, trackingCode: r.tracking_code, updatedAt: r.shipment_updated_at }
      : null,
    ...(withAddress ? { shippingAddress: shippingAddress(r) } : {}),
    createdAt: r.created_at,
  };
}

async function events(executor, orderId) {
  const { rows } = await executor.query(
    `SELECT e.step, e.note, e.at FROM shipment_events e
     JOIN shipments s ON s.id = e.shipment_id
     WHERE s.order_id = $1 ORDER BY e.at, e.id`,
    [orderId],
  );
  return rows;
}

async function loadView(executor, orderId, opts) {
  const { rows } = await executor.query(`${ORDER_SELECT} WHERE o.id = $1`, [orderId]);
  if (!rows[0]) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
  const view = toView(rows[0], opts);
  view.events = await events(executor, orderId);
  return view;
}

// Khoá dòng orders để các bước kho / xác nhận / tranh chấp không chạy chồng nhau.
async function lockOrder(client, orderId) {
  const { rows } = await client.query(
    `SELECT o.id, o.auction_id, o.bidder_id, o.seller_id, o.final_price, o.payment_status,
            o.payout_status, o.delivered_confirmed_at, o.shipping_address_id, l.title
     FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
     WHERE o.id = $1 FOR UPDATE OF o`,
    [orderId],
  );
  if (!rows[0]) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
  return rows[0];
}

const conflict = (message, code = 'INVALID_STATE') => new AppError(message, 409, code);

// Số tiền người mua đã trả (dòng wallet_transactions 'payment' do BE1 ghi). Dùng làm số tiền
// ký quỹ khi mở tranh chấp. Không có dòng (dữ liệu cũ) thì tính lại theo công thức của BE1.
async function paidAmount(executor, order) {
  const { rows } = await executor.query(
    `SELECT amount FROM wallet_transactions
     WHERE bidder_id = $1 AND related_auction_id = $2 AND kind = 'payment'
     ORDER BY id DESC LIMIT 1`,
    [order.bidder_id, order.auction_id],
  );
  if (rows[0]) return Number(rows[0].amount);
  const price = Number(order.final_price);
  return price + roundThousand(price * FEE_RATE) + SHIPPING_FEE;
}

function orderCode(orderId) {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `BV-${dd}${mm}${yy}-${String(orderId).padStart(4, '0')}`;
}

async function withNotes(fn) {
  const { notes, orderId, opts } = await inTransaction(fn);
  notes.forEach(emitNotification); // sau COMMIT
  return loadView(pool, orderId, opts);
}

const notify = (client, accountId, type, title) => createNotification(client, { accountId, type, title });

// ---------- Seller ----------

async function listSelling(sellerId, { stage, limit, offset }) {
  const params = [sellerId];
  let where = 'o.seller_id = $1';
  if (stage) { params.push(validate.oneOf(stage, STAGES, 'Giai đoạn')); where += ` AND ${STAGE_SQL} = $${params.length}`; }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at DESC, o.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => toView(r));
}

async function shipToWarehouse(sellerId, orderId) {
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    if (String(o.seller_id) !== String(sellerId)) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    if (o.payment_status !== 'paid') throw conflict('Đơn chưa được thanh toán, chưa thể gửi hàng');
    if (o.payout_status === 'disputed') throw conflict('Đơn đang có tranh chấp, chờ Admin xử lý', 'DISPUTE_OPEN');
    const existing = await client.query('SELECT 1 FROM warehouse_receipts WHERE order_id = $1', [orderId]);
    if (existing.rowCount) throw conflict('Đơn này đã được báo gửi về kho', 'ALREADY_SHIPPED');

    await client.query(
      'INSERT INTO warehouse_receipts (order_id, order_code) VALUES ($1, $2)',
      [orderId, orderCode(orderId)],
    );
    const notes = [await notify(client, o.bidder_id, 'order',
      `Người bán đã gửi "${o.title}" đến kho BidVibe để kiểm tra.`)];
    return { notes, orderId };
  });
}

// ---------- Kho ----------

async function listForWarehouse({ stage, limit, offset }) {
  const params = [];
  // Kho chỉ thấy đơn Seller đã báo gửi (có warehouse_receipts).
  let where = 'r.id IS NOT NULL';
  if (stage) { params.push(validate.oneOf(stage, STAGES, 'Giai đoạn')); where += ` AND ${STAGE_SQL} = $${params.length}`; }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${ORDER_SELECT} WHERE ${where} ORDER BY o.created_at ASC, o.id ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => toView(r, { withBuyerContact: true }));
}

async function lockReceipt(client, orderId) {
  const { rows } = await client.query(
    'SELECT id, received_at, inspection_result FROM warehouse_receipts WHERE order_id = $1 FOR UPDATE',
    [orderId],
  );
  return rows[0] || null;
}

async function lockShipment(client, orderId) {
  const { rows } = await client.query('SELECT id, status FROM shipments WHERE order_id = $1 FOR UPDATE', [orderId]);
  return rows[0] || null;
}

const addEvent = (client, shipmentId, step, note) => client.query(
  'INSERT INTO shipment_events (shipment_id, step, note) VALUES ($1, $2, $3)',
  [shipmentId, step, note],
);

const WH = { withBuyerContact: true };

async function receive(orderId) {
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    const r = await lockReceipt(client, orderId);
    if (!r) throw conflict('Người bán chưa báo gửi hàng về kho');
    if (r.received_at) throw conflict('Kho đã nhận hàng của đơn này');
    await client.query('UPDATE warehouse_receipts SET received_at = now() WHERE id = $1', [r.id]);
    const notes = [await notify(client, o.bidder_id, 'order', `Kho đã nhận "${o.title}" và đang kiểm tra.`)];
    return { notes, orderId, opts: WH };
  });
}

async function inspect(inspectorId, orderId, input = {}) {
  const result = validate.oneOf(input.result, ['match', 'mismatch'], 'Kết quả kiểm');
  const notes = validate.text(input.notes, 'Ghi chú kiểm hàng', { max: 2000, required: result === 'mismatch' });
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    const r = await lockReceipt(client, orderId);
    if (!r || !r.received_at) throw conflict('Kho chưa nhận hàng, chưa thể kiểm');
    if (r.inspection_result) throw conflict('Đơn này đã được kiểm');
    await client.query(
      `UPDATE warehouse_receipts SET inspection_result = $2, inspection_notes = $3, inspected_by = $4 WHERE id = $1`,
      [r.id, result, notes, inspectorId],
    );
    const out = [];
    if (result === 'mismatch') {
      // Không khớp mô tả: tự mở tranh chấp nguồn kho, giữ ký quỹ chờ Admin.
      const escrow = await paidAmount(client, o);
      const d = await client.query(
        `INSERT INTO disputes (order_id, source, reporter_id, title, escrow_amount)
         VALUES ($1, 'warehouse', NULL, $2, $3) RETURNING id`,
        [orderId, `${o.title} — hàng không khớp mô tả khi kiểm`, escrow],
      );
      await client.query('INSERT INTO dispute_timeline (dispute_id, note) VALUES ($1, $2), ($1, $3)', [
        d.rows[0].id,
        `Kho phát hiện sai lệch khi kiểm hàng: ${notes}`,
        'Kho tạm giữ hàng, khoản ký quỹ được giữ lại cho tới khi Admin phán quyết.',
      ]);
      await client.query(`UPDATE orders SET payout_status = 'disputed' WHERE id = $1`, [orderId]);
      out.push(await notify(client, o.bidder_id, 'dispute', `Kho phát hiện "${o.title}" không khớp mô tả. Admin sẽ xử lý.`));
      out.push(await notify(client, o.seller_id, 'dispute', `Kho phát hiện "${o.title}" không khớp mô tả, đơn đang chờ Admin xử lý.`));
    }
    return { notes: out, orderId, opts: WH };
  });
}

async function pack(orderId, input = {}) {
  const note = validate.text(input.notes, 'Ghi chú', { max: 500, required: false });
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    const r = await lockReceipt(client, orderId);
    if (!r || r.inspection_result !== 'match') throw conflict('Chỉ đóng gói được đơn đã kiểm đạt');
    if (o.payout_status === 'disputed') throw conflict('Đơn đang có tranh chấp, chờ Admin xử lý', 'DISPUTE_OPEN');
    if (await lockShipment(client, orderId)) throw conflict('Đơn này đã được đóng gói');
    const s = await client.query(
      `INSERT INTO shipments (order_id, status) VALUES ($1, 'packing') RETURNING id`,
      [orderId],
    );
    await addEvent(client, s.rows[0].id, 'packing', note || 'Đã đóng gói tại kho BidVibe');
    return { notes: [], orderId, opts: WH };
  });
}

async function ship(orderId, input = {}) {
  const carrier = validate.text(input.carrier, 'Đơn vị vận chuyển', { max: 100 });
  const trackingCode = validate.text(input.trackingCode, 'Mã vận đơn', { max: 100 });
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    const s = await lockShipment(client, orderId);
    if (!s || s.status !== 'packing') throw conflict('Chỉ gửi đi được đơn đã đóng gói');
    if (o.payout_status === 'disputed') throw conflict('Đơn đang có tranh chấp, chờ Admin xử lý', 'DISPUTE_OPEN');
    if (!o.shipping_address_id) {
      throw conflict('Người mua chưa chọn địa chỉ giao hàng cho đơn này, chưa thể gửi đi', 'ORDER_NO_ADDRESS');
    }
    await client.query(
      `UPDATE shipments SET status = 'shipped', tracking_code = $2, updated_at = now() WHERE id = $1`,
      [s.id, trackingCode],
    );
    await addEvent(client, s.id, 'shipped', `Bàn giao ${carrier} · mã vận đơn ${trackingCode}`);
    const notes = [await notify(client, o.bidder_id, 'order',
      `"${o.title}" đang được giao qua ${carrier}, mã vận đơn ${trackingCode}.`)];
    return { notes, orderId, opts: WH };
  });
}

async function deliver(orderId) {
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    const s = await lockShipment(client, orderId);
    if (!s || s.status !== 'shipped') throw conflict('Chỉ xác nhận giao được đơn đang vận chuyển');
    await client.query(`UPDATE shipments SET status = 'delivered', updated_at = now() WHERE id = $1`, [s.id]);
    await addEvent(client, s.id, 'delivered', 'Giao hàng thành công');
    await client.query(
      `UPDATE orders SET payout_deadline = now() + ($2 || ' hours')::interval WHERE id = $1`,
      [orderId, String(PAYOUT_WINDOW_HOURS)],
    );
    const notes = [await notify(client, o.bidder_id, 'order',
      `"${o.title}" đã giao thành công. Hãy kiểm tra và xác nhận trong ${PAYOUT_WINDOW_HOURS} giờ.`)];
    return { notes, orderId, opts: WH };
  });
}

// ---------- Bidder ----------

async function confirmDelivery(bidderId, orderId) {
  return withNotes(async (client) => {
    const o = await lockOrder(client, orderId);
    if (String(o.bidder_id) !== String(bidderId)) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    const s = await client.query('SELECT status FROM shipments WHERE order_id = $1', [orderId]);
    if (!s.rows[0] || s.rows[0].status !== 'delivered') throw conflict('Đơn chưa được giao, chưa thể xác nhận', 'NOT_DELIVERED');
    if (o.delivered_confirmed_at) throw conflict('Bạn đã xác nhận nhận hàng cho đơn này', 'ALREADY_CONFIRMED');
    if (o.payout_status === 'disputed') throw conflict('Đơn đang có tranh chấp, chờ Admin xử lý', 'DISPUTE_OPEN');
    if (o.payout_status === 'released') throw conflict('Đơn đã được giải ngân', 'ALREADY_RELEASED');

    await client.query('UPDATE orders SET delivered_confirmed_at = now() WHERE id = $1', [orderId]);
    const notes = await releasePayout(client, o, { auto: false });
    return { notes, orderId, opts: { withAddress: true } };
  });
}

// Người mua chọn / đổi địa chỉ giao hàng cho đơn của mình, được phép tới trước khi kho gửi đi.
async function setShippingAddress(bidderId, orderId, input = {}) {
  const addressId = validate.int(input.addressId, 'addressId', { min: 1 });
  await inTransaction(async (client) => {
    const o = await lockOrder(client, orderId);
    if (String(o.bidder_id) !== String(bidderId)) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
    if (o.payment_status === 'expired') throw conflict('Đơn đã bị huỷ do quá hạn thanh toán');
    const s = await client.query('SELECT status FROM shipments WHERE order_id = $1', [orderId]);
    if (s.rows[0] && s.rows[0].status !== 'packing') {
      throw conflict('Đơn đã được gửi đi, không thể đổi địa chỉ giao hàng', 'ALREADY_SHIPPED');
    }
    const a = await client.query(
      'SELECT account_id FROM addresses WHERE id = $1 AND deleted_at IS NULL FOR SHARE',
      [addressId],
    );
    if (!a.rows[0] || String(a.rows[0].account_id) !== String(bidderId)) {
      throw new AppError('Không tìm thấy địa chỉ', 404, 'NOT_FOUND');
    }
    await client.query('UPDATE orders SET shipping_address_id = $2 WHERE id = $1', [orderId, addressId]);
  });
  return loadView(pool, orderId, { withAddress: true });
}

// Người mua hoặc người bán của đơn xem tiến trình (kho, vận chuyển, giải ngân).
// Chỉ người mua thấy địa chỉ giao hàng.
async function tracking(user, orderId) {
  const view = await loadView(pool, orderId, { withAddress: user.role === 'bidder' });
  const mine = (user.role === 'bidder' && String(view.buyer.id) === String(user.id))
    || (user.role === 'seller' && String(view.seller.id) === String(user.id));
  if (!mine) throw new AppError('Không tìm thấy đơn hàng', 404, 'NOT_FOUND');
  return view;
}

module.exports = {
  STAGES, STAGE_SQL, lockOrder, paidAmount, listSelling, shipToWarehouse, listForWarehouse,
  receive, inspect, pack, ship, deliver, confirmDelivery, setShippingAddress, tracking,
};
