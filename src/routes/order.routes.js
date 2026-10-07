const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../services/auction_engine');
const { ok, idParam } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder'));

router.get('/mine', async (req, res) => {
  ok(res, { orders: await engine.listOrdersForBidder(req.user.id) });
});

router.get('/:id', async (req, res) => {
  ok(res, await engine.getOrderForBidder(req.user.id, idParam(req.params.id)));
});

// Thanh toán đơn thắng: { method: 'wallet' | 'qr' | 'card' }
router.post('/:id/pay', async (req, res) => {
  const { method } = req.body || {};
  ok(res, await engine.payOrder({ bidderId: req.user.id, orderId: idParam(req.params.id), method }));
});

module.exports = router;
