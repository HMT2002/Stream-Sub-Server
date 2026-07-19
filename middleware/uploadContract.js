const AppError = require('../utils/appError');

const read = (req, canonical, legacy) => req.headers[canonical] || (legacy ? req.headers[legacy] : undefined);
const safeToken = (value, field) => {
  const token = String(value || '').trim();
  if (!token || !/^[a-zA-Z0-9._-]+$/.test(token)) throw new AppError(`${field} is invalid`, 400);
  return token;
};

module.exports = (req, res, next) => {
  try {
    const contractVersion = read(req, 'x-upload-contract');
    if (contractVersion !== 'stream-upload-v2') throw new AppError('stream-upload-v2 contract is required', 400);
    const uploadId = safeToken(read(req, 'x-upload-id', 'uploadid'), 'uploadId');
    const storageKey = safeToken(read(req, 'x-storage-key', 'filename'), 'storageKey');
    const extension = safeToken(read(req, 'x-media-extension', 'ext'), 'extension').toLowerCase();
    const chunkIndex = Number.parseInt(read(req, 'x-chunk-index', 'index'), 10);
    const chunkCount = Number.parseInt(read(req, 'x-chunk-count'), 10);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) throw new AppError('chunkIndex is invalid', 400);
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex >= chunkCount) throw new AppError('chunkCount is invalid', 400);
    req.uploadContract = {
      contractVersion, uploadId, storageKey,
      extension, chunkIndex, chunkCount, chunkName: `${uploadId}.part.${chunkIndex}`,
      videoId: read(req, 'x-video-id') || null, infoId: read(req, 'x-info-id') || null,
      mediaType: read(req, 'x-media-type') || 'DASH',
    };
    next();
  } catch (error) { next(error); }
};
