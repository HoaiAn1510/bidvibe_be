const express = require('express');
const { requireAuth } = require('../middleware/auth');
const notificationService = require('../services/notification_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  ok(res, await notificationService.listForAccount(req.user, pageParams(req.query)));
});

// BE2 thêm: đánh dấu tất cả đã đọc. Đứng trước /:id/read cho dễ đọc (khác số đoạn nên không đè nhau).
router.post('/read-all', async (req, res) => {
  ok(res, await notificationService.markAllRead(req.user));
});

router.post('/:id/read', async (req, res) => {
  ok(res, await notificationService.markRead(req.user, idParam(req.params.id)));
});

module.exports = router;
