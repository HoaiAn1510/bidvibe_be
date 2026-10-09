// Tin đăng ký gửi của Seller (BE2): tạo nháp, sửa, thêm ảnh (URL), gửi thẩm định, nộp lại.
// Trạng thái theo migration 001: draft -> pending_appraisal -> (needs_info -> pending_appraisal)*
//   -> rejected | approved -> live (phiên do BE1 sinh) -> ended | cancelled.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const validate = require('../utils/validate');

const MAX_PHOTOS = 10;
const EDITABLE = ['draft', 'needs_info'];

const STATUS_VI = {
  draft: 'nháp',
  pending_appraisal: 'chờ thẩm định',
  needs_info: 'cần bổ sung',
  approved: 'đã duyệt',
  rejected: 'bị từ chối',
  live: 'đang đấu giá',
  ended: 'đã kết thúc',
  cancelled: 'đã huỷ',
};

const invalidState = (status, action) => new AppError(
  `Không thể ${action} khi tin đăng đang ở trạng thái "${STATUS_VI[status] || status}"`,
  409,
  'INVALID_STATE',
);

async function categoryIdOf(executor, code) {
  const c = validate.text(code, 'Danh mục', { max: 50 });
  const { rows } = await executor.query('SELECT id FROM categories WHERE code = $1', [c]);
  if (!rows[0]) throw validate.invalid(`Danh mục "${c}" không tồn tại`);
  return rows[0].id;
}

const LISTING_SELECT = `
  SELECT l.id, l.seller_id, l.title, l.description, l.condition, l.ai_suggested_price,
         l.starting_price, l.duration_hours, l.status, l.created_at,
         c.code AS category,
         a.id AS auction_id, a.status AS auction_status, a.current_price, a.ends_at,
         (SELECT json_agg(json_build_object('id', p.id, 'url', p.url, 'orderIndex', p.order_index)
                          ORDER BY p.order_index, p.id)
            FROM listing_photos p WHERE p.listing_id = l.id) AS photos,
         (SELECT json_build_object('decision', ap.decision, 'reason', ap.reason, 'decidedAt', ap.decided_at)
            FROM appraisals ap WHERE ap.listing_id = l.id
            ORDER BY ap.decided_at DESC, ap.id DESC LIMIT 1) AS last_appraisal
  FROM listings l
  JOIN categories c ON c.id = l.category_id
  LEFT JOIN auctions a ON a.listing_id = l.id
`;

function toView(r) {
  return {
    id: r.id,
    title: r.title,
    category: r.category,
    description: r.description,
    condition: r.condition,
    startingPrice: Number(r.starting_price),
    aiSuggestedPrice: r.ai_suggested_price == null ? null : Number(r.ai_suggested_price),
    durationHours: r.duration_hours,
    status: r.status,
    createdAt: r.created_at,
    photos: r.photos || [],
    lastAppraisal: r.last_appraisal,
    auction: r.auction_id
      ? { id: r.auction_id, status: r.auction_status, currentPrice: Number(r.current_price), endsAt: r.ends_at }
      : null,
  };
}

async function findOwned(executor, sellerId, listingId, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT id, seller_id, status FROM listings WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
    [listingId],
  );
  // Không phân biệt "không tồn tại" và "của người khác" để không lộ tin đăng của Seller khác.
  if (!rows[0] || String(rows[0].seller_id) !== String(sellerId)) {
    throw new AppError('Không tìm thấy tin đăng', 404, 'NOT_FOUND');
  }
  return rows[0];
}

async function getView(executor, listingId) {
  const { rows } = await executor.query(`${LISTING_SELECT} WHERE l.id = $1`, [listingId]);
  return toView(rows[0]);
}

function readFields(input, { partial }) {
  const req = !partial;
  const out = {};
  if (req || input.title !== undefined) out.title = validate.text(input.title, 'Tiêu đề', { max: 200 });
  if (req || input.description !== undefined) {
    out.description = validate.text(input.description, 'Mô tả', { max: 5000, required: false });
  }
  if (req || input.condition !== undefined) {
    out.condition = validate.text(input.condition, 'Tình trạng', { max: 100, required: false });
  }
  if (req || input.startingPrice !== undefined) {
    out.startingPrice = validate.int(input.startingPrice, 'Giá khởi điểm', { min: 1000, max: 10_000_000_000 });
  }
  if (req || input.durationHours !== undefined) {
    out.durationHours = validate.int(input.durationHours, 'Thời lượng phiên (giờ)', { min: 1, max: 336 });
  }
  if (input.aiSuggestedPrice !== undefined) {
    out.aiSuggestedPrice = validate.int(input.aiSuggestedPrice, 'Giá AI gợi ý', { min: 0, max: 10_000_000_000, required: false });
  }
  return out;
}

async function create(sellerId, input = {}) {
  const f = readFields(input, { partial: false });
  const categoryId = await categoryIdOf(pool, input.categoryCode);
  const { rows } = await pool.query(
    `INSERT INTO listings (seller_id, category_id, title, description, condition,
                           ai_suggested_price, starting_price, duration_hours, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft') RETURNING id`,
    [sellerId, categoryId, f.title, f.description, f.condition, f.aiSuggestedPrice ?? null,
      f.startingPrice, f.durationHours],
  );
  return getView(pool, rows[0].id);
}

async function update(sellerId, listingId, input = {}) {
  return inTransaction(async (client) => {
    const l = await findOwned(client, sellerId, listingId, { lock: true });
    if (!EDITABLE.includes(l.status)) throw invalidState(l.status, 'sửa');
    const f = readFields(input, { partial: true });
    if (input.categoryCode !== undefined) f.categoryId = await categoryIdOf(client, input.categoryCode);

    const columns = {
      title: 'title', description: 'description', condition: 'condition', startingPrice: 'starting_price',
      durationHours: 'duration_hours', aiSuggestedPrice: 'ai_suggested_price', categoryId: 'category_id',
    };
    const sets = [];
    const params = [listingId];
    for (const [key, col] of Object.entries(columns)) {
      if (f[key] !== undefined) { params.push(f[key]); sets.push(`${col} = $${params.length}`); }
    }
    if (!sets.length) throw validate.invalid('Không có trường nào để cập nhật');
    await client.query(`UPDATE listings SET ${sets.join(', ')} WHERE id = $1`, params);
    return getView(client, listingId);
  });
}

async function addPhotos(sellerId, listingId, input = {}) {
  const raw = Array.isArray(input.urls) ? input.urls : [input.url];
  if (!raw.length || raw[0] === undefined) throw validate.invalid('Cần gửi url hoặc danh sách urls');
  const urls = raw.map((u) => validate.url(u));
  return inTransaction(async (client) => {
    const l = await findOwned(client, sellerId, listingId, { lock: true });
    if (!EDITABLE.includes(l.status)) throw invalidState(l.status, 'thêm ảnh');
    const { rows } = await client.query(
      'SELECT count(*)::int AS n, coalesce(max(order_index), -1) AS last FROM listing_photos WHERE listing_id = $1',
      [listingId],
    );
    if (rows[0].n + urls.length > MAX_PHOTOS) {
      throw validate.invalid(`Mỗi tin đăng tối đa ${MAX_PHOTOS} ảnh (đang có ${rows[0].n})`);
    }
    let index = rows[0].last;
    for (const u of urls) {
      index += 1;
      await client.query(
        'INSERT INTO listing_photos (listing_id, url, order_index) VALUES ($1, $2, $3)',
        [listingId, u, index],
      );
    }
    return getView(client, listingId);
  });
}

async function moveToAppraisal(sellerId, listingId, fromStatus, action) {
  return inTransaction(async (client) => {
    const l = await findOwned(client, sellerId, listingId, { lock: true });
    if (l.status !== fromStatus) throw invalidState(l.status, action);
    const photos = await client.query('SELECT 1 FROM listing_photos WHERE listing_id = $1 LIMIT 1', [listingId]);
    if (!photos.rowCount) {
      throw new AppError('Cần ít nhất một ảnh trước khi gửi thẩm định', 400, 'PHOTOS_REQUIRED');
    }
    await client.query(`UPDATE listings SET status = 'pending_appraisal' WHERE id = $1`, [listingId]);
    return getView(client, listingId);
  });
}

const submit = (sellerId, listingId) => moveToAppraisal(sellerId, listingId, 'draft', 'gửi thẩm định');
const resubmit = (sellerId, listingId) => moveToAppraisal(sellerId, listingId, 'needs_info', 'nộp lại');

async function listMine(sellerId, { status, limit, offset }) {
  const params = [sellerId];
  let where = 'l.seller_id = $1';
  if (status) {
    params.push(validate.oneOf(status, Object.keys(STATUS_VI), 'Trạng thái'));
    where += ` AND l.status = $${params.length}`;
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `${LISTING_SELECT} WHERE ${where} ORDER BY l.created_at DESC, l.id DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(toView);
}

async function listCategories() {
  const { rows } = await pool.query('SELECT code, name_vi FROM categories ORDER BY id');
  return rows.map((r) => ({ code: r.code, name: r.name_vi }));
}

module.exports = {
  STATUS_VI, invalidState, create, update, addPhotos, submit, resubmit, listMine, listCategories,
};
