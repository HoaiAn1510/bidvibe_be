const { AppError } = require('../middleware/errorHandler');

const ok = (res, data, status = 200) => res.status(status).json({ success: true, data, error: null });

// Chuyển tham số id (chuỗi) sang chuỗi số hợp lệ, tránh lỗi cú pháp bigint từ Postgres.
function idParam(value, name = 'id') {
  if (!/^\d{1,18}$/.test(String(value))) {
    throw new AppError(`${name} không hợp lệ`, 400, 'VALIDATION_ERROR');
  }
  return String(value);
}

function intField(value, name) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n)) {
    throw new AppError(`${name} phải là số nguyên`, 400, 'VALIDATION_ERROR');
  }
  return n;
}

function pageParams(query, { max = 100, def = 50 } = {}) {
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || def, 1), max);
  const offset = Math.max(parseInt(query.offset, 10) || 0, 0);
  return { limit, offset };
}

module.exports = { ok, idParam, intField, pageParams };
