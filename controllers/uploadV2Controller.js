'use strict';

// =============================================================================
// uploadV2Controller — nhận từng chunk của contract `stream-upload-v2`.
//
// Controller cố ý MỎNG: đọc contract đã validate, gọi service, gói response.
// Không fs, không spawn, không axios.
//
// [UPDATED 2026-08-16 Phase 1] Hai thay đổi:
//   1. Encode không còn fire-and-forget. `encodeJobService.submit()` ghi
//      `.job.json`, xếp vào hàng đợi có giới hạn concurrency, và báo kết quả về
//      Central khi xong. Trước đây `202 Accepted` là tín hiệu CUỐI CÙNG Central
//      nhận được — FFmpeg xong hay chết thì không ai biết.
//   2. Envelope đi qua `presenters/v2Presenter` thay vì tự dựng JSON.
// =============================================================================

const encodeJobService = require('../services/encodeJobService');
const uploadSessionService = require('../services/uploadSessionService');
const presenter = require('../presenters/v2Presenter');
const catchAsync = require('../utils/catchAsync');
const errors = require('../platform/errors');
const log = require('../platform/log');

const uploadLog = log.child('uploadV2');

exports.receiveChunk = catchAsync(async (req, res, next) => {
  if (!req.file) return next(errors.fail('UPLOAD_FILE_REQUIRED', 'multipartFileChunk is required'));

  const contract = req.uploadContract;
  const state = uploadSessionService.acceptChunk(contract);

  uploadLog.event('upload.chunk.accepted', {
    uploadId: contract.uploadId,
    storageKey: contract.storageKey,
    chunkIndex: contract.chunkIndex,
    chunkCount: contract.chunkCount,
    complete: state.complete,
    alreadyComplete: state.alreadyComplete,
  });

  if (!state.complete) {
    return presenter.accepted(
      res,
      presenter.withContract(contract.contractVersion, {
        uploadId: contract.uploadId,
        storageKey: contract.storageKey,
        chunkIndex: contract.chunkIndex,
        receivedCount: state.received.length,
        chunkCount: contract.chunkCount,
        complete: false,
      })
    );
  }

  // `alreadyComplete` = marker đã tồn tại, tức FE gửi lại chunk cuối sau khi
  // mạng chập. KHÔNG được xếp job encode lần hai cho cùng một storageKey.
  let job = null;
  if (!state.alreadyComplete) {
    job = encodeJobService.submit({
      uploadId: contract.uploadId,
      storageKey: contract.storageKey,
      extension: contract.extension,
      videoId: contract.videoId,
      infoId: contract.infoId,
      mediaType: contract.mediaType,
    });
  }

  return presenter.accepted(
    res,
    presenter.withContract(contract.contractVersion, {
      uploadId: contract.uploadId,
      storageKey: contract.storageKey,
      complete: true,
      alreadyComplete: state.alreadyComplete,
      media: { videoId: contract.videoId, infoId: contract.infoId, type: contract.mediaType },
      job: {
        type: 'dash-encode',
        // Giữ nguyên hai giá trị cũ để Central/FE hiện tại không phải sửa.
        state: state.alreadyComplete ? 'already-accepted' : 'accepted',
        // Phần mới: có `jobId` thì Central mới đối chiếu được với callback
        // `stream-encode-v1` gửi tới sau đó vài chục phút.
        jobId: job ? job.jobId : null,
        queue: job ? job.queue : null,
      },
    })
  );
});

// GET /api/v2/uploads/jobs/:storageKey — trạng thái encode của một video.
// Central dùng để tự tra khi callback chưa tới (Central restart, mạng đứt...).
exports.jobStatus = catchAsync(async (req, res, next) => {
  const state = encodeJobService.readJobFile(req.params.storageKey);
  if (!state) return next(errors.fail('ENCODE_JOB_NOT_FOUND', `Không có job cho storageKey ${req.params.storageKey}`));
  return presenter.ok(res, { job: state, queue: encodeJobService.stats() });
});
