const { pool } = require('../config/db');

// Che tên người đặt giá: "Nguyễn Văn An" -> "A***"
function maskName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  const last = parts[parts.length - 1] || '?';
  return `${last[0].toUpperCase()}***`;
}

const SELECT_AUCTION = `
  SELECT a.id, a.listing_id, a.current_price, a.bid_step, a.deposit_required,
         a.starts_at, a.ends_at, a.status, a.winner_id, a.bid_count, a.paused_at,
         l.title, l.description, l.condition, l.starting_price, l.seller_id,
         c.code AS category,
         s.store_name, s.rating,
         (SELECT url FROM listing_photos p WHERE p.listing_id = l.id ORDER BY p.order_index, p.id LIMIT 1) AS cover_url,
         (a.paused_at IS NOT NULL
           OR EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'paused')) AS paused,
         EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'terminated') AS terminated,
         (SELECT b.bidder_id FROM bids b WHERE b.auction_id = a.id ORDER BY b.id DESC LIMIT 1) AS leader_id,
         (SELECT max(b.amount) FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = $1::bigint) AS my_bid,
         d.status AS my_deposit_status, d.amount AS my_deposit
  FROM auctions a
  JOIN listings l   ON l.id = a.listing_id
  JOIN categories c ON c.id = l.category_id
  JOIN sellers s    ON s.account_id = l.seller_id
  LEFT JOIN auction_deposits d ON d.auction_id = a.id AND d.bidder_id = $1::bigint
`;

function toView(r, viewerId) {
  const viewer = viewerId == null ? null : String(viewerId);
  const now = Date.now();
  const endsAtMs = new Date(r.ends_at).getTime();
  // Đang tạm dừng thì đồng hồ đứng: còn lại = ends_at - lúc bắt đầu dừng (ends_at được cộng bù khi tiếp tục).
  const clockMs = r.paused && r.paused_at ? new Date(r.paused_at).getTime() : now;
  const live = r.status === 'active' && (r.paused || endsAtMs > now);
  return {
    id: r.id,
    listingId: r.listing_id,
    title: r.title,
    category: r.category,
    description: r.description,
    condition: r.condition,
    coverUrl: r.cover_url,
    seller: { id: r.seller_id, storeName: r.store_name, rating: r.rating == null ? null : Number(r.rating) },
    startPrice: Number(r.starting_price),
    currentPrice: Number(r.current_price),
    bidStep: Number(r.bid_step),
    depositRequired: Number(r.deposit_required),
    bidCount: r.bid_count,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    status: r.status,
    isLive: live && !r.paused,
    paused: r.paused,
    pausedAt: r.paused_at,
    // Giây còn lại của phiên đang diễn ra; đứng yên khi tạm dừng. 0 nếu đã kết thúc.
    remainingSeconds: r.status === 'active' ? Math.max(Math.ceil((endsAtMs - clockMs) / 1000), 0) : 0,
    terminated: r.terminated,
    winnerId: r.winner_id,
    // Thông tin riêng của người đang xem
    joined: r.my_deposit_status != null,
    myDepositStatus: r.my_deposit_status,
    myDeposit: r.my_deposit == null ? 0 : Number(r.my_deposit),
    myBid: r.my_bid == null ? 0 : Number(r.my_bid),
    leading: viewer != null && r.leader_id != null && String(r.leader_id) === viewer,
    won: viewer != null && r.winner_id != null && String(r.winner_id) === viewer,
  };
}

async function findById(executor, auctionId, viewerId = null) {
  const { rows } = await (executor || pool).query(`${SELECT_AUCTION} WHERE a.id = $2`, [viewerId, auctionId]);
  return rows[0] ? toView(rows[0], viewerId) : null;
}

// status: 'live' | 'ended' | 'joined' | undefined (tất cả)
async function list({ viewerId = null, category, status, q, sort = 'ending', limit = 50, offset = 0 } = {}) {
  const params = [viewerId];
  const where = [];
  if (category) { params.push(category); where.push(`c.code = $${params.length}`); }
  if (q) { params.push(`%${q}%`); where.push(`l.title ILIKE $${params.length}`); }
  if (status === 'live') where.push(`a.status = 'active' AND a.ends_at > now()`);
  else if (status === 'ended') where.push(`(a.status <> 'active' OR a.ends_at <= now())`);
  else if (status === 'joined') where.push('d.id IS NOT NULL');

  const order = {
    ending: 'a.ends_at ASC',
    newest: 'a.starts_at DESC',
    price_asc: 'a.current_price ASC',
    price_desc: 'a.current_price DESC',
    popular: 'a.bid_count DESC',
  }[sort] || 'a.ends_at ASC';

  params.push(limit, offset);
  const sql = `${SELECT_AUCTION}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${order}, a.id
    LIMIT $${params.length - 1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => toView(r, viewerId));
}

// Khoá dòng phiên để đặt giá / tham gia / đóng phiên không đè nhau.
async function lockById(client, auctionId, { skipLocked = false } = {}) {
  const { rows } = await client.query(
    `SELECT a.*, l.seller_id, l.title, l.id AS l_id,
            (a.paused_at IS NOT NULL
              OR EXISTS (SELECT 1 FROM flagged_auctions f WHERE f.auction_id = a.id AND f.status = 'paused')) AS paused
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

async function insertAuction(client, { listingId, currentPrice, bidStep, depositRequired, startsAt, endsAt }) {
  const { rows } = await client.query(
    `INSERT INTO auctions (listing_id, current_price, bid_step, deposit_required, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [listingId, currentPrice, bidStep, depositRequired, startsAt, endsAt],
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
  maskName, toView, findById, list, lockById, findExpiredIds, insertAuction, listEndedHistory,
};
