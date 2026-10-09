// Route đơn hàng phía BE2 (sau bán), mount tại /api/orders TRƯỚC order.routes.js của BE1.
// Không dùng middleware cấp router: đường dẫn không khớp ở đây sẽ rơi xuống router của BE1
// (/mine, /:id, /:id/pay), nên mỗi route tự gắn requireAuth + requireRole.
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const fulfilment = require('../services/fulfilment_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
const seller = [requireAuth, requireRole('seller')];
const bidder = [requireAuth, requireRole('bidder')];

router.get('/selling', ...seller, async (req, res) => {
  ok(res, { orders: await fulfilment.listSelling(req.user.id, { stage: req.query.stage, ...pageParams(req.query) }) });
});

router.post('/:id/ship-to-warehouse', ...seller, async (req, res) => {
  ok(res, await fulfilment.shipToWarehouse(req.user.id, idParam(req.params.id)));
});

router.post('/:id/confirm-delivery', ...bidder, async (req, res) => {
  ok(res, await fulfilment.confirmDelivery(req.user.id, idParam(req.params.id)));
});

// Tiến trình kho / vận chuyển / giải ngân, cho người mua hoặc người bán của đơn.
router.get('/:id/tracking', requireAuth, requireRole('bidder', 'seller'), async (req, res) => {
  ok(res, await fulfilment.tracking(req.user, idParam(req.params.id)));
});

module.exports = router;
