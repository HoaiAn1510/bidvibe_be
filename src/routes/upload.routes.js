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

// POST /api/uploads/images?purpose=listing|avatar|dispute|inspection   multipart/form-data, trường files (1–8 ảnh)
// Người mua / người bán: listing, avatar, dispute. Tài khoản nội bộ: chỉ Kho, chỉ purpose=inspection (ảnh kiểm hàng, lưu ở
// inspection/ops-<id>/...); vai trò nội bộ khác vẫn 403 như trước.
router.post('/images', requireAuth, (req, res, next) => {
  const purpose = req.query.purpose || 'listing';
  if (req.user.kind !== 'account') {
    if (req.user.role !== 'warehouse') return next(new AppError('Chỉ tài khoản người dùng được tải ảnh', 403, 'FORBIDDEN'));
    if (purpose !== 'inspection') return next(new AppError('Tài khoản kho chỉ tải ảnh kiểm hàng (purpose=inspection)', 403, 'FORBIDDEN'));
  } else if (purpose === 'inspection') {
    return next(new AppError('Chỉ tài khoản kho được tải ảnh kiểm hàng', 403, 'FORBIDDEN'));
  }
  try { uploadService.assertConfigured(); } catch (err) { return next(err); }
  return next();
}, receiveFiles, async (req, res) => {
  // Thư mục theo người tải: tài khoản người dùng là <id>, tài khoản nội bộ là ops-<id> (hai bảng có dãy id riêng)
  const owner = req.user.kind === 'account' ? req.user.id : `ops-${req.user.id}`;
  const urls = await uploadService.uploadImages(owner, req.files, req.query.purpose || 'listing');
  ok(res, { urls }, 201);
});

module.exports = router;
