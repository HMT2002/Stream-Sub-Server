'use strict';

// =============================================================================
// requestTrace — nhận `X-Request-Id` từ Central/FE, echo lại và mở
// AsyncLocalStorage cho phần còn lại của chain.
//
// CHỈ MOUNT TRÊN CONTROL PLANE (`app.js`). Không mount toàn cục, có chủ đích:
// `/api/auth/verify` được nginx gọi cho MỖI segment (~1800 lần cho một phiên
// xem 2 tiếng) và các handler `*.m4s`/`*.mpd` cũng nằm trên data path. Thêm bất
// cứ thứ gì vào đó là nhân lên hàng nghìn lần, trong khi trace ở đó không có
// giá trị — một request segment không thuộc thao tác control nào cả.
//
// Middleware này cố tình rẻ: một regex test và một `als.run`. Không I/O, không
// log mỗi request (log là việc của `operationLog` tại các mốc nghiệp vụ).
// =============================================================================

const crypto = require('crypto');
const requestContext = require('../utils/requestContext');

// Id đến từ ngoài và sẽ đi thẳng vào log lẫn header outbound, nên phải validate
// trước khi tin: chặn ký tự xuống dòng (giả mạo dòng log) và chuỗi quá dài.
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const newRequestId = () =>
  crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : crypto.randomBytes(4).toString('hex');

const resolveRequestId = (req) => {
  const incoming = req?.headers?.['x-request-id'];
  if (typeof incoming === 'string' && VALID_REQUEST_ID.test(incoming)) {
    return { requestId: incoming, origin: 'upstream' };
  }
  // Không có id hợp lệ thì tự sinh: thao tác vẫn phải truy vết được trong nội
  // bộ Sub, kể cả khi người gọi không phải Central.
  return { requestId: newRequestId(), origin: 'generated' };
};

module.exports = (req, res, next) => {
  const { requestId, origin } = resolveRequestId(req);
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId, requestIdOrigin: origin, startedAt: Date.now() }, next);
};

module.exports.VALID_REQUEST_ID = VALID_REQUEST_ID;
module.exports.resolveRequestId = resolveRequestId;

// =============================================================================
// resume — DỰNG LẠI context sau một body parser dạng stream (multer).
//
// -----------------------------------------------------------------------------
// Lỗi được sửa (phát hiện 2026-08-16, có từ 2026-08-15)
// -----------------------------------------------------------------------------
// AsyncLocalStorage bám theo async context của nơi TẠO RA tài nguyên async, chứ
// không theo thứ tự middleware. `req` (IncomingMessage) được Node tạo ra TRƯỚC
// khi `requestTrace` chạy `als.run()`. multer/busboy lắng nghe sự kiện trên
// chính `req` đó, nên `next()` mà nó gọi chạy trong context của HTTP server —
// context gốc, KHÔNG phải context ta vừa mở.
//
// Kết quả đo được:
//     before multer: trace-123
//     after  multer: null
//
// Nghĩa là mọi thứ sau multer mất trace, và đó lại đúng là hai đường quan trọng
// nhất của contract v2:
//     upload.chunk.accepted        (controllers/uploadV2Controller.js)
//     replication.file.received    (controllers/replicationV2Controller.js)
// `markdowns/upload-replication-contract-v2.md` §5b viết "Sub gắn id vào mọi
// dòng operationLog" — khẳng định đó đã SAI đúng ở hai chỗ này.
//
// Hệ quả dây chuyền: `encodeJobService.submit()` chụp `requestId` để gắn vào
// callback `stream-encode-v1` gửi cho Central hàng chục phút sau. Không có id ở
// đây thì sợi trace đứt hẳn từ FE tới tận lúc encode xong.
//
// -----------------------------------------------------------------------------
// Vì sao lấy id từ RESPONSE HEADER
// -----------------------------------------------------------------------------
// `requestTrace` đã `res.setHeader('X-Request-Id', ...)` với giá trị ĐÃ VALIDATE
// (hoặc đã tự sinh khi client gửi rác). Đọc lại từ đó là lấy đúng id đang dùng,
// không phải validate lần hai từ input thô — nên không có đường nào để một id
// bẩn lọt vào log qua ngả này.
//
// No-op khi context còn nguyên: nếu sau này multer/Node thay đổi và ALS sống
// xuyên qua được, middleware này tự động không làm gì.
// =============================================================================
module.exports.resume = (req, res, next) => {
  if (requestContext.getRequestId()) return next();

  const header = res.getHeader('X-Request-Id');
  if (!header) return next();

  return requestContext.run(
    { requestId: String(header), requestIdOrigin: 'restored', startedAt: Date.now() },
    next
  );
};
