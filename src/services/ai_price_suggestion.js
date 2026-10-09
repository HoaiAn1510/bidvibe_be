// Gợi ý giá khởi điểm (BE2). Theo quyết định mặc định: CHƯA gọi mô hình AI thật.
// Dùng lịch sử phiên đã kết thúc cùng danh mục (auction.model.listEndedHistory của BE1) nếu có
// đủ dữ liệu, nếu không thì dùng khung giá soạn sẵn. Giữ chữ ký hàm để sau này thay bằng mô hình.
const { pool } = require('../config/db');
const { listEndedHistory } = require('../models/auction.model');
const validate = require('../utils/validate');

const MIN_SAMPLES = 3;
const roundThousand = (n) => Math.round(n / 1000) * 1000;

// Khung giá soạn sẵn (VND) khi chưa có lịch sử.
const DEFAULT_RANGE = {
  shoes: [800_000, 3_000_000],
  elec: [1_000_000, 6_000_000],
  antique: [1_500_000, 8_000_000],
};

// Hệ số theo tình trạng, so khớp không phân biệt hoa thường.
const CONDITION_FACTORS = [
  [/chưa qua sử dụng|mới 100|nguyên seal|như mới/i, 1.1],
  [/hư|hỏng|lỗi|trầy nhiều|cần sửa/i, 0.8],
];

function percentile(sorted, p) {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

async function suggestPrice(input = {}) {
  const categoryCode = validate.text(input.categoryCode, 'Danh mục', { max: 50 });
  const known = await pool.query('SELECT 1 FROM categories WHERE code = $1', [categoryCode]);
  if (!known.rowCount) throw validate.invalid(`Danh mục "${categoryCode}" không tồn tại`);
  const condition = validate.text(input.condition, 'Tình trạng', { max: 100, required: false });

  const factor = (CONDITION_FACTORS.find(([re]) => condition && re.test(condition)) || [null, 1])[1];
  const history = await listEndedHistory({ categoryCode, limit: 50 });

  if (history.length >= MIN_SAMPLES) {
    const starts = history.map((h) => h.startingPrice).sort((a, b) => a - b);
    const finals = history.map((h) => h.finalPrice).sort((a, b) => a - b);
    const suggested = roundThousand(percentile(starts, 0.5) * factor);
    return {
      suggestedStartingPrice: suggested,
      expectedFinalRange: [roundThousand(percentile(finals, 0.25)), roundThousand(percentile(finals, 0.75))],
      basis: 'history',
      sampleSize: history.length,
      explanation: `Dựa trên ${history.length} phiên cùng danh mục đã kết thúc: giá khởi điểm phổ biến khoảng ${suggested.toLocaleString('vi-VN')}đ`
        + `${factor !== 1 ? ' (đã điều chỉnh theo tình trạng món hàng)' : ''}. Đây là gợi ý tham khảo, chưa dùng mô hình AI.`,
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

module.exports = { suggestPrice };
