// Admin (BE2): bảng điều khiển, xử lý phiên bị gắn cờ, báo cáo tuần, quản lý tài khoản.
// Tạm dừng / tiếp tục phiên chỉ dùng cơ chế BE1 đã có: cờ flagged_auctions.status = 'paused'
// chặn cọc, đặt giá và đóng phiên tự động; đổi cờ sang trạng thái khác là bỏ chặn.
// Không tự sửa ends_at của phiên.
const bcrypt = require('bcrypt');
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction, cancelAuction } = require('./auction_engine');
const { createNotification, emitNotification } = require('./notification_service');
const { SALT_ROUNDS } = require('./auth_service');
const validate = require('../utils/validate');
const registerSockets = require('../sockets');

const LOCK_REASON = 'Tài khoản đã bị khoá';

// Ngắt socket đang mở của tài khoản vừa bị khoá (hàm của BE1). Chỉ gọi sau khi việc khoá đã
// lưu xuống DB; lỗi ở đây chỉ ghi log, không làm hỏng phản hồi của API khoá.
async function disconnectSuspended(accountId, kind) {
  try {
    await registerSockets.disconnectAccount(accountId, { kind, reason: LOCK_REASON });
  } catch (err) {
    console.error(`[admin] ngắt socket tài khoản ${kind}:${accountId} lỗi:`, err.message);
  }
}

const conflict = (message, code = 'INVALID_STATE') => new AppError(message, 409, code);
const FEE_RATE = 0.05; // khớp auction_engine.js (BE1)

// ---------- Bảng điều khiển ----------

async function dashboard() {
  const one = async (sql) => (await pool.query(sql)).rows[0];
  const [auctions, listings, orders, flags, disputes, users, escrow] = await Promise.all([
    one(`SELECT count(*) FILTER (WHERE status = 'active' AND ends_at > now())::int AS live,
                count(*) FILTER (WHERE status = 'active' AND ends_at > now() AND ends_at < now() + interval '24 hours')::int AS ending_24h
         FROM auctions`),
    one(`SELECT count(*) FILTER (WHERE status = 'pending_appraisal')::int AS pending_appraisal,
                count(*) FILTER (WHERE status = 'needs_info')::int AS needs_info
         FROM listings`),
    one(`SELECT count(*) FILTER (WHERE o.payment_status = 'awaiting_payment')::int AS awaiting_payment,
                count(*) FILTER (WHERE o.payment_status = 'paid' AND r.id IS NULL)::int AS awaiting_seller_shipment,
                count(*) FILTER (WHERE r.id IS NOT NULL AND r.received_at IS NULL)::int AS in_transit_to_warehouse,
                count(*) FILTER (WHERE r.received_at IS NOT NULL AND r.inspection_result IS NULL)::int AS inspecting,
                count(*) FILTER (WHERE s.status IN ('packing', 'shipped'))::int AS outbound,
                count(*) FILTER (WHERE s.status = 'delivered' AND o.payout_status = 'pending')::int AS delivered_awaiting_confirm
         FROM orders o
         LEFT JOIN warehouse_receipts r ON r.order_id = o.id
         LEFT JOIN shipments s ON s.order_id = o.id`),
    one(`SELECT count(*) FILTER (WHERE status IN ('pending', 'paused', 'verify'))::int AS open,
                count(*) FILTER (WHERE status = 'paused')::int AS paused
         FROM flagged_auctions`),
    one(`SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM disputes`),
    one(`SELECT (SELECT count(*) FROM bidders)::int AS bidders,
                (SELECT count(*) FROM sellers)::int AS sellers,
                (SELECT count(*) FROM ops_accounts)::int AS ops,
                (SELECT count(*) FROM accounts WHERE status = 'suspended')::int
                  + (SELECT count(*) FROM ops_accounts WHERE status = 'suspended')::int AS suspended`),
    // Tiền nền tảng đang giữ: số người mua đã trả cho đơn chưa giải ngân (theo dòng ví 'payment').
    one(`SELECT coalesce(sum(w.amount), 0)::bigint AS held
         FROM orders o
         JOIN wallet_transactions w ON w.bidder_id = o.bidder_id AND w.related_auction_id = o.auction_id AND w.kind = 'payment'
         WHERE o.payment_status = 'paid' AND o.payout_status IN ('pending', 'disputed')
           AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.order_id = o.id AND d.resolution = 'refund')`),
  ]);
  return {
    auctions: { live: auctions.live, endingIn24h: auctions.ending_24h },
    appraisal: { pending: listings.pending_appraisal, needsInfo: listings.needs_info },
    orders: {
      awaitingPayment: orders.awaiting_payment,
      awaitingSellerShipment: orders.awaiting_seller_shipment,
      inTransitToWarehouse: orders.in_transit_to_warehouse,
      inspecting: orders.inspecting,
      outbound: orders.outbound,
      deliveredAwaitingConfirm: orders.delivered_awaiting_confirm,
    },
    flags: { open: flags.open, paused: flags.paused },
    disputes: { open: disputes.open },
    users: { bidders: users.bidders, sellers: users.sellers, ops: users.ops, suspended: users.suspended },
    escrowHeld: Number(escrow.held),
  };
}

// ---------- Phiên bị gắn cờ ----------

const FLAG_SELECT = `
  SELECT f.id, f.auction_id, f.severity, f.confidence, f.reason, f.ai_explanation, f.status,
         a.status AS auction_status, a.current_price, a.ends_at, a.bid_count,
         l.title, l.seller_id,
         (SELECT json_agg(json_build_object('label', e.label, 'value', e.value) ORDER BY e.id)
            FROM flag_evidence e WHERE e.flagged_auction_id = f.id) AS evidence
  FROM flagged_auctions f
  JOIN auctions a ON a.id = f.auction_id
  JOIN listings l ON l.id = a.listing_id
`;

const flagView = (r) => ({
  id: r.id,
  auction: {
    id: r.auction_id, title: r.title, status: r.auction_status,
    currentPrice: Number(r.current_price), endsAt: r.ends_at, bidCount: r.bid_count,
  },
  severity: r.severity,
  confidence: r.confidence,
  reason: r.reason,
  aiExplanation: r.ai_explanation,
  status: r.status,
  evidence: r.evidence || [],
});

const FLAG_STATUSES = ['pending', 'paused', 'terminated', 'verify', 'safe'];

async function listFlags({ status, limit, offset }) {
  const params = [];
  let where = '';
  if (status) { params.push(validate.oneOf(status, FLAG_STATUSES, 'Trạng thái')); where = 'WHERE f.status = $1'; }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${FLAG_SELECT} ${where}
     ORDER BY (f.status IN ('pending', 'paused', 'verify')) DESC,
              CASE f.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, f.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(flagView);
}

// action -> trạng thái cờ mới. Từ 'terminated' / 'safe' không đổi được nữa.
const ACTIONS = { pause: 'paused', terminate: 'terminated', verify: 'verify', safe: 'safe' };

async function flagAction(adminId, flagId, input = {}) {
  const action = validate.oneOf(input.action, Object.keys(ACTIONS), 'Hành động');
  const reason = validate.text(input.reason, 'Lý do', { max: 1000, required: action === 'terminate' });
  const next = ACTIONS[action];

  const out = await inTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT f.id, f.status, f.auction_id, l.title, l.seller_id
       FROM flagged_auctions f JOIN auctions a ON a.id = f.auction_id JOIN listings l ON l.id = a.listing_id
       WHERE f.id = $1 FOR UPDATE OF f`,
      [flagId],
    );
    const f = rows[0];
    if (!f) throw new AppError('Không tìm thấy cờ', 404, 'NOT_FOUND');
    if (['terminated', 'safe'].includes(f.status)) throw conflict('Cờ này đã được xử lý xong');
    if (f.status === next) throw conflict('Cờ đã ở trạng thái này');

    const notes = [];
    let cancelled = null;
    if (action === 'terminate') {
      // BE1: huỷ phiên + hoàn cọc mọi người tham gia; phiên không còn 'active' thì báo 409.
      cancelled = await cancelAuction(client, f.auction_id, { reason });
    }
    await client.query('UPDATE flagged_auctions SET status = $2 WHERE id = $1', [f.id, next]);

    if (action === 'pause') {
      notes.push(await createNotification(client, {
        accountId: f.seller_id, type: 'warn', title: `Phiên "${f.title}" tạm dừng để kiểm tra.`,
      }));
    } else if (action === 'terminate') {
      notes.push(await createNotification(client, {
        accountId: f.seller_id, type: 'warn', title: `Phiên "${f.title}" bị Admin chấm dứt: ${reason}`,
      }));
    } else if (f.status === 'paused') {
      notes.push(await createNotification(client, {
        accountId: f.seller_id, type: 'info', title: `Phiên "${f.title}" tiếp tục sau khi kiểm tra.`,
      }));
    }
    return { notes, cancelled };
  });

  if (out.cancelled) out.cancelled.emit(); // BE1: đẩy auction:ended + thông báo hoàn cọc sau COMMIT
  out.notes.forEach(emitNotification);
  const { rows } = await pool.query(`${FLAG_SELECT} WHERE f.id = $1`, [flagId]);
  return flagView(rows[0]);
}

// ---------- Báo cáo tuần (7 ngày gần nhất, từ dữ liệu thật) ----------

async function weeklyReport() {
  const one = async (sql) => (await pool.query(sql)).rows[0];
  const many = async (sql) => (await pool.query(sql)).rows;
  const W = `now() - interval '7 days'`;
  const [auctions, sales, payments, signups, appraisals, disputes, topups, categories] = await Promise.all([
    one(`SELECT count(*) FILTER (WHERE status = 'ended')::int AS ended,
                count(*) FILTER (WHERE status = 'ended' AND winner_id IS NOT NULL)::int AS sold,
                count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM auctions WHERE ends_at >= ${W} AND ends_at <= now()`),
    one(`SELECT count(*)::int AS orders, coalesce(sum(final_price), 0)::bigint AS gmv,
                coalesce(sum(round(final_price * ${FEE_RATE} / 1000) * 1000), 0)::bigint AS fees
         FROM orders WHERE created_at >= ${W}`),
    one(`SELECT count(*) FILTER (WHERE payment_status = 'paid')::int AS paid,
                count(*) FILTER (WHERE payment_status = 'expired')::int AS expired
         FROM orders WHERE created_at >= ${W}`),
    many(`SELECT CASE WHEN b.account_id IS NOT NULL THEN 'bidder' ELSE 'seller' END AS role, count(*)::int AS n
          FROM accounts a LEFT JOIN bidders b ON b.account_id = a.id
          WHERE a.created_at >= ${W} GROUP BY 1`),
    many(`SELECT decision, count(*)::int AS n FROM appraisals WHERE decided_at >= ${W} GROUP BY 1`),
    // disputes không có cột thời gian: lấy mốc mở = dòng timeline đầu tiên.
    one(`SELECT count(*)::int AS opened,
                count(*) FILTER (WHERE d.status = 'resolved')::int AS resolved
         FROM disputes d
         WHERE (SELECT min(t.at) FROM dispute_timeline t WHERE t.dispute_id = d.id) >= ${W}`),
    one(`SELECT count(*)::int AS n, coalesce(sum(amount), 0)::bigint AS total
         FROM wallet_transactions WHERE kind = 'topup' AND created_at >= ${W}`),
    many(`SELECT c.code, count(*)::int AS orders, coalesce(sum(o.final_price), 0)::bigint AS gmv
          FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
          JOIN categories c ON c.id = l.category_id
          WHERE o.created_at >= ${W} GROUP BY c.code ORDER BY gmv DESC`),
  ]);
  const byKey = (rows, key) => Object.fromEntries(rows.map((r) => [r[key], r.n]));
  return {
    period: { from: new Date(Date.now() - 7 * 24 * 3600_000), to: new Date() },
    auctions,
    sales: { orders: sales.orders, gmv: Number(sales.gmv), estimatedFees: Number(sales.fees) },
    payments,
    newAccounts: byKey(signups, 'role'),
    appraisals: byKey(appraisals, 'decision'),
    disputes,
    walletTopups: { count: topups.n, total: Number(topups.total) },
    topCategories: categories.map((c) => ({ code: c.code, orders: c.orders, gmv: Number(c.gmv) })),
  };
}

// ---------- Tài khoản nội bộ (ops) ----------

const OPS_ROLES = ['appraiser', 'warehouse', 'admin'];
const opsView = (r) => ({
  id: r.id, name: r.name, email: r.email, role: r.role, status: r.status,
  weeklyLoad: r.weekly_load, hasPassword: r.has_password,
});
const OPS_SELECT = `SELECT id, name, email, role, status, weekly_load, password_hash IS NOT NULL AS has_password FROM ops_accounts`;

async function listOps({ role, status }) {
  const params = [];
  const where = [];
  if (role) { params.push(validate.oneOf(role, OPS_ROLES, 'Vai trò')); where.push(`role = $${params.length}`); }
  if (status) { params.push(validate.oneOf(status, ['active', 'suspended'], 'Trạng thái')); where.push(`status = $${params.length}`); }
  const { rows } = await pool.query(
    `${OPS_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY role, id`,
    params,
  );
  return rows.map(opsView);
}

async function createOps(input = {}) {
  const name = validate.text(input.name, 'Họ tên', { max: 100 });
  const email = validate.email(input.email);
  const role = validate.oneOf(input.role, OPS_ROLES, 'Vai trò');
  const hash = await bcrypt.hash(validate.password(input.password), SALT_ROUNDS);
  try {
    const { rows } = await pool.query(
      `INSERT INTO ops_accounts (name, email, role, password_hash) VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, status, weekly_load, true AS has_password`,
      [name, email, role, hash],
    );
    return opsView(rows[0]);
  } catch (err) {
    if (err.code === '23505') throw conflict('Email này đã được dùng cho tài khoản nội bộ khác', 'EMAIL_TAKEN');
    throw err;
  }
}

async function updateOps(adminId, opsId, input = {}) {
  const sets = [];
  const params = [opsId];
  const add = (col, v) => { params.push(v); sets.push(`${col} = $${params.length}`); };
  if (input.name !== undefined) add('name', validate.text(input.name, 'Họ tên', { max: 100 }));
  if (input.role !== undefined) add('role', validate.oneOf(input.role, OPS_ROLES, 'Vai trò'));
  if (input.status !== undefined) add('status', validate.oneOf(input.status, ['active', 'suspended'], 'Trạng thái'));
  if (input.password !== undefined) add('password_hash', await bcrypt.hash(validate.password(input.password), SALT_ROUNDS));
  if (!sets.length) throw validate.invalid('Không có trường nào để cập nhật');
  if (String(opsId) === String(adminId) && (input.status === 'suspended' || (input.role && input.role !== 'admin'))) {
    throw conflict('Không thể tự khoá hoặc tự bỏ quyền Admin của chính mình', 'SELF_LOCKOUT');
  }
  const { rows } = await pool.query(
    `UPDATE ops_accounts SET ${sets.join(', ')} WHERE id = $1
     RETURNING id, name, email, role, status, weekly_load, password_hash IS NOT NULL AS has_password`,
    params,
  );
  if (!rows[0]) throw new AppError('Không tìm thấy tài khoản nội bộ', 404, 'NOT_FOUND');
  // UPDATE trên pool tự commit: tới đây việc khoá đã được lưu.
  if (rows[0].status === 'suspended') await disconnectSuspended(rows[0].id, 'ops');
  return opsView(rows[0]);
}

// ---------- Tài khoản Bidder / Seller ----------

async function listAccounts({ role, status, q, limit, offset }) {
  const params = [];
  const where = [];
  if (role) {
    validate.oneOf(role, ['bidder', 'seller'], 'Vai trò');
    where.push(role === 'bidder' ? 'b.account_id IS NOT NULL' : 's.account_id IS NOT NULL');
  }
  if (status) { params.push(validate.oneOf(status, ['active', 'suspended'], 'Trạng thái')); where.push(`a.status = $${params.length}`); }
  if (q) { params.push(`%${validate.text(q, 'Từ khoá', { max: 100 })}%`); where.push(`(a.full_name ILIKE $${params.length} OR a.email ILIKE $${params.length})`); }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT a.id, a.full_name, a.email, a.phone, a.status, a.created_at,
            CASE WHEN b.account_id IS NOT NULL THEN 'bidder' ELSE 'seller' END AS role, s.store_name
     FROM accounts a
     LEFT JOIN bidders b ON b.account_id = a.id
     LEFT JOIN sellers s ON s.account_id = a.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY a.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, role: r.role,
    storeName: r.store_name, status: r.status, createdAt: r.created_at,
  }));
}

async function setAccountStatus(accountId, input = {}) {
  const status = validate.oneOf(input.status, ['active', 'suspended'], 'Trạng thái');
  const { rows } = await pool.query(
    'UPDATE accounts SET status = $2 WHERE id = $1 RETURNING id, full_name, email, status',
    [accountId, status],
  );
  if (!rows[0]) throw new AppError('Không tìm thấy tài khoản', 404, 'NOT_FOUND');
  // UPDATE trên pool tự commit: tới đây việc khoá đã được lưu.
  if (rows[0].status === 'suspended') await disconnectSuspended(rows[0].id, 'account');
  return { id: rows[0].id, fullName: rows[0].full_name, email: rows[0].email, status: rows[0].status };
}

module.exports = {
  dashboard, listFlags, flagAction, weeklyReport, listOps, createOps, updateOps, listAccounts, setAccountStatus,
};
