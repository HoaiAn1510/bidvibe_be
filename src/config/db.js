const { Pool } = require('pg');
const env = require('./env');

// Connection pool dùng chung cho toàn bộ app — không mở kết nối mới cho mỗi query.
const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.dbSsl ? { rejectUnauthorized: false } : false,
});

module.exports = { pool };
