const express = require('express');

const router = express.Router();

router.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() }, error: null });
});

// TODO: router.use('/auctions', require('./auctions'));

module.exports = router;
