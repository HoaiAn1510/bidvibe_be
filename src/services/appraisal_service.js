// Thẩm định tin đăng (BE2). Mỗi quyết định thêm MỘT dòng appraisals, không sửa dòng cũ.
// Duyệt: listings -> 'approved', rồi gọi createAuctionForListing của BE1 trong cùng giao dịch
// (hàm này sinh auctions và chuyển listings -> 'live').
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction, createAuctionForListing } = require('./auction_engine');
const { createNotification, emitNotification } = require('./notification_service');
const { invalidState } = require('./listing_service');
const validate = require('../utils/validate');

const QUEUE_STATUSES = ['pending_appraisal', 'needs_info'];

async function queue({ status = 'pending_appraisal', limit, offset }) {
  validate.oneOf(status, QUEUE_STATUSES, 'Trạng thái');
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.starting_price, l.ai_suggested_price, l.condition, l.duration_hours,
            l.status, l.created_at, c.code AS category,
            s.account_id AS seller_id, s.store_name, s.rating,
            (SELECT count(*)::int FROM listing_photos p WHERE p.listing_id = l.id) AS photo_count,
            (SELECT count(*)::int FROM appraisals ap WHERE ap.listing_id = l.id) AS rounds,
            (SELECT max(ap.decided_at) FROM appraisals ap WHERE ap.listing_id = l.id) AS last_decided_at
     FROM listings l
     JOIN categories c ON c.id = l.category_id
     JOIN sellers s ON s.account_id = l.seller_id
     WHERE l.status = $1
     ORDER BY l.created_at ASC, l.id ASC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset],
  );
  return rows.map((r) => ({
    listingId: r.id,
    title: r.title,
    category: r.category,
    startingPrice: Number(r.starting_price),
    aiSuggestedPrice: r.ai_suggested_price == null ? null : Number(r.ai_suggested_price),
    condition: r.condition,
    durationHours: r.duration_hours,
    status: r.status,
    createdAt: r.created_at,
    seller: { id: r.seller_id, storeName: r.store_name, rating: r.rating == null ? null : Number(r.rating) },
    photoCount: r.photo_count,
    rounds: r.rounds,
    lastDecidedAt: r.last_decided_at,
  }));
}

async function detail(listingId) {
  const { rows } = await pool.query(
    `SELECT l.id, l.title, l.description, l.condition, l.starting_price, l.ai_suggested_price,
            l.duration_hours, l.status, l.created_at, c.code AS category,
            s.account_id AS seller_id, s.store_name, s.rating,
            (SELECT count(*)::int FROM listings x WHERE x.seller_id = l.seller_id AND x.status = 'ended') AS seller_ended
     FROM listings l
     JOIN categories c ON c.id = l.category_id
     JOIN sellers s ON s.account_id = l.seller_id
     WHERE l.id = $1`,
    [listingId],
  );
  const l = rows[0];
  if (!l) throw new AppError('Không tìm thấy tin đăng', 404, 'NOT_FOUND');
  const [photos, history] = await Promise.all([
    pool.query('SELECT id, url, order_index FROM listing_photos WHERE listing_id = $1 ORDER BY order_index, id', [listingId]),
    pool.query(
      `SELECT ap.id, ap.decision, ap.reason, ap.decided_at, o.name AS appraiser
       FROM appraisals ap JOIN ops_accounts o ON o.id = ap.appraiser_id
       WHERE ap.listing_id = $1 ORDER BY ap.decided_at, ap.id`,
      [listingId],
    ),
  ]);
  return {
    listingId: l.id,
    title: l.title,
    description: l.description,
    condition: l.condition,
    category: l.category,
    startingPrice: Number(l.starting_price),
    aiSuggestedPrice: l.ai_suggested_price == null ? null : Number(l.ai_suggested_price),
    durationHours: l.duration_hours,
    status: l.status,
    createdAt: l.created_at,
    seller: {
      id: l.seller_id,
      storeName: l.store_name,
      rating: l.rating == null ? null : Number(l.rating),
      endedListings: l.seller_ended,
    },
    photos: photos.rows.map((p) => ({ id: p.id, url: p.url, orderIndex: p.order_index })),
    history: history.rows.map((h) => ({
      id: h.id, decision: h.decision, reason: h.reason, decidedAt: h.decided_at, appraiser: h.appraiser,
    })),
  };
}

async function decide(appraiserId, listingId, input = {}) {
  const decision = validate.oneOf(input.decision, ['approve', 'reject', 'more_info'], 'Quyết định');
  const reason = validate.text(input.reason, 'Lý do', { max: 1000, required: decision !== 'approve' });

  const result = await inTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT id, seller_id, title, status FROM listings WHERE id = $1 FOR UPDATE',
      [listingId],
    );
    const l = rows[0];
    if (!l) throw new AppError('Không tìm thấy tin đăng', 404, 'NOT_FOUND');
    if (l.status !== 'pending_appraisal') throw invalidState(l.status, 'thẩm định');

    const ap = await client.query(
      `INSERT INTO appraisals (listing_id, appraiser_id, decision, reason)
       VALUES ($1, $2, $3, $4) RETURNING id, decided_at`,
      [listingId, appraiserId, decision, reason],
    );

    let auctionId = null;
    let title;
    let type;
    if (decision === 'approve') {
      await client.query(`UPDATE listings SET status = 'approved' WHERE id = $1`, [listingId]);
      auctionId = await createAuctionForListing(client, listingId); // BE1: sinh phiên, listings -> 'live'
      type = 'listing_approved';
      title = `Tin đăng "${l.title}" đã được duyệt, phiên đấu giá đã mở.`;
    } else if (decision === 'reject') {
      await client.query(`UPDATE listings SET status = 'rejected' WHERE id = $1`, [listingId]);
      type = 'listing_rejected';
      title = `Tin đăng "${l.title}" bị từ chối: ${reason}`;
    } else {
      await client.query(`UPDATE listings SET status = 'needs_info' WHERE id = $1`, [listingId]);
      type = 'listing_needs_info';
      title = `Tin đăng "${l.title}" cần bổ sung: ${reason}`;
    }
    const note = await createNotification(client, { accountId: l.seller_id, type, title });
    const status = await client.query('SELECT status FROM listings WHERE id = $1', [listingId]);
    return {
      appraisalId: ap.rows[0].id,
      decidedAt: ap.rows[0].decided_at,
      listingId: l.id,
      decision,
      listingStatus: status.rows[0].status,
      auctionId,
      note,
    };
  });

  emitNotification(result.note); // sau COMMIT
  const { note, ...data } = result;
  return data;
}

module.exports = { queue, detail, decide };
