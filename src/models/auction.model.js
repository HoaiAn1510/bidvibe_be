const { pool } = require('../config/db');

// Che tên người đặt giá: "Nguyễn Văn An" -> "A***"
function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  const last = parts[parts.length - 1] || '?';
  return `${last[0].toUpperCase()}***`;
}

// Phiên đang tạm dừng: có paused_at (trigger migration 006) hoặc còn cờ 'paused'.
const PAUSED_SQL = `(a.paused_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'paused'))`;

const SELECT_AUCTION = `
  SELECT a.id, a.listing_id, a.current_price, a.bid_step, a.deposit_required,
         a.starts_at, a.ends_at, a.status, a.winner_id, a.bid_count, a.paused_at,
         l.title, l.description, l.condition, l.starting_price, l.seller_id,
         c.code AS category,
         s.store_name, s.rating, sa.full_name AS seller_full_name,
         (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.order_index, p.id LIMIT 1) AS cover_url,
         ${PAUSED_SQL} AS paused,
         -- Mọi mốc thời gian tính theo giờ DATABASE (clock_timestamp), không theo giờ máy chạy backend.
         -- Đang tạm dừng thì đồng hồ đứng ở paused_at (ends_at được cộng bù khi tiếp tục).
         CASE WHEN a.status = 'active'
              THEN GREATEST(ceil(extract(epoch FROM (a.ends_at - CASE WHEN ${PAUSED_SQL} AND a.paused_at IS NOT NULL
                                                                      THEN a.paused_at ELSE clock_timestamp() END)))::int, 0)
              ELSE 0 END AS remaining_seconds,
         (a.ends_at > clock_timestamp()) AS before_end,
         EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'terminated') AS terminated,
         (SELECT b.bidder_id FROM bids b WHERE b.auction_id = a.id ORDER BY b.id DESC LIMIT 1) AS leader_id,
         (SELECT max(b.amount) FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = $1::bigint) AS my_bid,
         d.status AS my_deposit_status, d.amount AS my_deposit,
         w.wallet_balance AS my_balance
  FROM auctions a
  JOIN listings l   ON l.id = a.listing_id
  JOIN categories c ON c.id = l.category_id
  JOIN sellers s    ON s.account_id = l.seller_id
  JOIN accounts sa  ON sa.id = l.seller_id
  LEFT JOIN auction_deposits d ON d.auction_id = a.id AND d.bidder_id = $1::bigint
  LEFT JOIN bidders w ON w.account_id = $1::bigint
`;

// Trạng thái của người đang xem trong phiên, suy ra từ các cột đã có trong cùng một truy vấn (không truy vấn thêm từng phiên):
//   null            không tham gia (chưa đặt cọc), hoặc người xem không phải người mua
//   joined_no_bid   đã đặt cọc, phiên đang diễn ra, chưa đặt giá lần nào
//   leading         phiên đang diễn ra và mình đang dẫn đầu
//   outbid          phiên đang diễn ra, mình đã đặt giá nhưng người khác đang dẫn đầu
//   won             phiên đã kết thúc và mình thắng
//   lost            phiên đã kết thúc không thắng (người khác thắng, không ai thắng, hoặc phiên bị huỷ / chấm dứt)
// "Đang diễn ra" = status 'active' (tối đa vài giây sau giờ kết thúc scheduler mới đóng phiên nên trạng thái vẫn là trạng thái cuối cùng của phiên đang chạy).
function myStateOf(r, viewer) {
  if (viewer == null || r.my_deposit_status == null) return null;
  if (r.status === 'active') {
    if (r.leader_id != null && String(r.leader_id) === viewer) return 'leading';
    return r.my_bid == null ? 'joined_no_bid' : 'outbid';
  }
  return r.winner_id != null && String(r.winner_id) === viewer ? 'won' : 'lost';
}

function toView(r, viewerId) {
  const viewer = viewerId == null ? null : String(viewerId);
  const live = r.status === 'active' && (r.paused || r.before_end);
  return {
    id: r.id,
    listingId: r.listing_id,
    title: r.title,
    category: r.category,
    description: r.description,
    condition: r.condition,
    coverUrl: r.cover_url,
    // name: tên hiển thị (tên shop, chưa đặt tên shop thì họ tên người bán)
    seller: {
      id: r.seller_id, storeName: r.store_name, name: r.store_name || r.seller_full_name,
      rating: r.rating == null ? null : Number(r.rating),
    },
    startPrice: Number(r.starting_price),
    currentPrice: Number(r.current_price),
    bidStep: Number(r.bid_step),
    // Giá nhỏ nhất được đặt tiếp theo (POST /api/bids nhỏ hơn mức này -> 400 BID_TOO_LOW)
    minNextBid: Number(r.current_price) + Number(r.bid_step),
    depositRequired: Number(r.deposit_required),
    // Số dư ví đủ để đặt cọc chưa (chỉ người xem là bidder; tài khoản khác: null)
    depositAffordable: r.my_balance == null ? null : Number(r.my_balance) >= Number(r.deposit_required),
    bidCount: r.bid_count,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    isLive: live && !r.paused,
    paused: r.paused,
    pausedAt: r.paused_at,
    // Giây còn lại của phiên đang diễn ra; đứng yên khi tạm dừng. 0 nếu đã kết thúc. Tính trong SQL theo giờ DB.
    remainingSeconds: r.remaining_seconds,
    terminated: r.terminated,
    winnerId: r.winner_id,
    // Thông tin riêng của người đang xem
    joined: r.my_deposit_status != null,
    myDepositStatus: r.my_deposit_status,
    myDeposit: r.my_deposit == null ? 0 : Number(r.my_deposit),
    myBid: r.my_bid == null ? 0 : Number(r.my_bid),
    // Giá cao nhất mình đã đặt trong phiên (null nếu chưa đặt lần nào) và trạng thái của mình (xem myStateOf)
    myMaxBid: r.my_bid == null ? null : Number(r.my_bid),
    myState: myStateOf(r, viewer),
    leading: viewer != null && r.leader_id != null && String(r.leader_id) === viewer,
    won: viewer != null && r.winner_id != null && String(r.winner_id) === viewer,
  };
}

async function findById(executor, auctionId, viewerId = null) {
  const { rows } = await (executor || pool).query(`${SELECT_AUCTION} WHERE a.id = $2`, [viewerId, auctionId]);
  return rows[0] ? toView(rows[0], viewerId) : null;
}

// Điều kiện lọc dùng chung cho list() và count(). status: 'live' | 'ended' | 'joined' | undefined (tất cả)
function buildFilter({ viewerId = null, category, status, q } = {}) {
  const params = [viewerId];
  const where = [];
  if (category) { params.push(category); where.push(`c.code = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`l.title ILIKE $${params.length}`); }
  if (status === 'live') where.push(`a.status = 'active' AND a.ends_at > now()`);
  else if (status === 'ended') where.push(`(a.status <> 'active' OR a.ends_at <= now())`);
  else if (status === 'joined') where.push('d.id IS NOT NULL');
  return { params, whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '' };
}

async function list({ viewerId = null, category, status, q, sort = 'ending', limit = 50, offset = 0 } = {}) {
  const { params, whereSql } = buildFilter({ viewerId, category, status, q });

  const order = {
    ending: 'a.ends_at ASC',
    newest: 'a.starts_at DESC',
    price_asc: 'a.current_price ASC',
    price_desc: 'a.current_price DESC',
    popular: 'a.bid_count DESC',
  }[sort] || 'a.ends_at ASC';

  params.push(limit, offset);
  const sql = `${SELECT_AUCTION}
    ${whereSql}
    ORDER BY ${order}, a.id
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => toView(r, viewerId));
}

// Tổng số phiên khớp bộ lọc (không tính limit/offset), cho phân trang.
async function count({ viewerId = null, category, status, q } = {}) {
  const { params, whereSql } = buildFilter({ viewerId, category, status, q });
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n
     FROM auctions a
     JOIN listings l   ON l.id = a.listing_id
     JOIN categories c ON c.id = l.category_id
     LEFT JOIN auction_deposits d ON d.auction_id = a.id AND d.bidder_id = $1::bigint
     ${whereSql}`,
    params,
  );
  return rows[0].n;
}

// Ảnh của tin đăng, ảnh bìa (coverUrl) đứng đầu.
async function listPhotos(executor, listingId) {
  const { rows } = await (executor || pool).query(
    'SELECT id, url, order_index FROM listing_photos WHERE listing_id = $1 ORDER BY order_index, id',
    [listingId],
  );
  return rows.map((p) => ({ id: p.id, url: p.url, orderIndex: p.order_index }));
}

// Khoá dòng phiên để đặt giá / tham gia / đóng phiên không đè nhau.
async function lockById(client, auctionId, { skipLocked = false } = {}) {
  const { rows } = await client.query(
    // expired / seconds_left theo giờ DATABASE (clock_timestamp): hết giờ, và còn bao nhiêu giây (cho chống chốt phút chót).
    `SELECT a.*, l.seller_id, l.title, l.id AS l_id,
            ${PAUSED_SQL} AS paused,
            (a.ends_at <= clock_timestamp()) AS expired,
            extract(epoch FROM (a.ends_at - clock_timestamp()))::float8 AS seconds_left
     FROM auctions a JOIN listings l ON l.id = a.listing_id
     WHERE a.id = $1
     FOR UPDATE OF a ${skipLocked ? 'SKIP LOCKED' : ''}`,
    [auctionId],
  );
  return rows[0] || null;
}

async function findExpiredIds(executor) {
  const { rows } = await (executor || pool).query(
    `SELECT a.id FROM auctions a
     WHERE a.status = 'active' AND a.ends_at <= now() AND a.paused_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'paused')
     ORDER BY a.ends_at`,
  );
  return rows.map((r) => r.id);
}

// startsAt null / bỏ trống: bắt đầu ngay theo giờ DATABASE (now()); ends_at = starts_at + durationHours.
async function insertAuction(client, { listingId, currentPrice, bidStep, depositRequired, startsAt = null, durationHours }) {
  const { rows } = await client.query(
    `INSERT INTO auctions (listing_id, current_price, bid_step, deposit_required, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()), COALESCE($5::timestamptz, now()) + ($6 * interval '1 hour'))
     RETURNING id`,
    [listingId, currentPrice, bidStep, depositRequired, startsAt, durationHours],
  );
  return rows[0].id;
}

// Cho phiên đã kết thúc (phục vụ BE2: gợi ý giá AI, báo cáo).
async function listEndedHistory({ categoryCode, limit = 100 } = {}) {
  const params = [];
  let where = `a.status = 'ended' AND a.bid_count > 0`;
  if (categoryCode) { params.push(categoryCode); where += ` AND c.code = $1`; }
  params.push(limit);
  const { rows } = await pool.query(
    `SELECT a.id, l.title, c.code AS category, l.starting_price, a.current_price AS final_price, a.bid_count, a.ends_at
     FROM auctions a JOIN listings l ON l.id = a.listing_id JOIN categories c ON c.id = l.category_id
     WHERE ${where}
     ORDER BY a.ends_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    startingPrice: Number(r.starting_price),
    finalPrice: Number(r.final_price),
    bidCount: r.bid_count,
    endedAt: r.ends_at,
  }));
}

module.exports = {
  maskName, toView, findById, list, count, listPhotos, lockById, findExpiredIds, insertAuction, listEndedHistory,
};
