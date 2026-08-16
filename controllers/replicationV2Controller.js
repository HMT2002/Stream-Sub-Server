'use strict';

// =============================================================================
// replicationV2Controller — hai đầu của contract `stream-replication-v2`.
//
//   sendFolder  : node NGUỒN, nhận lệnh từ Central rồi đẩy từng file đi.
//   receiveFile : node ĐÍCH, nhận và xác nhận từng file.
//
// [UPDATED 2026-08-16 Phase 1] Envelope qua `presenters/v2Presenter`; mã lỗi lấy
// từ `platform/errors` thay vì chuỗi rời.
// =============================================================================

const replicationService = require('../services/replicationService');
const presenter = require('../presenters/v2Presenter');
const catchAsync = require('../utils/catchAsync');
const errors = require('../platform/errors');
const log = require('../platform/log');

const replicationLog = log.child('replicationV2');

exports.sendFolder = catchAsync(async (req, res, next) => {
  // 426 Upgrade Required là tín hiệu ĐÃ ĐƯỢC CENTRAL DỰA VÀO: connector mới bắt
  // 404/405/426 rồi tự hạ xuống `/api/v1/replicate/send-folder-v2`
  // (`Stream-Central-Server/backend/services/redirect/replicationService.js`,
  // hằng `NEEDS_LEGACY_CONNECTOR`). Đổi mã ở đây là làm hỏng đường fallback đó.
  if (req.body.contractVersion !== 'stream-replication-v2') {
    return next(
      errors.fail(
        'REPLICATION_CONNECTOR_UPGRADE_REQUIRED',
        'Central must send the full stream-replication-v2 command; Sub no longer resolves database IDs'
      )
    );
  }

  const result = await replicationService.sendFolder(req.body);
  replicationLog.event('replication.folder.sent', result);
  return presenter.ok(res, result);
});

exports.receiveFile = catchAsync(async (req, res, next) => {
  if (!req.file) return next(errors.fail('REPLICATION_FILE_REQUIRED', 'replicationFile is required'));

  const contract = req.replicationContract;
  replicationLog.event('replication.file.received', {
    jobId: contract.jobId,
    storageKey: contract.storageKey,
    fileName: contract.fileName,
    bytes: req.file.size,
  });

  // Hình dạng ack này được node NGUỒN kiểm từng field
  // (`services/replicationService.isValidAcknowledgement`) — đổi field là làm
  // mọi lần replicate thất bại với `DESTINATION_REJECTED`.
  return presenter.created(
    res,
    presenter.withContract(contract.contractVersion, {
      jobId: contract.jobId,
      storageKey: contract.storageKey,
      fileName: contract.fileName,
      received: true,
    })
  );
});
