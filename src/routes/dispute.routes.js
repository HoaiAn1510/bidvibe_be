const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const disputeService = require('../services/dispute_service');
const { ok, idParam } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder', 'seller'));

// { orderId, title, reason, photoUrls? }  photoUrls: 0–6 URL ảnh từ POST /api/uploads/images?purpose=dispute
router.post('/', async (req, res) => {
  ok(res, await disputeService.open(req.user, req.body || {}), 201);
});

// Bổ sung ảnh bằng chứng: { photoUrls } 1–6 ảnh mỗi lần, tổng tối đa 12; chỉ người mua / người bán của đơn, khi còn 'open'
router.post('/:id/photos', async (req, res) => {
  ok(res, await disputeService.addPhotos(req.user, idParam(req.params.id), req.body || {}), 201);
});

router.get('/mine', async (req, res) => {
  ok(res, { disputes: await disputeService.listMine(req.user) });
});

module.exports = router;
