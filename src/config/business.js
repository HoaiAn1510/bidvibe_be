// Cấu hình nghiệp vụ dùng chung: phí, hạn thanh toán / giải ngân, trần giá đặt.
// Trước đây mỗi service tự khai báo lại (auction_engine, fulfilment_service, admin_service, seed) nên dễ lệch nhau;
// mọi nơi cần các giá trị này phải import từ đây. Mặc định giữ đúng giá trị cũ, ghi đè bằng biến môi trường
// (xem .env.example). Giá trị sai thì dừng ngay lúc khởi động thay vì tính tiền sai âm thầm.
require('dotenv').config();

function read(name, fallback, { min = -Infinity, max = Infinity, integer = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const ok = Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
  if (!ok) {
    const kind = integer ? 'số nguyên' : 'số';
    throw new Error(`Biến môi trường ${name}="${raw}" không hợp lệ: cần ${kind} trong khoảng [${min}, ${max}].`);
  }
  return value;
}

const HOUR_MS = 3600_000;

const paymentWindowHours = read('PAYMENT_WINDOW_HOURS', 24, { min: 0.01, max: 24 * 30 });

module.exports = {
  // Phí dịch vụ tính trên giá chốt (làm tròn nghìn khi tính tiền) và phí ship cố định của mỗi đơn.
  feeRate: read('FEE_RATE', 0.05, { min: 0, max: 0.5 }),
  shippingFee: read('SHIPPING_FEE', 40_000, { min: 0, max: 10_000_000, integer: true }),
  // Hạn người thắng phải thanh toán; quá hạn thì mất cọc. Là số nguyên mili giây vì được ghép vào interval của SQL.
  paymentWindowHours,
  paymentWindowMs: Math.round(paymentWindowHours * HOUR_MS),
  // Sau khi kho giao hàng, hạn người mua xác nhận / khiếu nại trước khi tự giải ngân cho Seller.
  payoutWindowHours: read('PAYOUT_WINDOW_HOURS', 72, { min: 1, max: 24 * 30, integer: true }),
  // Trần giá đặt (chống đặt giá ảo rồi bỏ đơn): maxBid = MAX(giá hiện tại × hệ số, giá hiện tại + số bước × bước giá),
  // luôn ≤ bidAbsoluteCap.
  bidCeilingMultiplier: read('BID_CEILING_MULTIPLIER', 3, { min: 1.1, max: 100 }),
  bidCeilingSteps: read('BID_CEILING_STEPS', 20, { min: 1, max: 10_000, integer: true }),
  bidAbsoluteCap: 10_000_000_000,
};
