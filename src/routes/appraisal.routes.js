const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const appraisalService = require('../services/appraisal_service');
const { ok, idParam, pageParams } = require('./_http');

const router = express.Router();
router.use(requireAuth, requireRole('appraiser'));

// ?status=pending_appraisal (mặc định) | needs_info (đang chờ người bán bổ sung)
router.get('/queue', async (req, res) => {
  ok(res, { items: await appraisalService.queue({ status: req.query.status, ...pageParams(req.query) }) });
});

router.get('/:listingId', async (req, res) => {
  ok(res, await appraisalService.detail(idParam(req.params.listingId, 'listingId')));
});

// { decision: 'approve' | 'reject' | 'more_info', reason }
router.post('/:listingId/decision', async (req, res) => {
  ok(res, await appraisalService.decide(req.user.id, idParam(req.params.listingId, 'listingId'), req.body || {}), 201);
});

module.exports = router;
