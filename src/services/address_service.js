// Địa chỉ giao hàng của người mua (BE2), bảng addresses (migration 005).
// Giữ đúng lịch sử giao hàng: địa chỉ đã gắn vào đơn đã gửi đi thì không bị đổi nội dung.
//   - Xoá: xoá mềm (deleted_at), đơn cũ vẫn đọc được.
//   - Sửa: nếu có đơn đã gửi đi đang dùng địa chỉ này thì tạo dòng mới với nội dung mới, xoá mềm
//     dòng cũ và chuyển các đơn chưa gửi sang dòng mới; nếu không thì sửa tại chỗ.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const validate = require('../utils/validate');

const MAX_ADDRESSES = 10;
const PHONE_RE = /^\+?[0-9\s.()-]{8,20}$/;

const notFound = () => new AppError('Không tìm thấy địa chỉ', 404, 'NOT_FOUND');

function phone(value) {
  const v = validate.text(value, 'Số điện thoại', { max: 20 });
  const digits = v.replace(/\D/g, '');
  if (!PHONE_RE.test(v) || digits.length < 9 || digits.length > 15) {
    throw validate.invalid('Số điện thoại không hợp lệ');
  }
  return v;
}

const FIELDS = {
  recipientName: ['recipient_name', (v) => validate.text(v, 'Tên người nhận', { max: 100 })],
  phone: ['phone', phone],
  addressLine: ['address_line', (v) => validate.text(v, 'Địa chỉ', { max: 255 })],
  ward: ['ward', (v) => validate.text(v, 'Phường / xã', { max: 100, required: false })],
  district: ['district', (v) => validate.text(v, 'Quận / huyện', { max: 100, required: false })],
  city: ['city', (v) => validate.text(v, 'Tỉnh / thành phố', { max: 100 })],
};

function readFields(input, { partial }) {
  const out = {};
  for (const [key, [col, check]] of Object.entries(FIELDS)) {
    if (!partial || input[key] !== undefined) out[col] = check(input[key]);
  }
  return out;
}

const SELECT = 'SELECT id, recipient_name, phone, address_line, ward, district, city, is_default, created_at FROM addresses';

function toView(r) {
  return {
    id: r.id,
    recipientName: r.recipient_name,
    phone: r.phone,
    addressLine: r.address_line,
    ward: r.ward,
    district: r.district,
    city: r.city,
    isDefault: r.is_default,
    createdAt: r.created_at,
  };
}

async function list(accountId) {
  const { rows } = await pool.query(
    `${SELECT} WHERE account_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, id DESC`,
    [accountId],
  );
  return rows.map(toView);
}

// Khoá và kiểm tra quyền sở hữu; địa chỉ của người khác hoặc đã xoá đều trả 404.
async function lockOwned(client, accountId, addressId) {
  const { rows } = await client.query(
    'SELECT id, account_id, is_default FROM addresses WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
    [addressId],
  );
  if (!rows[0] || String(rows[0].account_id) !== String(accountId)) throw notFound();
  return rows[0];
}

async function clearDefault(client, accountId) {
  await client.query(
    'UPDATE addresses SET is_default = false WHERE account_id = $1 AND is_default AND deleted_at IS NULL',
    [accountId],
  );
}

async function create(accountId, input = {}) {
  const f = readFields(input, { partial: false });
  return inTransaction(async (client) => {
    // Khoá theo tài khoản để hai request song song không vượt giới hạn / tranh mặc định.
    await client.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    const { rows: [count] } = await client.query(
      'SELECT count(*)::int AS n FROM addresses WHERE account_id = $1 AND deleted_at IS NULL',
      [accountId],
    );
    if (count.n >= MAX_ADDRESSES) throw validate.invalid(`Tối đa ${MAX_ADDRESSES} địa chỉ cho mỗi tài khoản`);
    const makeDefault = count.n === 0 || input.isDefault === true;
    if (makeDefault) await clearDefault(client, accountId);
    const { rows } = await client.query(
      `INSERT INTO addresses (account_id, recipient_name, phone, address_line, ward, district, city, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, recipient_name, phone, address_line, ward, district, city, is_default, created_at`,
      [accountId, f.recipient_name, f.phone, f.address_line, f.ward, f.district, f.city, makeDefault],
    );
    return toView(rows[0]);
  });
}

// Đơn đã được kho gửi đi (shipments shipped/delivered) đang dùng địa chỉ này?
async function usedByShippedOrder(client, addressId) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM orders o JOIN shipments s ON s.order_id = o.id
     WHERE o.shipping_address_id = $1 AND s.status IN ('shipped', 'delivered') LIMIT 1`,
    [addressId],
  );
  return rowCount > 0;
}

async function update(accountId, addressId, input = {}) {
  const f = readFields(input, { partial: true });
  if (!Object.keys(f).length) throw validate.invalid('Không có trường nào để cập nhật');
  return inTransaction(async (client) => {
    const a = await lockOwned(client, accountId, addressId);

    if (!(await usedByShippedOrder(client, addressId))) {
      const cols = Object.keys(f);
      const sets = cols.map((c, i) => `${c} = $${i + 2}`);
      const { rows } = await client.query(
        `UPDATE addresses SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, recipient_name, phone, address_line, ward, district, city, is_default, created_at`,
        [addressId, ...cols.map((c) => f[c])],
      );
      return toView(rows[0]);
    }

    // Sao chép khi ghi: giữ nguyên dòng cũ cho đơn đã gửi.
    const { rows: [old] } = await client.query(`${SELECT} WHERE id = $1`, [addressId]);
    const merged = { ...old, ...f };
    await client.query('UPDATE addresses SET deleted_at = now(), is_default = false WHERE id = $1', [addressId]);
    const { rows } = await client.query(
      `INSERT INTO addresses (account_id, recipient_name, phone, address_line, ward, district, city, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, recipient_name, phone, address_line, ward, district, city, is_default, created_at`,
      [accountId, merged.recipient_name, merged.phone, merged.address_line, merged.ward, merged.district,
        merged.city, a.is_default],
    );
    const fresh = rows[0];
    // Đơn chưa được gửi đi vẫn dùng địa chỉ cũ thì chuyển sang bản mới.
    await client.query(
      `UPDATE orders o SET shipping_address_id = $2
       WHERE o.shipping_address_id = $1
         AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status IN ('shipped', 'delivered'))`,
      [addressId, fresh.id],
    );
    return toView(fresh);
  });
}

async function setDefault(accountId, addressId) {
  return inTransaction(async (client) => {
    await lockOwned(client, accountId, addressId);
    await clearDefault(client, accountId);
    const { rows } = await client.query(
      `UPDATE addresses SET is_default = true WHERE id = $1
       RETURNING id, recipient_name, phone, address_line, ward, district, city, is_default, created_at`,
      [addressId],
    );
    return toView(rows[0]);
  });
}

async function remove(accountId, addressId) {
  return inTransaction(async (client) => {
    const a = await lockOwned(client, accountId, addressId);
    // Đơn chưa gửi đi đang dùng địa chỉ này: bỏ gắn để người mua chọn lại trước khi kho gửi.
    await client.query(
      `UPDATE orders o SET shipping_address_id = NULL
       WHERE o.shipping_address_id = $1
         AND NOT EXISTS (SELECT 1 FROM shipments s WHERE s.order_id = o.id AND s.status IN ('shipped', 'delivered'))`,
      [addressId],
    );
    await client.query('UPDATE addresses SET deleted_at = now(), is_default = false WHERE id = $1', [addressId]);
    if (a.is_default) {
      // Chuyển mặc định sang địa chỉ mới nhất còn lại.
      await client.query(
        `UPDATE addresses SET is_default = true
         WHERE id = (SELECT id FROM addresses WHERE account_id = $1 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1)`,
        [accountId],
      );
    }
    return { id: String(addressId), deleted: true };
  });
}

module.exports = { toView, list, create, update, setDefault, remove };
