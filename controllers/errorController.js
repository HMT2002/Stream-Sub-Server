'use strict';

// =============================================================================
// errorController — điểm cuối của mọi lỗi.
//
// HAI ĐƯỜNG RA, tuỳ theo ai đang đọc:
//   /api/v2/*  -> envelope `{ok:false, error:{code,message,requestId}}`.
//                 Central đọc chính xác `response.data.error.code` để rẽ nhánh
//                 (xem `Stream-Central-Server/backend/clients/nodeClient.js`,
//                 hàm `buildResult`). `message` là để người đọc log, ĐƯỢC PHÉP
//                 đổi; `code` thì KHÔNG.
//   còn lại    -> hình dạng v1 cũ, giữ nguyên cho client cũ.
// =============================================================================

const AppError = require('../utils/appError');
const requestContext = require('../utils/requestContext');
const log = require('../platform/log');

const errorLog = log.child('errorController');

/**
 * @deprecated 2026-08-16 — Sub đã bỏ MongoDB khỏi runtime từ 2026-07
 * (`markdowns/upload-replication-contract-v2.md` §6). Ba handler dưới đây chỉ
 * kích hoạt với lỗi của driver Mongo/Mongoose nên là code chết.
 * Xoá khi: xác nhận không còn `require('mongoose')` trên đường chạy của Sub.
 */
const handleValidationError = () =>
  new AppError('There something wrong with the data you sent, please check again', 400, 'VALIDATION_ERROR');
const handleJWTValidationError = () => new AppError('You are not login', 401, 'UNAUTHORIZED');

const handleDuplicateFieldsDB = (error) => {
  // console.log(error);

  if (error.keyPattern.account) {
    return new AppError('The account is already existed', 400, 'CONFLICT');
  }
  if (error.keyPattern.email) {
    return new AppError('The email is already existed', 400, 'CONFLICT');
  }
  if (error.keyPattern.title) {
    return new AppError('The title is already existed', 400, 'CONFLICT');
  }
  if (error.keyPattern.slug) {
    return new AppError('The slug is already existed', 400, 'CONFLICT');
  }
  return new AppError('Some fields are duplicated', 400, 'CONFLICT');
};

// Bảng mặc định GIỐNG HỆT Central (`backend/controllers/errorController.js`).
// Hai bên sinh ra cùng một mã cho cùng một status, nên dashboard/alert không
// phải biết lỗi đến từ Central hay từ Sub.
const DEFAULT_API_CODE = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'VALIDATION_ERROR',
  426: 'UPGRADE_REQUIRED',
});

const getDefaultApiCode = (statusCode) => DEFAULT_API_CODE[statusCode] || 'INTERNAL_SERVER_ERROR';

// `err.apiCode` là mã do chính Sub đặt (`new AppError(msg, 400, 'IDENTITY_INVALID')`).
// `err.code` chỉ còn để tương thích ngược với code cũ từng đặt trường đó.
const resolveApiCode = (err) => err.apiCode || err.code || getDefaultApiCode(err.statusCode);

const sendErrorProd = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    message: 'There something wrong!',
  });
};

const sendErrorDev = (err, res) => {
  res.status(err.statusCode).json({
    status: err.status,
    error: err,
    message: err.message,
    stack: err.stack,
  });
};

const sendErrorV2 = (err, req, res) => {
  const requestId = requestContext.getRequestId();
  const code = resolveApiCode(err);

  // Central chỉ thấy body lỗi này. Không kèm requestId thì nó không tra ngược
  // được sang log của Sub để biết chuyện gì đã xảy ra.
  errorLog.warn('request failed', {
    event: 'request.failed',
    path: req.originalUrl,
    statusCode: err.statusCode,
    code,
    message: err.message,
  });

  // Lỗi không phải `AppError` (bug lập trình) có thể lộ chi tiết nội bộ trong
  // message. Chỉ trả nguyên văn khi là lỗi nghiệp vụ, hoặc khi đang dev.
  const canExposeMessage = err.isOperational || process.env.NODE_ENV === 'development';

  return res.status(err.statusCode).json({
    ok: false,
    error: {
      code,
      message: canExposeMessage ? err.message || 'Sub-node request failed' : 'Sub-node request failed',
      ...(requestId ? { requestId } : {}),
    },
  });
};

module.exports = (err, req, res, next) => {
  err.statusCode = err.statusCode || 500;
  err.status = err.status || 'error';

  if (req.originalUrl.startsWith('/api/v2/')) {
    return sendErrorV2(err, req, res);
  }

  if (process.env.NODE_ENV === 'development') {
    if (err.code === 11000) err = handleDuplicateFieldsDB(err);

    sendErrorDev(err, res);
  } else {
    let error = { ...err };
    // if (error.name === 'CastError') error = handleCastErrorDB(error);
    if (error.code === 11000) error = handleDuplicateFieldsDB(error);
    if (error.name === 'ValidationError') error = handleValidationError();
    if (error.name === 'JsonWebTokenError') error = handleJWTValidationError();

    sendErrorProd(error, res);
  }
};
