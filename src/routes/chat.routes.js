const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const chatService = require('../services/chat_service');
const { ok, idParam } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder', 'seller'));

// { content, sessionId? }  (không có sessionId thì mở phiên trò chuyện mới)
router.post('/messages', async (req, res) => {
  ok(res, await chatService.sendMessage(req.user, req.body || {}), 201);
});

router.get('/sessions/:id/messages', async (req, res) => {
  ok(res, await chatService.history(req.user, idParam(req.params.id)));
});

module.exports = router;
