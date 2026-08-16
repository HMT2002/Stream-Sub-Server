'use strict';

// =============================================================================
// operationLog — SHIM. Giữ nguyên API `write(event, fields)` cho toàn bộ call
// site sẵn có, nhưng chuyển đường ra sau `platform/log`.
//
// VÌ SAO GIỮ FILE NÀY thay vì sửa hết call site:
// Phase 0 cam kết KHÔNG đổi hành vi. Đổi 8 call site cùng lúc với việc thay
// logger là trộn hai loại thay đổi vào một diff — lúc log ra sai thì không biết
// do logger mới hay do call site sửa hỏng. Giữ shim -> diff của bước này chỉ có
// đúng một biến số.
//
// CÁI ĐƯỢC THÊM khi đi qua `platform/log`:
//   - có LEVEL (tắt được bằng LOG_LEVEL), trước đây `console.log` không tắt được;
//   - có redaction: field tên chứa `token`/`secret`/`authorization` bị che;
//   - Buffer/Error được chuẩn hoá thay vì stringify thành rác;
//   - `pretty` khi NODE_ENV=development, JSON khi deploy.
//
// CÁI ĐỔI trong JSON (không có consumer nào đang parse — đã kiểm tra cả hai repo,
// `media-contract-v2` chỉ xuất hiện đúng ở file này):
//   `timestamp` -> `time`      cho khớp Central
//   thêm `level`, `message`    cho khớp Central
//   `...fields` -> `meta:{...}` để field nghiệp vụ không đụng tên field khung
//
// `requestId` vẫn được BỎ HẲN khi ngoài phạm vi request — hành vi cũ, có chủ
// đích, xem `platform/log.js` mục 2.
//
// @deprecated 2026-08-16 — code MỚI dùng `platform/log`.child(scope).event(...).
// Xoá khi: không còn call site nào require('utils/operationLog').
// =============================================================================

const log = require('../platform/log');

const contractLog = log.child('media-contract-v2');

const write = (event, fields = {}) => contractLog.event(event, fields);

module.exports = Object.freeze({ write });
