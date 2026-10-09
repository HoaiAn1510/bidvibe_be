const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const fulfilment = require('../services/fulfilment_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('warehouse'));

// ?stage=in_transit_to_warehouse | inspecting | inspected | packed | shipped | delivered | ...
router.get('/orders', async (req, res) => {
  ok(res, { orders: await fulfilment.listForWarehouse({ stage: req.query.stage, ...pageParams(req.query) }) });
});

router.post('/orders/:id/receive', async (req, res) => {
  ok(res, await fulfilment.receive(idParam(req.params.id)));
});

// { result: 'match' | 'mismatch', notes }  (mismatch bắt buộc notes, tự mở tranh chấp)
router.post('/orders/:id/inspect', async (req, res) => {
  ok(res, await fulfilment.inspect(req.user.id, idParam(req.params.id), req.body || {}));
});

router.post('/orders/:id/pack', async (req, res) => {
  ok(res, await fulfilment.pack(idParam(req.params.id), req.body || {}));
});

// { carrier, trackingCode }
router.post('/orders/:id/ship', async (req, res) => {
  ok(res, await fulfilment.ship(idParam(req.params.id), req.body || {}));
});

router.post('/orders/:id/deliver', async (req, res) => {
  ok(res, await fulfilment.deliver(idParam(req.params.id)));
});

module.exports = router;
