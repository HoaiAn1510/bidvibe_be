const express = require('express');
const { requireAuth } = require('../middleware/auth');
const authService = require('../services/auth_service');
const listingService = require('../services/listing_service');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() }, error: null });
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

router.use('/notifications', require('./notification.routes'));

// ---- BE2: Marketplace Operations ----
router.get('/categories', requireAuth, async (req, res) => {
  res.json({ success: true, data: { categories: await listingService.listCategories() }, error: null });
});
router.use('/listings', require('./listing.routes'));
router.use('/appraisals', require('./appraisal.routes'));
router.use('/ai', require('./ai.routes'));
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

module.exports = router;
