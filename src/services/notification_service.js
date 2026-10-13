// Thông báo (BE2): ghi bảng notifications và đẩy qua Socket.io tới phòng `user:<accountId>`.
// Chỉ tài khoản Bidder/Seller (`accounts`) có thông báo; tài khoản nội bộ (ops) thì không.
//
// Quy tắc đẩy real-time: chỉ đẩy SAU khi giao dịch đã COMMIT, để client không nhận
// thông báo cho dữ liệu có thể bị ROLLBACK.
//   - notify(client, ...) trong giao dịch -> trả về thông báo, nơi gọi emitNotification() sau COMMIT.
//   - notify(pool hoặc null, ...) ngoài giao dịch -> tự đẩy ngay.
// BE1 đang gọi createNotification / emitNotification: giữ nguyên chữ ký hai hàm này.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { broadcast } = require('../sockets/broadcast');

// `data` (tuỳ chọn, migration 008): id liên quan để app mở đúng màn, ví dụ { orderId, auctionId }.
// Giá trị đổi về chuỗi như id trong API; khoá rỗng bị bỏ; không có khoá nào thì lưu NULL.
// Không truyền `data` (cách BE1 đang gọi) thì vẫn chạy như cũ, data = NULL.
function normalizeData(data) {
  if (!data || typeof data !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && v !== undefined && v !== '') out[k] = String(v);
  }
  return Object.keys(out).length ? out : null;
}

async function createNotification(executor, { accountId, type, title, data }) {
  const { rows } = await (executor || pool).query(
    `INSERT INTO notifications (account_id, type, title, data)
     VALUES ($1, $2, $3, $4)
     RETURNING id, type, title, data, is_read, created_at`,
    [accountId, type, title, normalizeData(data)],
  );
  return { accountId: String(accountId), ...rows[0] };
}

// Phát tới phòng riêng của người nhận, ở tiến trình này và mọi backend khác cùng database
// (sockets/broadcast.js); không ai trong phòng (offline) thì không có gì xảy ra, thông báo vẫn
// nằm trong DB để lần sau GET /api/notifications.
function emitNotification(notification) {
  if (!notification) return;
  broadcast(`user:${notification.accountId}`, 'notification:new', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    createdAt: notification.created_at,
    data: notification.data ?? null,
  });
}

async function notify(client, accountId, type, title, data) {
  const notification = await createNotification(client, { accountId, type, title, data });
  if (!client || client === pool) emitNotification(notification);
  return notification;
}

function assertAccountUser(user) {
  if (user.kind !== 'account') {
    throw new AppError('Tài khoản nội bộ không có thông báo', 403, 'FORBIDDEN');
  }
}

async function listForAccount(user, { limit, offset }) {
  assertAccountUser(user);
  const [list, unread] = await Promise.all([
    pool.query(
      `SELECT id, type, title, data, is_read, created_at FROM notifications
       WHERE account_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [user.id, limit, offset],
    ),
    pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE account_id = $1 AND NOT is_read',
      [user.id],
    ),
  ]);
  return {
    notifications: list.rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      isRead: r.is_read,
      createdAt: r.created_at,
      data: r.data,
    })),
    unreadCount: unread.rows[0].n,
  };
}

async function markRead(user, notificationId) {
  assertAccountUser(user);
  const { rows } = await pool.query(
    `UPDATE notifications SET is_read = true
     WHERE id = $1 AND account_id = $2
     RETURNING id, is_read`,
    [notificationId, user.id],
  );
  if (!rows[0]) throw new AppError('Không tìm thấy thông báo', 404, 'NOT_FOUND');
  return { id: rows[0].id, isRead: rows[0].is_read };
}

// Đánh dấu mọi thông báo chưa đọc của tài khoản là đã đọc; trả số dòng đã đổi.
async function markAllRead(user) {
  assertAccountUser(user);
  const { rowCount } = await pool.query(
    'UPDATE notifications SET is_read = true WHERE account_id = $1 AND is_read = false',
    [user.id],
  );
  return { updated: rowCount };
}

module.exports = {
  createNotification, emitNotification, notify, listForAccount, markRead, markAllRead,
};
