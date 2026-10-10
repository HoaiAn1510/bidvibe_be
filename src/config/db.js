const { Pool } = require('pg');
const env = require('./env');

// Connection pool dùng chung cho toàn bộ app — không mở kết nối mới cho mỗi query.
const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.dbSsl ? { rejectUnauthorized: false } : false,
  // Mặc định pg chờ kết nối vô hạn: mạng rớt thì request treo mãi. 20 giây đủ rộng cho mạng chập chờn.
  connectionTimeoutMillis: 20_000,
});

// Client đang rảnh trong pool bị rớt (ECONNRESET, lỗi TLS, Supabase đóng kết nối) thì pg phát 'error'
// trên pool; không có listener thì tiến trình bị sập. pg tự loại client hỏng, request sau mở kết nối mới.
pool.on('error', (err) => {
  console.error(`[db] kết nối rảnh bị lỗi, đã loại khỏi pool: ${err.code || ''} ${err.message}`.trim());
});

module.exports = { pool };
