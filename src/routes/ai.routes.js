const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { suggestPrice } = require('../services/ai_price_suggestion');
const { ok } = require('./_http');

const router = express.Router();
router.use(requireAuth);

// { categoryCode, condition?, title? }
router.post('/suggest-price', requireRole('seller', 'appraiser'), async (req, res) => {
  ok(res, await suggestPrice(req.body || {}));
});

module.exports = router;
