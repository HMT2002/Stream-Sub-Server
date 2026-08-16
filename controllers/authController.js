'use strict';

// =============================================================================
// authController — tầng HTTP cho việc xác thực phát video.
//
// Endpoint quan trọng nhất: `AuthRequest` (GET /api/auth/verify), được nginx gọi
// qua `auth_request /__auth;` trong khối server :9150.
//
// HỢP ĐỒNG VỚI NGINX (đọc kỹ trước khi sửa) — theo ngx_http_auth_request_module:
//   1. nginx tạo SUBREQUEST nội bộ, luôn dùng method GET, luôn `header_only`.
//      => BODY CỦA RESPONSE BỊ VỨT ĐI. Trả JSON đẹp ở đây là lãng phí băng thông
//         nội bộ; chỉ STATUS CODE và HEADER là có tác dụng.
//   2. 2xx = cho phép · 401/403 = từ chối (nginx trả đúng mã đó cho client)
//      · mọi mã khác = nginx coi là lỗi và trả 500.
//      => tuyệt đối KHÔNG để exception lọt ra globalErrorHandler (nó trả 500).
//   3. Header của request gốc được kế thừa sang subrequest, nên X-Player-Token
//      đọc được trực tiếp. Nhưng URI gốc thì KHÔNG — subrequest mang URI
//      /api/auth/verify. Vì vậy nginx phải gửi kèm `X-Original-URI $request_uri`.
//
// Chọn 204 (No Content) thay vì 200 cho nhánh cho phép: cùng là 2xx với nginx,
// nhưng nói rõ "không có body" và tránh mọi chi phí serialize.
// =============================================================================

const authService = require('../services/authService');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');

// Bộ đếm in-memory phục vụ giai đoạn AUTH_MODE=log: đo xem nếu bật enforce thì
// bao nhiêu request sẽ bị chặn, và bị chặn vì lý do gì. Không có nó thì việc
// chuyển log -> enforce chỉ là đoán mò.
const stats = {
  startedAt: new Date().toISOString(),
  total: 0,
  allowed: 0,
  wouldDeny: 0, // bị chặn khi ở mode log (thực tế vẫn cho qua)
  denied: 0, // bị chặn thật khi ở mode enforce
  byReason: Object.create(null),
};

// Header chỉ được chứa ASCII in được (RFC 9110 §5.5 — giá trị ngoài US-ASCII
// phải mã hoá, xem markdowns/http-header-non-ascii-encoding.md). sessionID do
// client/Central đưa vào nên phải lọc trước khi phản chiếu ra header, nếu không
// một sessionID có dấu tiếng Việt sẽ làm hỏng response.
const headerSafe = (value) => String(value || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);

exports.AuthRequest = (req, res) => {
  let result;
  try {
    result = authService.verifyPlaybackToken({
      headers: req.headers,
      ip: req.ip,
      method: req.method,
    });
  } catch (e) {
    // Lưới an toàn cuối cùng. verifyPlaybackToken đã cam kết không throw, nhưng
    // nếu có lỗi lập trình lọt ra thì vẫn phải trả 401 (từ chối rõ ràng) thay vì
    // để 500 — 500 khiến nginx không phân biệt được "chặn" với "auth chết".
    // Muốn đổi sang fail-open ở tầng hạ tầng thì làm bằng `error_page 500 502
    // 503 504 = @serve;` bên nginx, đừng làm ở đây.
    console.error('authController.AuthRequest unexpected error:', e && e.message);
    res.setHeader('X-Auth-Reason', 'internal-error');
    res.status(401).end();
    return;
  }

  stats.total += 1;
  stats.byReason[result.reason] = (stats.byReason[result.reason] || 0) + 1;

  res.setHeader('X-Auth-Mode', result.mode);
  res.setHeader('X-Auth-Reason', result.reason);
  if (result.claims && result.claims.sessionID) {
    // nginx bắt lại bằng `auth_request_set $auth_session $upstream_http_x_auth_session;`
    // rồi đưa vào log_format -> truy vết được từng phiên xem trong access.log.
    res.setHeader('X-Auth-Session', headerSafe(result.claims.sessionID));
  }

  if (result.reason === authService.ALLOW.reason) {
    stats.allowed += 1;
    res.status(204).end();
    return;
  }

  if (!result.enforced) {
    // Mode `log`: đếm rồi vẫn cho qua. Lý do ghi ra stderr chứ không phải stdout
    // để không trộn vào log ứng dụng thường.
    stats.wouldDeny += 1;
    console.warn(`[auth:log] would deny ${result.code} ${result.reason} uri=${req.headers['x-original-uri'] || '-'}`);
    res.status(204).end();
    return;
  }

  stats.denied += 1;
  res.status(result.code).end();
};

// GET /api/auth/stats — xem nhanh trước khi quyết định bật enforce.
exports.AuthStats = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'ok',
    mode: authService.mode(),
    ...stats,
  });
});

// -----------------------------------------------------------------------------
// Dưới đây là 2 export mà `routes/authRoute.js` đã tham chiếu từ trước nhưng
// CHƯA TỪNG TỒN TẠI (file controllers/authController.js không có trong repo).
// Route đó không được mount trong app.js nên `require` chưa bao giờ chạy — lỗi
// nằm im. Nay mount route thật nên phải có đủ, nếu không app crash lúc khởi động.
// -----------------------------------------------------------------------------

// Middleware dùng cho route Node thường (không phải nginx): chặn tại chỗ.
exports.protect = (req, res, next) => {
  const result = authService.verifyPlaybackToken({
    uri: req.originalUrl,
    headers: req.headers,
    ip: req.ip,
    method: req.method,
  });
  if (result.allow) {
    req.playbackClaims = result.claims;
    return next();
  }
  return next(new AppError(`playback denied: ${result.reason}`, result.code));
};

exports.Check = catchAsync(async (req, res) => {
  res.status(200).json({
    status: 'ok',
    mode: authService.mode(),
    claims: req.playbackClaims || null,
  });
});
