'use strict';

// =============================================================================
// replicationContract — kiểm tra metadata của file replication đến từ Sub nguồn.
//
// `X-File-Name` là chuỗi do bên gọi đặt và sẽ trở thành TÊN FILE THẬT trên đĩa,
// nên nó là đầu vào nguy hiểm nhất của route này. Kiểm tra `path.basename(x) === x`
// bắt được cả `../` lẫn đường dẫn tuyệt đối, còn regex token chặn phần còn lại.
//
// [UPDATED 2026-08-16] Thêm `apiCode` (Central rẽ nhánh theo mã, không theo
// message) và dùng chung `assertToken` của `storage/paths` thay vì bản sao regex.
// =============================================================================

const path = require('path');
const AppError = require('../utils/appError');
const paths = require('../storage/paths');

module.exports = (req, res, next) => {
  const contractVersion = String(req.headers['x-replication-contract'] || '');
  const jobId = String(req.headers['x-job-id'] || '').trim();
  const storageKey = String(req.headers['x-storage-key'] || '').trim();
  const rawFileName = String(req.headers['x-file-name'] || '').trim();
  const fileName = path.basename(rawFileName);

  if (contractVersion !== 'stream-replication-v2') {
    return next(new AppError('stream-replication-v2 contract is required', 400, 'CONTRACT_VERSION_REQUIRED'));
  }
  if (!paths.SAFE_TOKEN.test(jobId) || !paths.SAFE_TOKEN.test(storageKey)) {
    return next(new AppError('Invalid replication identity', 400, 'IDENTITY_INVALID'));
  }
  // `fileName !== rawFileName` bắt trường hợp basename đã cắt bớt đường dẫn —
  // tức là bên gọi đã gửi một path chứ không phải một tên file.
  if (fileName !== rawFileName || !paths.SAFE_TOKEN.test(fileName) || fileName === '.' || fileName === '..') {
    return next(new AppError('Invalid replication filename', 400, 'FILENAME_INVALID'));
  }

  req.replicationContract = {
    contractVersion,
    jobId,
    storageKey,
    fileName,
    videoId: req.headers['x-video-id'] || null,
  };
  next();
};
