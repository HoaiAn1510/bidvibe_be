const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const addressService = require('../services/address_service');
const { ok, idParam } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('bidder'));

router.get('/', async (req, res) => {
  ok(res, { addresses: await addressService.list(req.user.id) });
});

// { recipientName, phone, addressLine, city, ward?, district?, isDefault? }
router.post('/', async (req, res) => {
  ok(res, await addressService.create(req.user.id, req.body || {}), 201);
});

router.patch('/:id', async (req, res) => {
  ok(res, await addressService.update(req.user.id, idParam(req.params.id), req.body || {}));
});

router.post('/:id/default', async (req, res) => {
  ok(res, await addressService.setDefault(req.user.id, idParam(req.params.id)));
});

router.delete('/:id', async (req, res) => {
  ok(res, await addressService.remove(req.user.id, idParam(req.params.id)));
});

module.exports = router;
