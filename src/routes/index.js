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

// TODO: router.use('/auctions', require('./auctions'));

module.exports = router;
