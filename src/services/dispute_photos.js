// Ảnh bằng chứng của tranh chấp (BE2): kiểm tra URL, giới hạn số ảnh, ghi bảng dispute_photos (migration 009).
// Tách riêng để dispute_service (người mua / người bán) và fulfilment_service (kho khi kiểm hàng không khớp) dùng chung
// mà không require lẫn nhau (dispute_service đã require fulfilment_service).
const { AppError } = require('../middleware/errorHandler');
const uploadService = require('./upload_service');

const MAX_PER_REQUEST = 6;   // mỗi lần gửi
const MAX_PER_DISPUTE = 12;  // tổng cho một tranh chấp

// Mảng URL ảnh trong body (photoUrls). Mỗi URL phải là URL public của CHÍNH bucket Storage của backend (ảnh vừa tải qua
// POST /api/uploads/images), URL khác -> 400 INVALID_PHOTO_URL. URL trùng trong cùng một lần gửi chỉ tính một ảnh.
// required = false: bỏ trống / null / mảng rỗng là 0 ảnh (gửi tranh chấp không kèm ảnh vẫn chạy như cũ).
function parsePhotoUrls(input, { required = false } = {}) {
  if (input === undefined || input === null) {
    if (required) throw new AppError('Cần gửi ít nhất một ảnh trong photoUrls', 400, 'VALIDATION_ERROR');
    return [];
  }
  if (!Array.isArray(input)) throw new AppError('photoUrls phải là mảng URL ảnh', 400, 'VALIDATION_ERROR');
  if (required && input.length === 0) throw new AppError('Cần gửi ít nhất một ảnh trong photoUrls', 400, 'VALIDATION_ERROR');
  if (input.length > MAX_PER_REQUEST) {
    throw new AppError(`Mỗi lần gửi tối đa ${MAX_PER_REQUEST} ảnh`, 400, 'TOO_MANY_FILES');
  }
  const urls = [];
  for (const raw of input) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!uploadService.pathFromPublicUrl(url)) {
      throw new AppError('Ảnh bằng chứng phải là ảnh đã tải lên qua POST /api/uploads/images', 400, 'INVALID_PHOTO_URL');
    }
    if (!urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Ghi ảnh trong giao dịch của nơi gọi. by = { kind: 'account' | 'ops', id, role: 'bidder' | 'seller' | 'warehouse' }.
async function insertPhotos(client, disputeId, urls, by) {
  if (!urls.length) return;
  await client.query(
    `INSERT INTO dispute_photos (dispute_id, url, uploaded_by_kind, uploaded_by_id, uploader_role)
     SELECT $1, t.u, $3, $4, $5 FROM unnest($2::text[]) WITH ORDINALITY AS t(u, n) ORDER BY t.n`,
    [disputeId, urls, by.kind, by.id, by.role],
  );
}

async function countPhotos(client, disputeId) {
  const { rows } = await client.query('SELECT count(*)::int AS n FROM dispute_photos WHERE dispute_id = $1', [disputeId]);
  return rows[0].n;
}

module.exports = { MAX_PER_REQUEST, MAX_PER_DISPUTE, parsePhotoUrls, insertPhotos, countPhotos };
