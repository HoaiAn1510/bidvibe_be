// Gợi ý giá khởi điểm (BE2). KHÔNG gọi mô hình AI/API ngoài: thống kê trên lịch sử phiên đã kết thúc
// (auction.model.listEndedHistory của BE1), nếu không đủ dữ liệu thì dùng khung giá soạn sẵn.
// Cải thiện so với bản đầu (hợp đồng API giữ nguyên, xem docs/api.md):
//   - bỏ giá chốt ngoại lệ (IQR) để một phiên bất thường không kéo lệch kết quả;
//   - nếu client gửi `title`, ưu tiên các phiên có tên món hàng tương tự (cùng từ đặc trưng);
//   - hệ số tình trạng áp dụng cho CẢ khoảng giá chốt dự kiến (trước đây chỉ áp cho giá khởi điểm);
//   - giải thích có thêm tỉ lệ giá chốt / giá khởi điểm thường gặp.
const { pool } = require('../config/db');
const { listEndedHistory } = require('../models/auction.model');
const validate = require('../utils/validate');
const { normalize } = require('./chat_knowledge');

const MIN_SAMPLES = 3;
const MIN_FOR_OUTLIER_FILTER = 5;
const roundThousand = (n) => Math.round(n / 1000) * 1000;

// Khung giá soạn sẵn (VND) khi chưa có lịch sử.
const DEFAULT_RANGE = {
  shoes: [800_000, 3_000_000],
  elec: [1_000_000, 6_000_000],
  antique: [1_500_000, 8_000_000],
};

// Hệ số theo tình trạng, so khớp không phân biệt hoa thường; luật đầu tiên khớp được dùng.
const CONDITION_FACTORS = [
  [/chưa qua sử dụng|mới 100|nguyên seal|như mới/i, 1.1],
  [/hư|hỏng|lỗi|trầy nhiều|cần sửa/i, 0.8],
  [/cũ|trầy|xước|sờn|ngả màu|sứt|mẻ/i, 0.9],
];

// Từ chung chung trong tên món hàng, không dùng để so khớp "món hàng tương tự".
const GENERIC_WORDS = new Set([
  'cua', 'voi', 'kem', 'con', 'hop', 'cao', 'thap', 'nien', 'doi', 'thap', 'ban', 'gioi', 'han', 'nguyen', 'goc',
  'size', 'mau', 'loai', 'dep', 'xin', 'chinh', 'hang', 'bao', 'tot', 'dau', 'cuoi', 'thu', 'het', 'nhat', 'ban',
  'chiec', 'cai', 'bo', 'doi', 'xua', 'retro', 'vintage', 'co', 'moi', 'cu', 'nguyen',
]);

function percentile(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const sortedAsc = (arr) => [...arr].sort((a, b) => a - b);

// Từ đặc trưng của tên món hàng: đã bỏ dấu, từ 3 ký tự trở lên, không có chữ số, không phải từ chung chung.
function titleTokens(title) {
  return new Set(
    normalize(title).split(' ').filter((w) => w.length >= 3 && !/\d/.test(w) && !GENERIC_WORDS.has(w)),
  );
}

// Bỏ phiên có giá chốt nằm ngoài [Q1 - 1,5·IQR, Q3 + 1,5·IQR]. Cần đủ mẫu; nếu lọc xong còn quá ít thì giữ nguyên.
function withoutOutliers(history) {
  if (history.length < MIN_FOR_OUTLIER_FILTER) return history;
  const finals = sortedAsc(history.map((h) => h.finalPrice));
  const q1 = percentile(finals, 0.25);
  const q3 = percentile(finals, 0.75);
  const iqr = q3 - q1;
  const kept = history.filter((h) => h.finalPrice >= q1 - 1.5 * iqr && h.finalPrice <= q3 + 1.5 * iqr);
  return kept.length >= MIN_SAMPLES ? kept : history;
}

// Các phiên có tên tương tự (chung ít nhất một từ đặc trưng). Trả null nếu không có title hoặc không đủ mẫu.
function similarByTitle(history, title) {
  if (!title) return null;
  const want = titleTokens(title);
  if (!want.size) return null;
  const similar = history.filter((h) => [...titleTokens(h.title)].some((t) => want.has(t)));
  return similar.length >= MIN_SAMPLES ? similar : null;
}

// Phần thuần (không DB) để dễ test. Trả đúng dạng dữ liệu của API.
function estimate({ categoryCode, history = [], factor = 1, title = null }) {
  const similar = similarByTitle(history, title);
  const pool_ = withoutOutliers(similar || history);

  if (pool_.length >= MIN_SAMPLES) {
    const starts = sortedAsc(pool_.map((h) => h.startingPrice));
    const finals = sortedAsc(pool_.map((h) => h.finalPrice));
    const ratios = sortedAsc(pool_.filter((h) => h.startingPrice > 0).map((h) => h.finalPrice / h.startingPrice));
    const suggested = roundThousand(percentile(starts, 0.5) * factor);
    const ratioText = ratios.length >= MIN_SAMPLES
      ? ` Giá chốt thường gấp khoảng ${percentile(ratios, 0.5).toFixed(1).replace('.', ',')} lần giá khởi điểm.`
      : '';
    return {
      suggestedStartingPrice: suggested,
      expectedFinalRange: [roundThousand(percentile(finals, 0.25) * factor), roundThousand(percentile(finals, 0.75) * factor)],
      basis: 'history',
      sampleSize: pool_.length,
      explanation: `Dựa trên ${pool_.length} phiên ${similar ? 'có tên món hàng tương tự' : 'cùng danh mục'} đã kết thúc: giá khởi điểm phổ biến khoảng ${suggested.toLocaleString('vi-VN')}đ`
        + `${factor !== 1 ? ' (đã điều chỉnh theo tình trạng món hàng)' : ''}.${ratioText} Đây là gợi ý tham khảo, chưa dùng mô hình AI.`,
    };
  }

  const [lo, hi] = DEFAULT_RANGE[categoryCode] || [500_000, 3_000_000];
  const suggested = roundThousand(((lo + hi) / 2) * factor);
  return {
    suggestedStartingPrice: suggested,
    expectedFinalRange: [roundThousand(lo * factor), roundThousand(hi * factor)],
    basis: 'default',
    sampleSize: history.length,
    explanation: 'Chưa đủ lịch sử phiên cùng danh mục, đây là khung giá tham khảo soạn sẵn. Đây là gợi ý tham khảo, chưa dùng mô hình AI.',
  };
}

const conditionFactor = (condition) => (CONDITION_FACTORS.find(([re]) => condition && re.test(condition)) || [null, 1])[1];

async function suggestPrice(input = {}) {
  const categoryCode = validate.text(input.categoryCode, 'Danh mục', { max: 50 });
  const known = await pool.query('SELECT 1 FROM categories WHERE code = $1', [categoryCode]);
  if (!known.rowCount) throw validate.invalid(`Danh mục "${categoryCode}" không tồn tại`);
  const condition = validate.text(input.condition, 'Tình trạng', { max: 100, required: false });
  const title = validate.text(input.title, 'Tên món hàng', { max: 200, required: false });

  const history = await listEndedHistory({ categoryCode, limit: 100 });
  return estimate({ categoryCode, history, factor: conditionFactor(condition), title });
}

module.exports = { suggestPrice, estimate };
