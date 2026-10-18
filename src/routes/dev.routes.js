// /api/dev: chỉ được đăng ký khi DEV_TOOLS=true và NODE_ENV khác production (routes/index.js).
// Vai trò nào đăng nhập cũng gọi được, để FE tự test thắng phiên / quá hạn thanh toán mà không sửa tay database.
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const dev = require('../services/dev_service');
const { ok, idParam } = require('./_http');

const router = express.Router();
router.use(requireAuth);

// Rút ngắn phiên đang diễn ra: { seconds? } 5–3600, mặc định 10
router.post('/auctions/:id/end-soon', async (req, res) => {
  ok(res, await dev.endAuctionSoon({ auctionId: idParam(req.params.id), seconds: (req.body || {}).seconds }));
});

// Cho đơn chưa thanh toán quá hạn ngay (scheduler huỷ đơn, tịch thu cọc)
router.post('/orders/:id/expire-payment', async (req, res) => {
  ok(res, await dev.expireOrderPayment({ orderId: idParam(req.params.id) }));
});

module.exports = router;
