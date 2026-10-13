const express = require('express');
const multer = require('multer');
const { requireAuth } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const uploadService = require('../services/upload_service');
const { ok } = require('./_http');

const router = express.Router();

const parseFiles = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: uploadService.MAX_BYTES, files: uploadService.MAX_FILES },
}).array('files', uploadService.MAX_FILES);

// Lỗi của multer -> mã lỗi của API.
function receiveFiles(req, res, next) {
  parseFiles(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new AppError('Mỗi ảnh tối đa 5 MB', 413, 'FILE_TOO_LARGE'));
      if (err.code === 'LIMIT_FILE_COUNT' || (err.code === 'LIMIT_UNEXPECTED_FILE' && err.field === 'files')) {
        return next(new AppError(`Tối đa ${uploadService.MAX_FILES} ảnh mỗi lần`, 400, 'TOO_MANY_FILES'));
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') return next(new AppError('Ảnh phải gửi trong trường files', 400, 'VALIDATION_ERROR'));
      return next(new AppError('Dữ liệu tải lên không hợp lệ', 400, 'VALIDATION_ERROR'));
    }
    return next(new AppError('Dữ liệu multipart không hợp lệ', 400, 'VALIDATION_ERROR'));
  });
}

// POST /api/uploads/images?purpose=listing|avatar   multipart/form-data, trường files (1–8 ảnh)
router.post('/images', requireAuth, (req, res, next) => {
  if (req.user.kind !== 'account') return next(new AppError('Chỉ tài khoản người dùng được tải ảnh', 403, 'FORBIDDEN'));
  try { uploadService.assertConfigured(); } catch (err) { return next(err); }
  return next();
}, receiveFiles, async (req, res) => {
  const urls = await uploadService.uploadImages(req.user.id, req.files, req.query.purpose || 'listing');
  ok(res, { urls }, 201);
});

module.exports = router;
