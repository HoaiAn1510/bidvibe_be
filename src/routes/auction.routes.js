const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const engine = require('../services/auction_engine');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth);

// Chỉ tài khoản người mua/người bán (kind 'account') có "viewer"; ops xem không có thông tin cá nhân.
const viewerOf = (req) => (req.user.kind === 'account' ? req.user.id : null);

// GET /api/auctions?category=shoes&status=live|ended|joined&q=&sort=ending|newest|price_asc|price_desc|popular
router.get('/', async (req, res) => {
  const { category, status, q, sort } = req.query;
  const auctions = await engine.listAuctions({
    viewerId: viewerOf(req),
    category,
    status,
    q,
    sort,
    ...pageParams(req.query),
  });
  ok(res, { auctions });
});

router.get('/:id', async (req, res) => {
  ok(res, await engine.getAuction(idParam(req.params.id), viewerOf(req)));
});

// Đặt cọc tham gia phiên
router.post('/:id/join', requireRole('bidder'), async (req, res) => {
  const result = await engine.joinAuction({ bidderId: req.user.id, auctionId: idParam(req.params.id) });
  ok(res, result, 201);
});

module.exports = router;
