'use strict';

// =============================================================================
// errors — catalogue mã lỗi API của Sub node.
//
// -----------------------------------------------------------------------------
// Vì sao mã phải nằm ở MỘT bảng
// -----------------------------------------------------------------------------
// `Stream-Central-Server/backend/clients/nodeClient.js` đọc lỗi của Sub bằng
//     response.data?.error?.code
// rồi `services/redirect/replicationService.js` rẽ nhánh theo nó. Nghĩa là mã
// lỗi là **giao diện công khai** giữa hai repo, còn `message` chỉ để người đọc.
//
// Hệ quả thực tế của quy ước này:
//   - đổi `message` -> tự do, không phá gì;
//   - đổi/xoá `code` -> phá Central, phải coi như đổi contract.
//
// Bảng này là nơi duy nhất được sinh mã mới. Rải `new AppError(msg, 400, 'ABC')`
// khắp nơi thì sớm muộn có hai chỗ dùng hai mã cho cùng một tình huống, và
// Central sẽ xử lý cùng một lỗi theo hai cách khác nhau.
//
// Mã KHÔNG có ở đây nhưng vẫn hợp lệ: nhóm mặc định theo HTTP status do
// `controllers/errorController.js` suy ra (`BAD_REQUEST`, `NOT_FOUND`...), dùng
// chung bảng với Central.
// =============================================================================

const AppError = require('../utils/appError');

const CODES = Object.freeze({
  // --- Contract / định danh ---------------------------------------------------
  CONTRACT_VERSION_REQUIRED: { status: 400, hint: 'Central gửi sai/thiếu contractVersion — sửa connector, đừng retry' },
  IDENTITY_INVALID: { status: 400, hint: 'uploadId/jobId/storageKey không phải token ASCII an toàn — không retry' },
  FILENAME_INVALID: { status: 400, hint: 'X-File-Name chứa đường dẫn hoặc ký tự lạ — không retry' },
  CHUNK_RANGE_INVALID: { status: 400, hint: 'chunkIndex vượt chunkCount — job hỏng, không retry' },
  PATH_OUTSIDE_ROOT: { status: 400, hint: 'Đường dẫn suy ra thoát khỏi storage root — chặn cứng' },

  // --- Upload -----------------------------------------------------------------
  UPLOAD_FILE_REQUIRED: { status: 400, hint: 'Thiếu phần multipart `multipartFileChunk`' },
  UPLOAD_AUTH_FAILED: { status: 401, hint: 'X-Upload-Auth sai/thiếu/hết hạn — FE phải xin upload session mới từ Central' },

  // --- Xác thực node-to-node --------------------------------------------------
  NODE_AUTH_FAILED: { status: 401, hint: 'Chữ ký X-Node-Auth sai/thiếu/quá hạn — kiểm tra NODE_SHARED_SECRET và đồng hồ hai máy' },

  // --- Replication ------------------------------------------------------------
  MEDIA_NOT_FOUND: { status: 404, hint: 'Node nguồn không có videos/<storageKey> — kiểm tra placement trong DB' },
  DESTINATION_URL_INVALID: { status: 400, hint: 'destination.receiveUrl không parse được hoặc sai protocol' },
  DESTINATION_REJECTED: { status: 502, hint: 'Node đích không ack đúng file — retry job, có thể đổi đích' },
  REPLICATION_FILE_REQUIRED: { status: 400, hint: 'Thiếu phần multipart `replicationFile`' },
  REPLICATION_CONNECTOR_UPGRADE_REQUIRED: { status: 426, hint: 'Body ID-only kiểu cũ — Central fallback sang v1' },

  // --- Encode -----------------------------------------------------------------
  ENCODE_START_FAILED: { status: 500, hint: 'Không spawn được FFmpeg — cảnh báo vận hành, không phải lỗi của Central' },
  ENCODE_JOB_NOT_FOUND: { status: 404, hint: 'Không có job nào mang jobId/storageKey đó trên node này' },

  // --- Playback block (công tắc chặn phát) ------------------------------------
  BLOCK_TYPE_INVALID: { status: 400, hint: 'type phải là session | storageKey | ip' },
  BLOCK_VALUE_INVALID: { status: 400, hint: 'value rỗng hoặc chứa ký tự không cho phép' },
  BLOCK_NOT_FOUND: { status: 404, hint: 'Không có block nào mang id đó' },

  // --- Data plane -------------------------------------------------------------
  MEDIA_SERVING_DISABLED: { status: 410, hint: 'Node không phục vụ media nữa — phải đi qua nginx :9150' },
});

// Tạo AppError từ catalogue: status luôn đúng theo bảng, không phải nhớ ở call site.
const fail = (code, message, overrideStatus) => {
  const entry = CODES[code];
  if (!entry) {
    // Mã lạ là lỗi lập trình, nhưng KHÔNG được làm sập request đang chạy.
    // Trả 500 kèm mã gốc để còn lần ra được.
    return new AppError(message || 'Unknown sub-node error', overrideStatus || 500, code);
  }
  return new AppError(message || entry.hint, overrideStatus || entry.status, code);
};

module.exports = Object.freeze({ CODES, fail });
