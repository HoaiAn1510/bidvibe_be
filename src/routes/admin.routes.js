const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const admin = require('../services/admin_service');
const disputeService = require('../services/dispute_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

router.get('/dashboard', async (req, res) => {
  ok(res, await admin.dashboard());
});

router.get('/report/weekly', async (req, res) => {
  ok(res, await admin.weeklyReport());
});

// ---- Phiên bị gắn cờ ----
router.get('/flags', async (req, res) => {
  ok(res, { flags: await admin.listFlags({ status: req.query.status, ...pageParams(req.query) }) });
});

// { action: 'pause' | 'terminate' | 'verify' | 'safe', reason }  (terminate bắt buộc reason)
router.post('/flags/:id/action', async (req, res) => {
  ok(res, await admin.flagAction(req.user.id, idParam(req.params.id), req.body || {}));
});

// ---- Tranh chấp ----
router.get('/disputes', async (req, res) => {
  ok(res, { disputes: await disputeService.listForAdmin({ status: req.query.status, ...pageParams(req.query) }) });
});

// { resolution: 'refund' | 'keep', note? }
router.post('/disputes/:id/resolve', async (req, res) => {
  ok(res, await disputeService.resolve(req.user.id, idParam(req.params.id), req.body || {}));
});

// ---- Tài khoản nội bộ ----
router.get('/ops-accounts', async (req, res) => {
  ok(res, { accounts: await admin.listOps({ role: req.query.role, status: req.query.status }) });
});

// { name, email, role: 'appraiser' | 'warehouse' | 'admin', password }
router.post('/ops-accounts', async (req, res) => {
  ok(res, await admin.createOps(req.body || {}), 201);
});

// { name?, role?, status?: 'active' | 'suspended', password? }
router.patch('/ops-accounts/:id', async (req, res) => {
  ok(res, await admin.updateOps(req.user.id, idParam(req.params.id), req.body || {}));
});

// ---- Tài khoản Bidder / Seller ----
router.get('/accounts', async (req, res) => {
  const { role, status, q } = req.query;
  ok(res, { accounts: await admin.listAccounts({ role, status, q, ...pageParams(req.query) }) });
});

// { status: 'active' | 'suspended' }
router.patch('/accounts/:id', async (req, res) => {
  ok(res, await admin.setAccountStatus(idParam(req.params.id), req.body || {}));
});

module.exports = router;
