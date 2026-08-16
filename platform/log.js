'use strict';

// =============================================================================
// log — MỘT khuôn log duy nhất cho Sub node.
//
// -----------------------------------------------------------------------------
// 1. Vì sao có file này
// -----------------------------------------------------------------------------
// Trước đây Sub có BA hệ thống log song song:
//   console.log('m4s is here')                 controllers/videoController.js
//   helperAPI.EnhaceConsoleLogType(e, 'ERR')   ANSI màu, ghi vào file log là rác
//   operationLog.write(event, fields)          JSON — đúng hướng, nhưng chỉ 8 call site
//
// Không cái nào có LEVEL, nên không tắt được dòng debug trên production; và hai
// request đồng thời cho ra log đan xen không tách được.
//
// -----------------------------------------------------------------------------
// 2. Vì sao khuôn này giống hệt Central
// -----------------------------------------------------------------------------
// `Stream-Central-Server/backend/utils/logger.js` đã có sẵn khuôn này. Một thao
// tác upload đi qua FE → Central → Sub nguồn → Sub đích; nếu hai bên log ra hai
// schema khác nhau thì `X-Request-Id` nối được request nhưng KHÔNG query chung
// được một lượt. Vì vậy giữ ĐÚNG tên field của Central:
//
//   { time, level, requestId, scope, message, meta }
//
// Riêng Sub thêm `event` — mốc nghiệp vụ dạng `<domain>.<object>.<outcome>`
// (`upload.chunk.accepted`), vốn là quy ước sẵn có của `utils/operationLog.js`.
//
// KHÁC BIỆT CÓ CHỦ ĐÍCH so với Central: ngoài phạm vi một request, Central ghi
// `requestId: '-'`, còn ở đây field bị BỎ HẲN trong JSON. Lý do đã ghi trong
// `utils/operationLog.js`: lọc theo requestId không nên dính các bản ghi rỗng.
// Ở chế độ `pretty` (người đọc) vẫn in '-' để cột thẳng hàng.
//
// -----------------------------------------------------------------------------
// 3. Vì sao module này đọc thẳng process.env, không qua platform/config
// -----------------------------------------------------------------------------
// Logger phải dùng được TRƯỚC khi config được validate — nếu không thì lỗi
// "thiếu JWT_SECRET" lúc boot không có cách nào báo ra. Đây là ngoại lệ duy
// nhất; mọi module khác đọc config qua `platform/config`.
//
// -----------------------------------------------------------------------------
// 4. Ràng buộc hiệu năng
// -----------------------------------------------------------------------------
// TUYỆT ĐỐI KHÔNG gọi logger per-request trên data plane (`/api/auth/verify`,
// handler `*.m4s`/`*.mpd`). Một phiên xem 2 tiếng với segment 4s = ~1800 lần.
// Ở đó chỉ được ĐẾM (xem `controllers/authController.js` — bộ đếm in-memory).
// `emit()` kiểm tra ngưỡng level TRƯỚC khi sanitize, nên một lời gọi `log.debug`
// bị tắt gần như miễn phí — nhưng "gần như miễn phí" nhân 1800 vẫn là chi phí.
// =============================================================================

const requestContext = require('../utils/requestContext');

const COLORS = Object.freeze({
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
});

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });
const LEVEL_COLOR = Object.freeze({ debug: 'gray', info: 'green', warn: 'yellow', error: 'red' });

// Khoá nào chứa các chuỗi này thì giá trị bị thay bằng [REDACTED]. Cùng danh
// sách với Central. `token` bắt luôn `X-Player-Token`, `playerToken`, `jwt`...
const SENSITIVE_KEYS = ['authorization', 'cookie', 'password', 'token', 'jwt', 'secret'];
const DEFAULT_MAX_FIELD_LENGTH = 500;

const useColor = () => process.env.NO_COLOR !== '1';
const color = (value, name) => (useColor() && COLORS[name] ? `${COLORS[name]}${value}${COLORS.reset}` : value);

const isJsonFormat = () => {
  const configured = String(process.env.LOG_FORMAT || '').toLowerCase();
  if (configured === 'json') return true;
  if (configured === 'pretty') return false;
  // Mặc định: chỉ `development` mới in dạng người đọc. `config.env` của node
  // deploy đặt NODE_ENV=deployment -> ra JSON, đúng thứ pm2/log aggregator cần.
  return process.env.NODE_ENV !== 'development';
};

const threshold = () => {
  const configured = String(process.env.LOG_LEVEL || '').toLowerCase();
  if (LEVELS[configured] !== undefined) return LEVELS[configured];
  return process.env.NODE_ENV === 'development' ? LEVELS.debug : LEVELS.info;
};

const shouldRedact = (key = '') => SENSITIVE_KEYS.some((sensitive) => key.toLowerCase().includes(sensitive));

const truncate = (value, max = DEFAULT_MAX_FIELD_LENGTH) => {
  if (typeof value !== 'string') return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}...<truncated ${value.length - max} chars>`;
};

// KHÔNG stringify thẳng input từ ngoài:
//   - Error có message/stack non-enumerable -> JSON.stringify ra "{}"
//   - Buffer thành mảng byte khổng lồ (một chunk upload 30 MiB = log 30 MiB)
//   - object lồng nhau có thể vòng lặp -> throw giữa lúc đang log
const sanitize = (value, depth = 0) => {
  if (value === null || value === undefined) return value;
  if (depth > 4) return '[MaxDepth]';
  if (value instanceof Error) {
    return { name: value.name, message: truncate(value.message), code: value.code, apiCode: value.apiCode };
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'string') return truncate(value);
  if (typeof value !== 'object') return value;

  return Object.entries(value).reduce((acc, [key, entry]) => {
    acc[key] = shouldRedact(key) ? '[REDACTED]' : sanitize(entry, depth + 1);
    return acc;
  }, {});
};

const safeStringify = (value) => {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `"[Unserializable: ${error.message}]"`;
  }
};

// `event` là tuỳ chọn: chỉ các mốc nghiệp vụ mới có. Log kỹ thuật thường
// (debug, cảnh báo) chỉ cần `message`.
const emit = (level, scope, message, meta, event) => {
  if (LEVELS[level] < threshold()) return;

  const requestId = requestContext.getRequestId();
  const safeMeta = meta === undefined ? undefined : sanitize(meta);

  if (isJsonFormat()) {
    const line = safeStringify({
      time: new Date().toISOString(),
      level,
      // Bỏ hẳn field khi ngoài request scope — xem mục 2 ở đầu file.
      ...(requestId ? { requestId } : {}),
      scope,
      ...(event ? { event } : {}),
      message,
      ...(safeMeta !== undefined ? { meta: safeMeta } : {}),
    });
    (level === 'error' ? console.error : console.log)(line);
    return;
  }

  const head = color(`[${requestId || '-'}] ${level.toUpperCase().padEnd(5)} ${scope}`, LEVEL_COLOR[level] || 'gray');
  const tail = safeMeta === undefined ? '' : color(` ${safeStringify(safeMeta)}`, 'gray');
  (level === 'error' ? console.error : console.log)(`${head} ${message}${tail}`);
};

// `child('uploadSession')` cho ra logger đã gắn scope, để call site chỉ còn
// `log.info('chunk accepted', {...})` thay vì lặp tên module mỗi dòng.
const child = (scope) =>
  Object.freeze({
    scope,
    debug: (message, meta) => emit('debug', scope, message, meta),
    info: (message, meta) => emit('info', scope, message, meta),
    warn: (message, meta) => emit('warn', scope, message, meta),
    error: (message, meta) => emit('error', scope, message, meta),

    // Mốc nghiệp vụ. Tên PHẢI theo `<domain>.<object>.<outcome>`:
    //   upload.chunk.accepted · replication.folder.sent · encode.job.failed
    // Đây là quy ước đã có sẵn ở `utils/operationLog.js`, nay thành luật.
    event: (name, fields) => emit('info', scope, name, fields, name),

    child: (suffix) => child(`${scope}.${suffix}`),
  });

module.exports = Object.freeze({
  LEVELS,
  child,
  sanitize,
  truncate,
  isJsonFormat,
  threshold,
  debug: (scope, message, meta) => emit('debug', scope, message, meta),
  info: (scope, message, meta) => emit('info', scope, message, meta),
  warn: (scope, message, meta) => emit('warn', scope, message, meta),
  error: (scope, message, meta) => emit('error', scope, message, meta),
  event: (scope, name, fields) => emit('info', scope, name, fields, name),
});
