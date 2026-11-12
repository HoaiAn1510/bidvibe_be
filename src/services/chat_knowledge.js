// Kiến thức và bộ hiểu câu hỏi của chatbot (thuần JS, không gọi mô hình AI, không phụ thuộc DB).
// Cách hoạt động: chuẩn hoá tiếng Việt (bỏ dấu) -> chấm điểm từ khoá theo chủ đề -> chọn chủ đề điểm cao nhất.
// Muốn dạy bot thêm điều mới: thêm một mục vào TOPICS (không cần sửa logic).
// Nội dung bám theo quy tắc trong code (auction_engine.js, fulfilment_service.js).

// "Đặt cọc" -> "dat coc". Gõ không dấu hay có dấu đều khớp như nhau.
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// label: tên chủ đề dùng khi gợi ý. keywords: đã bỏ dấu; cụm càng dài càng đặc trưng nên điểm càng cao.
// answer: câu trả lời chính. more: bổ sung, dùng khi người dùng hỏi nối tiếp ("còn gì nữa?", "vậy bao lâu?").
const TOPICS = {
  deposit: {
    label: 'đặt cọc',
    keywords: ['coc', 'dat coc', 'tien coc', 'hoan coc', 'mat coc', 'tru coc', 'deposit', 'coc bao nhieu'],
    answer: 'Để tham gia một phiên, bạn đặt cọc 10% giá khởi điểm (làm tròn nghìn) từ ví. Thua phiên thì cọc được hoàn ngay khi phiên kết thúc; thắng thì cọc được trừ vào số tiền thanh toán.',
    more: 'Bạn chỉ cọc một lần cho mỗi phiên. Nếu thắng mà quá hạn chưa thanh toán thì cọc bị tịch thu. Nếu phiên bị huỷ hoặc chấm dứt, cọc của mọi người được hoàn.',
  },
  bidding: {
    label: 'đặt giá',
    keywords: ['dat gia', 'tra gia', 'buoc gia', 'vuot gia', 'bid', 'tham gia dau gia', 'cach dau gia', 'dau gia nhu the nao', 'gia toi thieu', 'tu vuot gia', 'dat bao nhieu'],
    answer: 'Giá đặt phải từ giá hiện tại cộng bước giá trở lên, và bạn không thể tự vượt giá của chính mình. Nếu đặt giá trong 30 giây cuối, phiên được gia hạn còn đúng 30 giây.',
    more: 'Trước khi đặt giá lần đầu ở một phiên, bạn cần đủ số dư trong ví để đặt cọc. Mỗi lượt đặt giá hợp lệ đều được ghi lại và hiển thị theo thời gian thực.',
  },
  snipe: {
    label: 'gia hạn phút chót',
    keywords: ['gia han', 'phut chot', 'phut cuoi', '30 giay', 'chong chot', 'cuoi phien', 'sap het gio', 'het gio'],
    answer: 'Nếu có người đặt giá trong 30 giây cuối, phiên được gia hạn còn đúng 30 giây để mọi người kịp phản ứng. Cứ có lượt giá mới trong 30 giây cuối là lại gia hạn tiếp, cho đến khi không ai đặt thêm.',
    more: 'Đây là cơ chế chống "chốt phút chót": không ai thắng chỉ nhờ đặt giá ở giây cuối cùng mà người khác không kịp đáp lại.',
  },
  winner: {
    label: 'ai là người thắng',
    keywords: ['nguoi thang', 'ai thang', 'thang phien', 'chi mot nguoi', 'mot nguoi dau gia', 'co thang khong', 'duoc thang', 'xac dinh nguoi thang', 'ket thuc phien', 'phien ket thuc', 'winner', 'khi nao thang'],
    answer: 'Khi phiên hết giờ, người có lượt đặt giá cao nhất là người thắng, kể cả khi chỉ có một người tham gia. Phiên không có lượt đặt giá nào thì kết thúc không có người thắng và cọc được hoàn cho mọi người.',
    more: 'Người thắng nhận thông báo và một đơn hàng với hạn thanh toán 24 giờ. Người không thắng được hoàn cọc ngay.',
  },
  lost: {
    label: 'bị vượt giá hoặc không thắng',
    keywords: ['bi vuot', 'bi vuot gia', 'outbid', 'nguoi khac dat cao hon', 'dat cao hon', 'khong thang', 'thua phien', 'thua dau gia'],
    answer: 'Khi có người đặt giá cao hơn, bạn nhận thông báo và có thể đặt giá lại nếu phiên còn mở. Nếu phiên kết thúc mà bạn không thắng, cọc được hoàn ngay vào ví.',
    more: 'Bạn có thể theo dõi giá thay đổi trực tiếp trong màn hình chi tiết phiên.',
  },
  payment: {
    label: 'thanh toán',
    keywords: ['thanh toan', 'han tra', 'qua han', 'tra tien', 'phi dich vu', 'phi van chuyen', '24 gio', 'phi ship', 'moi mua', 'nguoi tra gia cao thu hai', 'phai tra bao nhieu', 'tong tien'],
    answer: 'Thắng phiên, bạn có 24 giờ để thanh toán (giá chốt + phí dịch vụ 5% + phí vận chuyển 40.000đ, đã trừ cọc). Quá hạn chưa thanh toán thì mất cọc. Nếu tính năng mời người trả giá cao thứ hai được bật và có người hợp lệ, họ sẽ được mời mua; nếu không, giao dịch bị huỷ.',
    more: 'Bạn thanh toán trong mục Đơn hàng, tiền trừ từ số dư ví. Hãy nạp đủ tiền trước hạn để không mất cọc.',
  },
  shipping: {
    label: 'giao hàng',
    keywords: ['giao hang', 'kho', 'van chuyen', 'ma van don', 'theo doi don', 'don hang', 'bao lau co hang', 'khi nao co hang'],
    answer: 'Sau khi bạn thanh toán, người bán gửi hàng về kho BidVibe. Kho nhận, kiểm đối chiếu mô tả, đóng gói rồi gửi cho bạn. Bạn theo dõi tiến trình trong mục Đơn hàng.',
    more: 'Mã vận đơn sẽ hiển thị trong chi tiết đơn khi kho gửi hàng đi.',
  },
  payout: {
    label: 'nhận hàng và giải ngân',
    keywords: ['giai ngan', 'nhan tien', 'xac nhan', 'da nhan hang', 'nhan hang', '72 gio', 'tu dong giai ngan', 'tien nguoi ban'],
    answer: 'Khi nhận được hàng, bạn bấm "Đã nhận hàng" để giải ngân cho người bán. Nếu không phản hồi trong 72 giờ sau khi giao, hệ thống tự giải ngân.',
    more: 'Nếu hàng có vấn đề, hãy mở tranh chấp trước khi đơn được giải ngân, vì sau đó tiền đã chuyển cho người bán.',
  },
  dispute: {
    label: 'tranh chấp và hoàn tiền',
    keywords: ['tranh chap', 'khieu nai', 'hoan tien', 'khong dung mo ta', 'hang loi', 'hang hong', 'hang gia', 'tra hang', 'lua dao', 'bi lua'],
    answer: 'Nếu hàng có vấn đề, hãy mở tranh chấp trước khi đơn được giải ngân. Khoản tiền được giữ lại, Admin xem xét rồi quyết định hoàn tiền cho bạn hoặc giữ nguyên giao dịch.',
    more: 'Khi mở tranh chấp, hãy mô tả rõ vấn đề và đính kèm ảnh để Admin xem xét nhanh hơn.',
  },
  wallet: {
    label: 'ví và nạp tiền',
    keywords: ['vi', 'nap tien', 'so du', 'vietqr', 'the noi dia', 'tien trong vi', 'vi tien', 'rut tien'],
    answer: 'Bạn nạp tiền vào ví bằng VietQR hoặc thẻ nội địa. Số dư khả dụng dùng để đặt cọc và thanh toán; tiền cọc đang giữ hiển thị riêng.',
    more: 'Tiền cọc đang giữ sẽ trở lại số dư khả dụng khi phiên kết thúc mà bạn không thắng.',
  },
  selling: {
    label: 'đăng tin và bán hàng',
    keywords: ['dang tin', 'ban hang', 'ky gui', 'tham dinh', 'nguoi ban', 'dang ban', 'muon ban', 'tao tin'],
    answer: 'Người bán tạo tin đăng, thêm ảnh rồi gửi thẩm định. Thẩm định viên có thể duyệt, từ chối hoặc yêu cầu bổ sung; duyệt xong phiên đấu giá mở ngay.',
    more: 'Tin cần ít nhất một ảnh trước khi gửi thẩm định. Bạn có thể dùng gợi ý giá khởi điểm khi tạo tin.',
  },
  paused: {
    label: 'phiên bị tạm dừng hoặc huỷ',
    keywords: ['tam dung', 'bi huy', 'huy phien', 'phien bi dung', 'bi dung', 'chap dut', 'dang bi kiem tra'],
    answer: 'Admin có thể tạm dừng một phiên để kiểm tra (ví dụ nghi ngờ gian lận); trong lúc tạm dừng phiên chưa được chốt. Nếu phiên bị huỷ hoặc chấm dứt, cọc của mọi người tham gia được hoàn.',
    more: 'Bạn sẽ nhận thông báo khi trạng thái phiên thay đổi.',
  },
};

// Câu xã giao: chỉ dùng khi không có chủ đề nào khớp.
const SMALLTALK = [
  { re: /^(xin chao|chao|hello|hi|hey|alo|chao ban|chao bot)( .*)?$/, text: ['Chào bạn! Mình là trợ lý BidVibe, mình giúp được các câu hỏi về đấu giá. Bạn cần hỏi gì?', 'Xin chào! Bạn muốn hỏi gì về đấu giá, đặt cọc hay thanh toán?'] },
  { re: /(cam on|thanks|thank you|tks)/, text: ['Không có gì! Cần gì thêm bạn cứ hỏi nhé.', 'Rất vui được giúp bạn. Còn gì thắc mắc cứ nhắn mình.'] },
  { re: /^(tam biet|bye|goodbye|hen gap lai)( .*)?$/, text: ['Tạm biệt bạn, chúc bạn đấu giá thành công!'] },
  { re: /(ban la ai|ban la gi|ten ban|ban la bot|ai vay)/, text: ['Mình là trợ lý BidVibe, trả lời các câu hỏi về đấu giá, đặt cọc, thanh toán, giao hàng và tranh chấp. Mình có thể xem giúp số dư ví, đơn hàng và tiền cọc của bạn nữa.'] },
];

const FALLBACK_HINT = 'Mình chưa hiểu rõ ý bạn. Bạn thử hỏi về: đặt cọc, đặt giá, người thắng phiên, thanh toán, giao hàng, giải ngân, tranh chấp, ví hay đăng tin. Hoặc hỏi "số dư của tôi", "đơn của tôi", "cọc của tôi" để mình xem dữ liệu của bạn nhé.';

// Điểm của từng chủ đề: mỗi từ khoá khớp nguyên từ cộng số từ của cụm (cụm dài đặc trưng hơn).
function scoreTopics(text) {
  const padded = ` ${normalize(text)} `;
  const scores = [];
  for (const [id, topic] of Object.entries(TOPICS)) {
    let score = 0;
    for (const kw of topic.keywords) {
      if (!padded.includes(` ${kw} `)) continue;
      // "vi" đứng một mình trùng "vì" (bởi vì): chỉ tính khi người dùng gõ đúng "ví" có dấu.
      if (kw === 'vi' && !/(^|\s)ví([\s?!.,]|$)/u.test(String(text).toLowerCase())) continue;
      score += kw.split(' ').length;
    }
    if (score > 0) scores.push({ id, score });
  }
  return scores.sort((a, b) => b.score - a.score);
}

const pick = (arr, seed) => arr[Math.abs(seed) % arr.length];
const hashOf = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

// Trả lời một câu hỏi. previousTopic: chủ đề của câu hỏi trước trong phiên chat (nếu có), để hiểu câu nối tiếp.
// Trả về { text, topic } — topic dùng cho lượt hỏi sau.
function answer(text, { previousTopic = null } = {}) {
  const norm = normalize(text);
  const scores = scoreTopics(text);
  const words = norm ? norm.split(' ').length : 0;
  const seed = hashOf(norm);

  if (scores.length) {
    const [top, second] = scores;
    let reply = TOPICS[top.id].answer;
    // Hai chủ đề sát điểm: trả lời chủ đề đầu và nhắc chủ đề kia thay vì đoán sai hẳn.
    if (second && second.score >= top.score * 0.75 && second.score >= 1) {
      reply += `\n\nNếu bạn đang hỏi về ${TOPICS[second.id].label}, bạn cứ nói rõ hơn nhé.`;
    }
    return { text: reply, topic: top.id };
  }

  const small = SMALLTALK.find((s) => s.re.test(norm));
  if (small) return { text: pick(small.text, seed), topic: previousTopic };

  // Câu ngắn không có từ khoá ("vậy còn bao lâu?", "còn gì nữa?") -> bổ sung cho chủ đề trước đó.
  if (previousTopic && TOPICS[previousTopic] && words <= 8) {
    return { text: TOPICS[previousTopic].more, topic: previousTopic };
  }
  return { text: FALLBACK_HINT, topic: previousTopic };
}

module.exports = { normalize, scoreTopics, answer, TOPICS };
