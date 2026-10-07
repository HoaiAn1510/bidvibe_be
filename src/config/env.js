require('dotenv').config();

if (!process.env.JWT_SECRET) {
  throw new Error('Thiếu biến môi trường JWT_SECRET — xem .env.example để biết cách tạo.');
}

module.exports = {
  port: Number(process.env.PORT) || 3000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL === 'true',
  jwtSecret: process.env.JWT_SECRET,
};
