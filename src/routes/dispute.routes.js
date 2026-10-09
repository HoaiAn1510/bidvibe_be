const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const disputeService = require('../services/dispute_service');
const { ok } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder', 'seller'));

// { orderId, title, reason }
router.post('/', async (req, res) => {
  ok(res, await disputeService.open(req.user, req.body || {}), 201);
});

router.get('/mine', async (req, res) => {
  ok(res, { disputes: await disputeService.listMine(req.user) });
});

module.exports = router;
