const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const listingService = require('../services/listing_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('seller'));

router.post('/', async (req, res) => {
  ok(res, await listingService.create(req.user.id, req.body || {}), 201);
});

router.get('/mine', async (req, res) => {
  ok(res, { listings: await listingService.listMine(req.user.id, { status: req.query.status, ...pageParams(req.query) }) });
});

router.patch('/:id', async (req, res) => {
  ok(res, await listingService.update(req.user.id, idParam(req.params.id), req.body || {}));
});

router.post('/:id/photos', async (req, res) => {
  ok(res, await listingService.addPhotos(req.user.id, idParam(req.params.id), req.body || {}), 201);
});

router.post('/:id/submit', async (req, res) => {
  ok(res, await listingService.submit(req.user.id, idParam(req.params.id)));
});

router.post('/:id/resubmit', async (req, res) => {
  ok(res, await listingService.resubmit(req.user.id, idParam(req.params.id)));
});

module.exports = router;
