const express = require('express');
const { requireAuth } = require('../middleware/auth');
const authService = require('../services/auth_service');

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

router.use('/auctions', require('./auction.routes'));
router.use('/bids', require('./bid.routes'));
router.use('/wallet', require('./wallet.routes'));
router.use('/orders', require('./order.routes'));

module.exports = router;
