// Tạo thông báo: ghi bảng notifications và đẩy qua Socket.io nếu người nhận đang online.
// Phần này thuộc BE2; đây là bản tối thiểu để BE1 gọi được (outbid, win, refund...).
// BE2 có thể thay thân hàm, giữ nguyên chữ ký createNotification.
const { pool } = require('../config/db');
const registerSockets = require('../sockets');

// `executor` là client đang trong giao dịch hoặc pool. Sự kiện socket chỉ nên
// đẩy sau khi giao dịch COMMIT: dùng emitNotification với kết quả trả về.
async function createNotification(executor, { accountId, type, title }) {
  const { rows } = await (executor || pool).query(
    `INSERT INTO notifications (account_id, type, title)
     VALUES ($1, $2, $3)
     RETURNING id, type, title, is_read, created_at`,
    [accountId, type, title],
  );
  return { accountId, ...rows[0] };
}

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

module.exports = { createNotification, emitNotification };
