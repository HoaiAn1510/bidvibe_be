// Chatbot hỗ trợ (BE2). KHÔNG gọi mô hình AI/API ngoài: hiểu câu hỏi bằng chấm điểm từ khoá đã bỏ dấu
// (chat_knowledge.js), nhớ chủ đề của câu hỏi trước trong phiên chat, và với các câu hỏi về dữ liệu của
// chính người dùng (ví, đơn, cọc, phiên đang tham gia) thì truy vấn DB rồi điền số liệu vào câu trả lời.
// Lưu cả câu hỏi và câu trả lời vào chat_sessions / chat_messages.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const validate = require('../utils/validate');
const knowledge = require('./chat_knowledge');

const fmt = (n) => `${Number(n).toLocaleString('vi-VN')}đ`;
const VN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', hourCycle: 'h23',
});
const fmtVn = (t) => {
  const p = Object.fromEntries(VN_TIME.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ngày ${p.day}/${p.month}`;
};
function timeLeft(t) {
  const s = Math.floor((new Date(t).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'đã hết giờ';
  if (s < 3600) return `còn ${Math.max(1, Math.floor(s / 60))} phút`;
  if (s < 86400) return `còn khoảng ${Math.floor(s / 3600)} giờ`;
  return `còn khoảng ${Math.floor(s / 86400)} ngày`;
}

// Nhận diện câu hỏi về dữ liệu CỦA CHÍNH NGƯỜI DÙNG (trên chuỗi đã bỏ dấu).
const PERSONAL = ' (cua toi|cua minh|cua em|cua tui|toi dang|minh dang|em dang|tui dang) ';
function liveIntent(text) {
  const n = ` ${knowledge.normalize(text)} `;
  const mine = new RegExp(PERSONAL).test(n);
  if (/ (so du|con bao nhieu tien|tien trong vi) /.test(n) || (/ vi /.test(n) && mine)) return 'wallet';
  if (/ coc /.test(n) && (mine || / dang giu | dang bi giu /.test(n))) return 'deposit';
  if (/ (dan dau|dang thang|co ai vuot|co bi vuot|dang tham gia|dang dat gia) /.test(n)) return 'leading';
  if (/ (don|don hang|han thanh toan|thanh toan) /.test(n) && (mine || / toi (phai|can|con) /.test(n))) return 'orders';
  return null;
}

const LIVE = {
  async wallet(executor, user) {
    const { rows } = await executor.query('SELECT wallet_balance, wallet_held FROM bidders WHERE account_id = $1', [user.id]);
    if (!rows[0]) return null;
    const { wallet_balance: bal, wallet_held: held } = rows[0];
    return `Số dư khả dụng trong ví của bạn là ${fmt(bal)}${Number(held) > 0 ? `, ngoài ra ${fmt(held)} đang được giữ làm tiền cọc` : ''}.`;
  },
  async deposit(executor, user) {
    const { rows } = await executor.query(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total FROM auction_deposits WHERE bidder_id = $1 AND status = 'held'`,
      [user.id],
    );
    if (!rows[0].n) return 'Hiện bạn không có khoản cọc nào đang được giữ.';
    return `Bạn đang có ${rows[0].n} khoản cọc được giữ, tổng ${fmt(rows[0].total)}. Cọc sẽ được hoàn khi phiên kết thúc mà bạn không thắng, hoặc trừ vào thanh toán nếu bạn thắng.`;
  },
  async leading(executor, user) {
    const { rows } = await executor.query(
      `SELECT l.title, a.current_price, a.ends_at,
              (SELECT b.bidder_id FROM bids b WHERE b.auction_id = a.id ORDER BY b.created_at DESC, b.id DESC LIMIT 1) AS top_bidder
       FROM auctions a JOIN listings l ON l.id = a.listing_id
       WHERE a.status = 'active'
         AND EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = $1)
       ORDER BY a.ends_at LIMIT 5`,
      [user.id],
    );
    if (!rows.length) return 'Hiện bạn chưa đặt giá ở phiên nào đang diễn ra.';
    const lines = rows.map((r) => `• ${r.title}: giá hiện tại ${fmt(r.current_price)}, ${timeLeft(r.ends_at)} — ${String(r.top_bidder) === String(user.id) ? 'bạn đang dẫn đầu' : 'bạn đã bị vượt giá'}`);
    return `Các phiên đang diễn ra mà bạn tham gia:\n${lines.join('\n')}`;
  },
  async orders(executor, user) {
    const { rows } = await executor.query(
      `SELECT o.final_price, o.payment_status, o.payment_deadline, l.title
       FROM orders o JOIN auctions a ON a.id = o.auction_id JOIN listings l ON l.id = a.listing_id
       WHERE o.bidder_id = $1 ORDER BY o.created_at DESC LIMIT 5`,
      [user.id],
    );
    if (!rows.length) return 'Bạn chưa có đơn hàng nào.';
    const status = { awaiting_payment: 'chờ thanh toán', paid: 'đã thanh toán', expired: 'đã quá hạn' };
    const due = rows.filter((r) => r.payment_status === 'awaiting_payment');
    const lines = rows.map((r) => `• ${r.title}: ${fmt(r.final_price)} — ${status[r.payment_status] || r.payment_status}${r.payment_status === 'awaiting_payment' ? `, hạn trước ${fmtVn(r.payment_deadline)}` : ''}`);
    return `${due.length ? `Bạn có ${due.length} đơn cần thanh toán (cộng phí dịch vụ 5% + vận chuyển 40.000đ, đã trừ cọc).` : 'Bạn không có đơn nào đang chờ thanh toán.'}\n${lines.join('\n')}`;
  },
};

// Chủ đề của câu hỏi gần nhất có nội dung rõ ràng trong phiên chat, để hiểu câu nối tiếp.
async function previousTopic(executor, sessionId) {
  const { rows } = await executor.query(
    `SELECT content FROM chat_messages WHERE session_id = $1 AND sender = 'user' ORDER BY created_at DESC, id DESC LIMIT 5`,
    [sessionId],
  );
  for (const r of rows) {
    const [top] = knowledge.scoreTopics(r.content);
    if (top) return top.id;
  }
  return null;
}

async function answerFor(executor, user, sessionId, text) {
  const intent = liveIntent(text);
  if (intent) {
    const live = await LIVE[intent](executor, user);
    if (live) return live;
  }
  const prev = sessionId ? await previousTopic(executor, sessionId) : null;
  return knowledge.answer(text, { previousTopic: prev }).text;
}

function assertAccountUser(user) {
  if (user.kind !== 'account') throw new AppError('Tài khoản nội bộ không dùng chatbot', 403, 'FORBIDDEN');
}

async function ownSession(executor, user, sessionId) {
  const { rows } = await executor.query('SELECT id, account_id FROM chat_sessions WHERE id = $1', [sessionId]);
  if (!rows[0] || String(rows[0].account_id) !== String(user.id)) {
    throw new AppError('Không tìm thấy phiên trò chuyện', 404, 'NOT_FOUND');
  }
  return rows[0].id;
}

const msgView = (r) => ({ id: r.id, sender: r.sender, content: r.content, createdAt: r.created_at });

async function sendMessage(user, input = {}) {
  assertAccountUser(user);
  const content = validate.text(input.content, 'Nội dung', { max: 2000 });
  const sessionId = input.sessionId == null ? null : validate.int(input.sessionId, 'sessionId', { min: 1 });

  return inTransaction(async (client) => {
    const id = sessionId
      ? await ownSession(client, user, sessionId)
      : (await client.query('INSERT INTO chat_sessions (account_id) VALUES ($1) RETURNING id', [user.id])).rows[0].id;
    const ins = (sender, text) => client.query(
      `INSERT INTO chat_messages (session_id, sender, content) VALUES ($1, $2, $3)
       RETURNING id, sender, content, created_at`,
      [id, sender, text],
    );
    // Tính câu trả lời TRƯỚC khi lưu câu hỏi hiện tại để previousTopic chỉ nhìn các câu hỏi trước đó.
    const reply = await answerFor(client, user, id, content);
    const mine = await ins('user', content);
    const bot = await ins('bot', reply);
    return { sessionId: id, messages: [msgView(mine.rows[0]), msgView(bot.rows[0])] };
  });
}

async function history(user, sessionId) {
  assertAccountUser(user);
  await ownSession(pool, user, sessionId);
  const { rows } = await pool.query(
    'SELECT id, sender, content, created_at FROM chat_messages WHERE session_id = $1 ORDER BY created_at, id',
    [sessionId],
  );
  return { sessionId, messages: rows.map(msgView) };
}

module.exports = { sendMessage, history };
