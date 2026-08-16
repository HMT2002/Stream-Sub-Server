'use strict';

// =============================================================================
// requestContext — mang `requestId` của request hiện tại đi xuyên các tầng.
//
// Central gửi `X-Request-Id` trên mọi lệnh control (upload session, replicate,
// delete, check) và FE gửi kèm trên từng chunk upload. Header đó trước đây chỉ
// được liệt kê trong CORS allowlist rồi bị bỏ đi — nên log của Sub và log của
// Central không nối lại được, dù cùng nói về một thao tác.
//
// Dùng AsyncLocalStorage để `operationLog` lấy được id ở bất kỳ đâu mà không
// phải chuyền `req` xuống service (service ở đây được thiết kế để test bằng
// object thuần, đưa `req` vào là phá mất tính chất đó).
//
// LƯU Ý HIỆU NĂNG: module này chỉ được dùng trên CONTROL PLANE. Đường phát
// segment (`/api/auth/verify`, các handler `*.m4s`/`*.mpd`) chạy hàng nghìn lần
// mỗi phiên xem và tuyệt đối không được gánh thêm gì — xem ghi chú trong
// `services/authService.js`.
// =============================================================================

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

const run = (context, callback) => storage.run(context, callback);

const get = () => storage.getStore() || null;

const getRequestId = () => get()?.requestId || null;

// Dùng cho hop Sub→Sub: chỉ gắn header khi thật sự đang trong một request.
const getTraceHeaders = () => {
  const requestId = getRequestId();
  return requestId ? { 'X-Request-Id': requestId } : {};
};

module.exports = Object.freeze({ storage, run, get, getRequestId, getTraceHeaders });
