'use strict';

// =============================================================================
// uploadContract — đọc và kiểm tra metadata upload v2 từ header.
//
// NGUYÊN TẮC: tên file trên đĩa do Sub TỰ SUY RA từ `uploadId` + `chunkIndex`,
// KHÔNG bao giờ lấy từ multipart filename hay `X-Chunk-Name`. Client không đặt
// được tên file thì không có đường ghi ra ngoài thư mục đã định.
//
// [UPDATED 2026-08-16] Mọi lỗi mang thêm `apiCode`. Trước đây `AppError` chỉ có
// message, nên `controllers/errorController.js` phải suy mã theo HTTP status và
// MỌI lỗi 400 của Sub về tới Central đều là `BAD_REQUEST` — Central không phân
// biệt được "connector sai phiên bản" với "chunkIndex vượt chunkCount", trong
// khi hai thứ đó cần hai cách xử lý khác nhau (sửa connector vs bỏ job).
// Central đọc mã này ở `clients/nodeClient.js` -> `error.code`.
// =============================================================================

const AppError = require('../utils/appError');
const paths = require('../storage/paths');
const nodeAuth = require('../platform/nodeAuth');
const log = require('../platform/log');

const contractLog = log.child('uploadContract');

const read = (req, canonical, legacy) => req.headers[canonical] || (legacy ? req.headers[legacy] : undefined);

// Dùng chung `assertToken` của `storage/paths`: trước đây biểu thức
// `^[a-zA-Z0-9._-]+$` có BA bản sao (ở đây, replicationContract, replicationService).
// Ba bản sao của một luật bảo mật là ba cơ hội để chúng lệch nhau.
const safeToken = (value, field) => paths.assertToken(value, field);

module.exports = (req, res, next) => {
  try {
    const contractVersion = read(req, 'x-upload-contract');
    if (contractVersion !== 'stream-upload-v2') {
      throw new AppError('stream-upload-v2 contract is required', 400, 'CONTRACT_VERSION_REQUIRED');
    }

    const uploadId = safeToken(read(req, 'x-upload-id', 'uploadid'), 'uploadId');
    const storageKey = safeToken(read(req, 'x-storage-key', 'filename'), 'storageKey');
    const extension = safeToken(read(req, 'x-media-extension', 'ext'), 'extension').toLowerCase();

    const chunkIndex = Number.parseInt(read(req, 'x-chunk-index', 'index'), 10);
    const chunkCount = Number.parseInt(read(req, 'x-chunk-count'), 10);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0) {
      throw new AppError('chunkIndex is invalid', 400, 'CHUNK_RANGE_INVALID');
    }
    if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkIndex >= chunkCount) {
      throw new AppError('chunkCount is invalid', 400, 'CHUNK_RANGE_INVALID');
    }

    // -----------------------------------------------------------------------
    // [THÊM 2026-08-16 Phase 2] Token phiên upload do Central ký.
    //
    // Người gọi endpoint này là TRÌNH DUYỆT, nên không thể bắt nó ký từng
    // request (khoá bí mật trong JS là khoá công khai). Thay vào đó Central ký
    // sẵn danh tính phiên upload khi cấp session, FE chỉ chuyển tiếp chuỗi đó
    // như một token mờ.
    //
    // Không có bước này thì bất kỳ ai cũng tự bịa được `storageKey`/`chunkCount`
    // và ghi file tuỳ ý vào node. Đặc biệt `chunkCount`: sửa được nó là điều
    // khiển được thời điểm Sub coi là "đủ chunk", tức ép Sub ghép file dở dang
    // rồi đem đi encode.
    //
    // `NODE_AUTH_MODE=off` (mặc định) bỏ qua hoàn toàn — FE cũ chưa chuyển tiếp
    // header này vẫn upload được trong lúc rollout.
    // -----------------------------------------------------------------------
    const sessionAuth = nodeAuth.verifyUploadSession(read(req, 'x-upload-auth'), {
      uploadId,
      storageKey,
      extension,
      chunkCount,
      videoId: read(req, 'x-video-id') || '',
    });
    if (!sessionAuth.allow) {
      throw new AppError(`upload session signature is invalid: ${sessionAuth.reason}`, 401, 'UPLOAD_AUTH_FAILED');
    }
    if (sessionAuth.reason !== 'ok' && sessionAuth.mode === nodeAuth.MODES.LOG) {
      // Mức `log`: đếm trước khi siết. Chỉ ghi ở chunk ĐẦU để một lần upload
      // 100 chunk không sinh 100 dòng giống hệt nhau.
      if (chunkIndex === 0) {
        contractLog.warn('would deny upload session', {
          event: 'nodeauth.upload.would_deny',
          reason: sessionAuth.reason,
          uploadId,
          storageKey,
        });
      }
    }

    req.uploadContract = {
      contractVersion,
      uploadId,
      storageKey,
      extension,
      chunkIndex,
      chunkCount,
      // Giữ `chunkName` cho tương thích; nguồn sự thật là `storage/paths.chunkPart`
      // mà `modules/multerAPI.js` dùng để đặt tên file thật.
      chunkName: `${uploadId}.part.${chunkIndex}`,
      videoId: read(req, 'x-video-id') || null,
      infoId: read(req, 'x-info-id') || null,
      mediaType: read(req, 'x-media-type') || 'DASH',
    };
    next();
  } catch (error) {
    next(error);
  }
};
