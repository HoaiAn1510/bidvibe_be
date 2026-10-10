const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../services/auction_engine');
const { AppError } = require('../middleware/errorHandler');
const { ok, idParam, intField } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder'));

// POST /api/bids  { auctionId, amount }   (hoặc { auctionId, increment } = giá hiện tại + increment,
// giá hiện tại được đọc trong giao dịch sau khi khoá phiên)
router.post('/', async (req, res) => {
  const { auctionId, amount, increment } = req.body || {};
  const id = idParam(auctionId, 'auctionId');
  if ((amount == null) === (increment == null)) {
    throw new AppError('Chỉ truyền một trong hai: amount hoặc increment', 400, 'VALIDATION_ERROR');
  }
  const bid = amount != null
    ? { amount: intField(amount, 'amount') }
    : { increment: intField(increment, 'increment') };
  ok(res, await engine.placeBid({ bidderId: req.user.id, auctionId: id, ...bid }), 201);
});

module.exports = router;
