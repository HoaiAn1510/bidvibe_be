// Chatbot hỗ trợ (BE2). Theo quyết định mặc định: trả lời soạn sẵn theo từ khoá, CHƯA gọi mô
// hình AI. Lưu cả câu hỏi và câu trả lời vào chat_sessions / chat_messages.
const { pool } = require('../config/db');
const { AppError } = require('../middleware/errorHandler');
const { inTransaction } = require('./auction_engine');
const validate = require('../utils/validate');

// Nội dung bám theo quy tắc trong code (auction_engine.js, fulfilment_service.js).
const ANSWERS = [
  [/cọc|đặt cọc/i, 'Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thua phiên thì cọc được hoàn ngay khi phiên kết thúc; thắng thì cọc được trừ vào số tiền thanh toán.'],
  [/đặt giá|trả giá|bước giá|vượt giá/i, 'Giá đặt phải từ giá hiện tại cộng bước giá trở lên, và bạn không thể tự vượt giá của chính mình. Nếu đặt giá trong 30 giây cuối, phiên được gia hạn còn đúng 30 giây.'],
  [/thanh toán|hạn trả|quá hạn/i, 'Thắng phiên, bạn có 24 giờ để thanh toán (giá chốt + phí dịch vụ 5% + phí vận chuyển 40.000đ, đã trừ cọc). Quá 24 giờ chưa thanh toán thì mất cọc và giao dịch bị huỷ.'],
  [/giao hàng|kho|vận chuyển|mã vận đơn/i, 'Sau khi bạn thanh toán, người bán gửi hàng về kho BidVibe. Kho nhận, kiểm đối chiếu mô tả, đóng gói rồi gửi cho bạn. Bạn theo dõi tiến trình trong mục Đơn hàng.'],
  [/giải ngân|nhận tiền|xác nhận/i, 'Khi nhận được hàng, bạn bấm "Đã nhận hàng" để giải ngân cho người bán. Nếu không phản hồi trong 72 giờ sau khi giao, hệ thống tự giải ngân.'],
  [/tranh chấp|khiếu nại|hoàn tiền|không đúng mô tả/i, 'Nếu hàng có vấn đề, hãy mở tranh chấp trước khi đơn được giải ngân. Khoản tiền được giữ lại, Admin xem xét rồi quyết định hoàn tiền cho bạn hoặc giữ nguyên giao dịch.'],
  [/ví|nạp tiền|số dư/i, 'Bạn nạp tiền vào ví bằng VietQR hoặc thẻ nội địa. Số dư khả dụng dùng để đặt cọc và thanh toán; tiền cọc đang giữ hiển thị riêng.'],
  [/đăng tin|bán|ký gửi|thẩm định/i, 'Người bán tạo tin đăng, thêm ảnh rồi gửi thẩm định. Thẩm định viên có thể duyệt, từ chối hoặc yêu cầu bổ sung; duyệt xong phiên đấu giá mở ngay.'],
];
const FALLBACK = 'Mình có thể giải đáp về: đặt cọc, đặt giá, thanh toán, giao hàng, giải ngân, tranh chấp, ví và đăng tin. Bạn hỏi cụ thể hơn nhé. (Trợ lý đang dùng câu trả lời soạn sẵn.)';

const answerFor = (text) => (ANSWERS.find(([re]) => re.test(text)) || [null, FALLBACK])[1];

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
    const mine = await ins('user', content);
    const bot = await ins('bot', answerFor(content));
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
