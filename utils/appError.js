'use strict';

// =============================================================================
// AppError — lỗi nghiệp vụ có mã ổn định.
//
// `apiCode` (tham số thứ 3) là bổ sung 2026-08-16, khớp với
// `Stream-Central-Server/backend/utils/appError.js`.
//
// VÌ SAO CẦN: `clients/nodeClient.js` của Central đọc lỗi của Sub bằng
//     response.data?.error?.code
// rồi rẽ nhánh theo mã đó. Trước đây `controllers/errorController.js` lấy mã từ
// `err.code` — nhưng KHÔNG chỗ nào của Sub đặt `err.code` (nó vốn là mã lỗi của
// driver Mongo, mà Sub đã bỏ DB từ 2026-07). Kết quả: MỌI lỗi của Sub đều về
// Central dưới đúng hai mã `INVALID_REQUEST` / `SUB_NODE_ERROR`, không phân biệt
// được "sai contract" với "hết đĩa".
//
// `apiCode` vẫn là TUỲ CHỌN: không truyền thì errorController suy ra mã mặc định
// theo HTTP status, nên toàn bộ `new AppError(msg, status)` cũ chạy y như trước.
// =============================================================================

class AppError extends Error {
  constructor(message, statusCode, apiCode) {
    super(message);

    this.statusCode = statusCode;
    this.status = `${statusCode}`.startsWith('4') ? 'fail' : 'error';
    this.apiCode = apiCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

module.exports = AppError;
