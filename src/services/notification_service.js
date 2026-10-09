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
const registerSockets = require('../sockets');

async function createNotification(executor, { accountId, type, title }) {
  const { rows } = await (executor || pool).query(
    `INSERT INTO notifications (account_id, type, title)
     VALUES ($1, $2, $3)
     RETURNING id, type, title, is_read, created_at`,
    [accountId, type, title],
  );
  return { accountId: String(accountId), ...rows[0] };
}

// Phát tới phòng riêng của người nhận; không ai trong phòng (offline) thì không có gì xảy ra,
// thông báo vẫn nằm trong DB để lần sau GET /api/notifications.
function emitNotification(notification) {
  const io = registerSockets.getIo();
  if (!io || !notification) return;
  io.to(`user:${notification.accountId}`).emit('notification:new', {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    createdAt: notification.created_at,
  });
}

async function notify(client, accountId, type, title) {
  const notification = await createNotification(client, { accountId, type, title });
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
      `SELECT id, type, title, is_read, created_at FROM notifications
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

module.exports = {
  createNotification, emitNotification, notify, listForAccount, markRead,
};
