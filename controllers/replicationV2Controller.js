const replicationService = require('../services/replicationService');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const operationLog = require('../utils/operationLog');

exports.sendFolder = catchAsync(async (req, res, next) => {
  if (req.body.contractVersion !== 'stream-replication-v2') {
    return res.status(426).json({
      ok: false,
      error: {
        code: 'REPLICATION_CONNECTOR_UPGRADE_REQUIRED',
        message: 'Central must send the full stream-replication-v2 command; Sub no longer resolves database IDs',
      },
    });
  }
  const result = await replicationService.sendFolder(req.body);
  operationLog.write('replication.folder.sent', result);
  res.status(200).json({ ok: true, data: result });
});
exports.receiveFile = catchAsync(async (req, res, next) => {
  if (!req.file) return next(new AppError('replicationFile is required', 400));
  operationLog.write('replication.file.received', {
    jobId: req.replicationContract.jobId, storageKey: req.replicationContract.storageKey,
    fileName: req.replicationContract.fileName, bytes: req.file.size,
  });
  res.status(201).json({ ok: true, data: {
    contractVersion: req.replicationContract.contractVersion, jobId: req.replicationContract.jobId,
    storageKey: req.replicationContract.storageKey, fileName: req.replicationContract.fileName, received: true,
  } });
});
