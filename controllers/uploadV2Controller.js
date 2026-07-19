const path = require('path');
const encodeAPI = require('../modules/encodeAPI');
const uploadSessionService = require('../services/uploadSessionService');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const operationLog = require('../utils/operationLog');

exports.receiveChunk = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError('multipartFileChunk is required', 400));
  const contract = req.uploadContract;
  const state = uploadSessionService.acceptChunk(contract);
  operationLog.write('upload.chunk.accepted', {
    uploadId: contract.uploadId, storageKey: contract.storageKey, chunkIndex: contract.chunkIndex,
    chunkCount: contract.chunkCount, complete: state.complete, alreadyComplete: state.alreadyComplete,
  });
  if (!state.complete) {
    return res.status(202).json({ ok: true, data: {
      contractVersion: contract.contractVersion, uploadId: contract.uploadId, storageKey: contract.storageKey,
      chunkIndex: contract.chunkIndex, receivedCount: state.received.length, chunkCount: contract.chunkCount, complete: false,
    } });
  }
  if (!state.alreadyComplete) {
    void encodeAPI
      .encodeIntoDashVer4(`${uploadSessionService.videosRoot}${path.sep}`, path.basename(state.outputPath))
      .catch((error) => operationLog.write('upload.encode.start_failed', {
        uploadId: contract.uploadId, storageKey: contract.storageKey, message: error.message,
      }));
  }
  return res.status(202).json({ ok: true, data: {
    contractVersion: contract.contractVersion, uploadId: contract.uploadId, storageKey: contract.storageKey,
    complete: true, alreadyComplete: state.alreadyComplete,
    media: { videoId: contract.videoId, infoId: contract.infoId, type: contract.mediaType },
    job: { type: 'dash-encode', state: state.alreadyComplete ? 'already-accepted' : 'accepted' },
  } });
});
