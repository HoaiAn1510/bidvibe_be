// Kiểm tra đầu vào dùng chung cho các route BE2. Lỗi luôn là 400 VALIDATION_ERROR, tiếng Việt.
const { AppError } = require('../middleware/errorHandler');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 6;

const invalid = (message) => new AppError(message, 400, 'VALIDATION_ERROR');

function text(value, label, { max = 200, required = true } = {}) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw invalid(`${label} không được để trống`);
    return null;
  }
  if (typeof value !== 'string') throw invalid(`${label} phải là chuỗi`);
  const v = value.trim();
  if (v.length > max) throw invalid(`${label} tối đa ${max} ký tự`);
  return v;
}

function email(value) {
  const v = text(value, 'Email', { max: 254 });
  if (!EMAIL_RE.test(v)) throw invalid('Email không đúng định dạng');
  return v.toLowerCase();
}

function password(value) {
  if (typeof value !== 'string' || value.length < MIN_PASSWORD) {
    throw invalid(`Mật khẩu tối thiểu ${MIN_PASSWORD} ký tự`);
  }
  if (value.length > 72) throw invalid('Mật khẩu tối đa 72 ký tự'); // giới hạn của bcrypt
  return value;
}

function oneOf(value, allowed, label) {
  if (!allowed.includes(value)) throw invalid(`${label} phải là một trong: ${allowed.join(', ')}`);
  return value;
}

function int(value, label, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (value == null || value === '') {
    if (required) throw invalid(`${label} không được để trống`);
    return null;
  }
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n)) throw invalid(`${label} phải là số nguyên`);
  if (n < min || n > max) throw invalid(`${label} phải từ ${min} đến ${max}`);
  return n;
}

function url(value, label = 'URL ảnh') {
  const v = text(value, label, { max: 2000 });
  let parsed;
  try { parsed = new URL(v); } catch { throw invalid(`${label} không hợp lệ`); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw invalid(`${label} phải bắt đầu bằng http:// hoặc https://`);
  return v;
}

module.exports = { MIN_PASSWORD, invalid, text, email, password, oneOf, int, url };
