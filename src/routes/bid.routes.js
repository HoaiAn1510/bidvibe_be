const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../services/auction_engine');
const { AppError } = require('../middleware/errorHandler');
const { ok, idParam, intField } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder'));

// POST /api/bids  { auctionId, amount }   (hoặc { auctionId, increment } = giá hiện tại + increment)
router.post('/', async (req, res) => {
  const { auctionId, amount, increment } = req.body || {};
  const id = idParam(auctionId, 'auctionId');
  let value;
  if (amount != null) {
    value = intField(amount, 'amount');
  } else if (increment != null) {
    const auction = await engine.getAuction(id, req.user.id);
    value = auction.currentPrice + intField(increment, 'increment');
  } else {
    throw new AppError('Thiếu amount hoặc increment', 400, 'VALIDATION_ERROR');
  }
  ok(res, await engine.placeBid({ bidderId: req.user.id, auctionId: id, amount: value }), 201);
});

module.exports = router;
