require('dotenv').config();

if (!process.env.JWT_SECRET) {
  throw new Error('Thiếu biến môi trường JWT_SECRET — xem .env.example để biết cách tạo.');
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL === 'true',
  // Số kết nối tối đa của pool (mặc định 10 như pg). Supabase session pooler giới hạn tổng số
  // kết nối của cả database, nên test chạy song song đặt nhỏ hơn.
  dbPoolMax: Number(process.env.DB_POOL_MAX) || 10,
  jwtSecret: process.env.JWT_SECRET,
  // Supabase Storage cho POST /api/uploads/images. Thiếu URL hoặc key thì route trả 503
  // UPLOAD_NOT_CONFIGURED, server vẫn chạy. Key là secret key / service_role: chỉ dùng ở backend,
  // không trả cho app, không ghi log.
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',
  storageBucket: process.env.STORAGE_BUCKET || 'listing-photos',
  // Job tự giải ngân sau 72 giờ (mặc định bật). Đặt AUTO_PAYOUT_ENABLED=false để tắt.
  autoPayoutEnabled: process.env.AUTO_PAYOUT_ENABLED !== 'false',
};
