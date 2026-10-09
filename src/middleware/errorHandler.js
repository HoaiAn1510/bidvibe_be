// Format phản hồi thống nhất: { success, data, error }

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const notFound = (req, res, next) => {
  next(new AppError(`Không tìm thấy route: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND'));
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  // express.json() ném lỗi này khi body không phải JSON hợp lệ.
  if (err.type === 'entity.parse.failed') {
    err = new AppError('Dữ liệu gửi lên không phải JSON hợp lệ', 400, 'INVALID_JSON');
  } else if (err.type === 'entity.too.large') {
    err = new AppError('Dữ liệu gửi lên quá lớn', 413, 'PAYLOAD_TOO_LARGE');
  }
  const statusCode = err.statusCode || 500;
  if (statusCode >= 500) console.error(err);

  res.status(statusCode).json({
    success: false,
    data: null,
    error: {
      code: err.code || 'INTERNAL_ERROR',
      message: statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'Lỗi hệ thống'
        : err.message,
    },
  });
};

module.exports = { AppError, notFound, errorHandler };
