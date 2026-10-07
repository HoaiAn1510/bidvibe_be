const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const walletService = require('../services/wallet_service');
const walletModel = require('../models/wallet.model');
const { inTransaction } = require('../services/auction_engine');
const { ok, intField, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder'));

router.get('/', async (req, res) => {
  ok(res, await walletService.getWallet(req.user.id));
});

router.get('/transactions', async (req, res) => {
  ok(res, { transactions: await walletModel.listTransactions(req.user.id, pageParams(req.query)) });
});

// Nạp tiền (giả lập cổng thanh toán: luôn thành công). method: 'qr' | 'card'
router.post('/topup', async (req, res) => {
  const amount = intField((req.body || {}).amount, 'amount');
  const tx = await inTransaction((client) => walletService.topUp(client, { bidderId: req.user.id, amount }));
  ok(res, { transaction: tx, ...(await walletService.getWallet(req.user.id)) }, 201);
});

module.exports = router;
