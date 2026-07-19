const path = require('path');
const AppError = require('../utils/appError');

module.exports = (req, res, next) => {
  const contractVersion = String(req.headers['x-replication-contract'] || '');
  const jobId = String(req.headers['x-job-id'] || '').trim();
  const storageKey = String(req.headers['x-storage-key'] || '').trim();
  const rawFileName = String(req.headers['x-file-name'] || '').trim();
  const fileName = path.basename(rawFileName);
  if (contractVersion !== 'stream-replication-v2') return next(new AppError('stream-replication-v2 contract is required', 400));
  if (!/^[a-zA-Z0-9._-]+$/.test(jobId) || !/^[a-zA-Z0-9._-]+$/.test(storageKey)) return next(new AppError('Invalid replication identity', 400));
  if (fileName !== rawFileName || !/^[a-zA-Z0-9._-]+$/.test(fileName) || fileName === '.' || fileName === '..') return next(new AppError('Invalid replication filename', 400));
  req.replicationContract = {
    contractVersion,
    jobId, storageKey, fileName, videoId: req.headers['x-video-id'] || null,
  };
  next();
};
