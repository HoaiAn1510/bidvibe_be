// Tải ảnh từ điện thoại lên Supabase Storage (BE2), gọi REST bằng fetch có sẵn, không dùng SDK.
// Ảnh nằm trong bucket public; app nhận URL public rồi gửi tiếp vào POST /api/listings/:id/photos
// (hoặc avatarUrl của PATCH /api/me) như với URL ảnh có sẵn.
// Key (secret key sb_secret_... hoặc service_role eyJ...) chỉ dùng ở đây, không trả cho app, không ghi log.
const crypto = require('crypto');
const env = require('../config/env');
const { AppError } = require('../middleware/errorHandler');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 8;
const PURPOSES = ['listing', 'avatar', 'dispute'];
const TYPES = {
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  png: { ext: 'png', mime: 'image/png' },
  webp: { ext: 'webp', mime: 'image/webp' },
};

const isConfigured = () => Boolean(env.supabaseUrl && env.supabaseServiceKey);

function assertConfigured() {
  if (!isConfigured()) {
    throw new AppError('Máy chủ chưa cấu hình nơi lưu ảnh (Supabase Storage)', 503, 'UPLOAD_NOT_CONFIGURED');
  }
}

// Nhận diện loại ảnh theo magic bytes, không tin Content-Type do app gửi.
function detectType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return TYPES.jpeg;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return TYPES.png;
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return TYPES.webp;
  return null;
}

// Key mới dạng sb_secret_ chỉ đi qua header apikey; key JWT (service_role) cần thêm Authorization.
function authHeaders() {
  const key = env.supabaseServiceKey;
  return key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

const objectUrl = (path) => `${env.supabaseUrl}/storage/v1/object/${env.storageBucket}/${path}`;
const publicUrl = (path) => `${env.supabaseUrl}/storage/v1/object/public/${env.storageBucket}/${path}`;

async function storageError(res) {
  const body = await res.text().catch(() => '');
  let message = body;
  try { const j = JSON.parse(body); message = j.message || j.error || body; } catch { /* để nguyên */ }
  return { status: res.status, message: String(message).slice(0, 200) };
}

const failed = (detail) => new AppError(`Không lưu được ảnh lên Storage: ${detail}`, 502, 'UPLOAD_FAILED');

async function request(url, init) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw failed(err.name === 'TimeoutError' ? 'hết thời gian chờ' : 'không kết nối được');
  }
}

// Bucket chưa có thì tạo (public, 5 MB, chỉ 3 loại ảnh). Trùng tên (đã có) coi như thành công.
async function createBucket() {
  const res = await request(`${env.supabaseUrl}/storage/v1/bucket`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: env.storageBucket,
      name: env.storageBucket,
      public: true,
      file_size_limit: MAX_BYTES,
      allowed_mime_types: Object.values(TYPES).map((t) => t.mime),
    }),
  });
  if (res.ok) return;
  const e = await storageError(res);
  if (res.status === 409 || /already exists/i.test(e.message)) return;
  throw failed(`tạo bucket lỗi ${e.status} ${e.message}`);
}

// Nhiều ảnh tải song song cùng gặp "Bucket not found" thì chỉ tạo bucket một lần.
const creating = new Map();
function ensureBucket() {
  const bucket = env.storageBucket;
  if (!creating.has(bucket)) {
    creating.set(bucket, createBucket().finally(() => creating.delete(bucket)));
  }
  return creating.get(bucket);
}

async function putObject(path, buf, mime, retry = true) {
  const res = await request(objectUrl(path), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': mime, 'x-upsert': 'false', 'Cache-Control': 'max-age=3600' },
    body: buf,
  });
  if (res.ok) return;
  const e = await storageError(res);
  if (retry && /bucket not found/i.test(e.message)) {
    await ensureBucket();
    return putObject(path, buf, mime, false);
  }
  throw failed(`${e.status} ${e.message}`);
}

async function deleteObject(path) {
  const res = await request(objectUrl(path), { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) { const e = await storageError(res); throw failed(`xoá lỗi ${e.status} ${e.message}`); }
}

// URL public do uploadImages trả về -> đường dẫn object trong bucket (null nếu không phải của bucket này).
function pathFromPublicUrl(url) {
  const prefix = publicUrl('');
  return typeof url === 'string' && url.startsWith(prefix) ? url.slice(prefix.length) : null;
}

// files: [{ buffer, originalname }] từ multer. Trả URL public theo đúng thứ tự file.
async function uploadImages(accountId, files, purpose = 'listing') {
  assertConfigured();
  if (!PURPOSES.includes(purpose)) {
    throw new AppError(`purpose phải là một trong: ${PURPOSES.join(', ')}`, 400, 'VALIDATION_ERROR');
  }
  if (!files || !files.length) throw new AppError('Cần gửi ít nhất một ảnh trong trường files', 400, 'VALIDATION_ERROR');
  if (files.length > MAX_FILES) throw new AppError(`Tối đa ${MAX_FILES} ảnh mỗi lần`, 400, 'TOO_MANY_FILES');
  const items = files.map((f, i) => {
    const type = detectType(f.buffer);
    if (!type) {
      throw new AppError(`Ảnh thứ ${i + 1} không phải JPEG, PNG hoặc WEBP`, 400, 'INVALID_FILE_TYPE');
    }
    const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${type.ext}`;
    return { path: `${purpose}/${accountId}/${name}`, buf: f.buffer, mime: type.mime };
  });

  const results = await Promise.allSettled(items.map((it) => putObject(it.path, it.buf, it.mime)));
  const firstError = results.find((r) => r.status === 'rejected');
  if (firstError) {
    // Một ảnh lỗi thì xoá các ảnh đã lên để không để lại file mồ côi.
    await Promise.allSettled(items.filter((_, i) => results[i].status === 'fulfilled').map((it) => deleteObject(it.path)));
    throw firstError.reason;
  }
  return items.map((it) => publicUrl(it.path));
}

module.exports = { MAX_BYTES, MAX_FILES, isConfigured, assertConfigured, detectType, uploadImages, deleteObject, pathFromPublicUrl };
