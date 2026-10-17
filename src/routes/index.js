const express = require('express');
const { requireAuth } = require('../middleware/auth');
const authService = require('../services/auth_service');
const listingService = require('../services/listing_service');
const { pool } = require('../config/db');
const env = require('../config/env');

const router = express.Router();

// Kiểm tra sống: db = 'ok' khi SELECT 1 trả lời trong 3 giây, ngược lại 'error' và mã 503.
router.get('/health', async (req, res) => {
  let timer;
  const db = await Promise.race([
    pool.query('SELECT 1').then(() => 'ok', () => 'error'),
    new Promise((resolve) => { timer = setTimeout(() => resolve('error'), 3000); }),
  ]);
  clearTimeout(timer);
  const data = { status: db === 'ok' ? 'ok' : 'degraded', db, uptime: process.uptime() };
  if (db === 'ok') return res.json({ success: true, data, error: null });
  return res.status(503).json({
    success: false, data, error: { code: 'DB_UNAVAILABLE', message: 'Không kết nối được database' },
  });
});

router.use('/auth', require('./auth.routes'));

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const me = await authService.getMe(req.user);
    res.json({ success: true, data: me, error: null });
  } catch (err) {
    next(err);
  }
});

// BE2 thêm: sửa hồ sơ, đổi mật khẩu (không đổi hành vi GET /me ở trên, ngoài storeName của Seller).
router.patch('/me', requireAuth, async (req, res) => {
  res.json({ success: true, data: await authService.updateMe(req.user, req.body || {}), error: null });
});

router.post('/me/password', requireAuth, async (req, res) => {
  res.json({ success: true, data: await authService.changePassword(req.user, req.body || {}), error: null });
});

router.use('/notifications', require('./notification.routes'));
router.use('/uploads', require('./upload.routes'));

// ---- BE2: Marketplace Operations ----
router.get('/categories', requireAuth, async (req, res) => {
  res.json({ success: true, data: { categories: await listingService.listCategories() }, error: null });
});
router.use('/listings', require('./listing.routes'));
router.use('/appraisals', require('./appraisal.routes'));
router.use('/ai', require('./ai.routes'));
router.use('/addresses', require('./address.routes'));
router.use('/warehouse', require('./warehouse.routes'));
router.use('/disputes', require('./dispute.routes'));
router.use('/admin', require('./admin.routes'));
router.use('/chat', require('./chat.routes'));
// Phải đứng TRƯỚC /orders của BE1 (xem chú thích trong fulfilment.routes.js).
router.use('/orders', require('./fulfilment.routes'));

// ---- BE1: Auction Core ----

router.use('/auctions', require('./auction.routes'));
router.use('/bids', require('./bid.routes'));
router.use('/wallet', require('./wallet.routes'));
router.use('/orders', require('./order.routes'));

// Công cụ cho FE test nhanh (chỉ khi DEV_TOOLS=true và không phải production). Tắt thì không đăng ký:
// đường dẫn /api/dev/* rơi xuống notFound như route không tồn tại.
if (env.devToolsEnabled) router.use('/dev', require('./dev.routes'));

module.exports = router;
