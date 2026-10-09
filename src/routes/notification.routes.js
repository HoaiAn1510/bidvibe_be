const express = require('express');
const { requireAuth } = require('../middleware/auth');
const notificationService = require('../services/notification_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  ok(res, await notificationService.listForAccount(req.user, pageParams(req.query)));
});

router.post('/:id/read', async (req, res) => {
  ok(res, await notificationService.markRead(req.user, idParam(req.params.id)));
});

module.exports = router;
