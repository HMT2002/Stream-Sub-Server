'use strict';

// =============================================================================
// authService — logic xác thực request phát video (playback token).
//
// TÁCH KHỎI EXPRESS CÓ CHỦ ĐÍCH: hàm chính `verifyPlaybackToken()` chỉ nhận
// object thuần (uri/headers/ip/method) và trả object thuần, không đụng req/res.
// Lý do: nó được gọi từ 2 chỗ khác nhau (endpoint /__auth cho nginx auth_request,
// và có thể dùng lại làm middleware cho route Node) và cần test được bằng
// `node --test` mà không phải dựng HTTP server.
//
// RÀNG BUỘC HIỆU NĂNG: hàm này chạy MỖI SEGMENT. Một phiên xem 2 tiếng với
// segment 4s = ~1800 lần/người xem. Vì vậy tuyệt đối:
//   - KHÔNG I/O đĩa (không fs.existsSync — việc kiểm tra file có tồn tại là của
//     `try_files` trong nginx, làm lại ở đây là nhân đôi syscall vô ích).
//   - KHÔNG gọi mạng / DB. Mọi thứ phải là CPU thuần (HMAC verify ~vài chục µs).
//   - KHÔNG console.log ở nhánh cho phép (log mỗi segment sẽ ngốn I/O hơn cả
//     việc xác thực).
// =============================================================================

const jwt = require('jsonwebtoken');
const blacklist = require('../globals/blacklist');
const playbackBlocks = require('./playbackBlockService');

// --- Chế độ hoạt động ---------------------------------------------------------
// off     : luôn cho qua (204). Dùng khi chưa phát token ở Central — giữ nguyên
//           hành vi hiện tại của hệ thống, không làm vỡ gì.
// log     : VẪN cho qua, nhưng tính/ghi lại các trường hợp lẽ ra bị chặn.
//           Đây là bước bắt buộc trước khi bật enforce ở hệ thống OTT thật:
//           đo tỉ lệ false-reject (player cũ, token hết hạn do lệch giờ...)
//           trên traffic thật thay vì đoán.
// enforce : chặn thật, trả 401/403.
const MODES = Object.freeze({ OFF: 'off', LOG: 'log', ENFORCE: 'enforce' });

// --- Bảng lý do từ chối --------------------------------------------------------
// `code` ở đây CHỈ được phép là 401 hoặc 403.
// nginx auth_request quy ước: 2xx = cho phép, 401/403 = từ chối (và trả đúng mã
// đó cho client), MỌI MÃ KHÁC = lỗi nội bộ -> nginx trả 500 cho client.
// Nên trả 400/404/429 ở đây là tự bắn vào chân: client nhận 500 mù mờ.
//   401 = "thiếu/hỏng credential" -> client XIN TOKEN MỚI rồi thử lại là được.
//   403 = "credential đọc được nhưng không có quyền" -> thử lại vô ích.
// Phân biệt đúng 2 nhóm này quan trọng vì player (dash.js) có retry policy khác
// nhau cho từng mã; trả 403 cho token hết hạn sẽ khiến player bỏ cuộc thay vì
// đi refresh token.
const DENY = Object.freeze({
  NO_TOKEN: { code: 401, reason: 'no-token' },
  BAD_SIGNATURE: { code: 401, reason: 'bad-signature' },
  EXPIRED: { code: 401, reason: 'expired' },
  NOT_YET_VALID: { code: 401, reason: 'not-yet-valid' },
  BAD_METHOD: { code: 403, reason: 'bad-method' },
  MALFORMED_URI: { code: 403, reason: 'malformed-uri' },
  RESOURCE_MISMATCH: { code: 403, reason: 'resource-mismatch' },
  SESSION_REVOKED: { code: 403, reason: 'session-revoked' },
  IP_MISMATCH: { code: 403, reason: 'ip-mismatch' },
  // [THÊM 2026-08-16] Chặn tường minh từ `services/playbackBlockService`.
  // Khác mọi lý do trên ở một điểm quyết định: nó KHÔNG phụ thuộc AUTH_MODE.
  BLOCKED: { code: 403, reason: 'blocked' },
});

const ALLOW = Object.freeze({ code: 204, reason: 'ok' });

const truthy = (value) => String(value || '').trim().toLowerCase() === 'on' ||
  String(value || '').trim().toLowerCase() === 'true' ||
  String(value || '').trim() === '1';

// [UPDATED 2026-08-16 Phase 2] Cache giá trị đã chuẩn hoá.
//
// Hàm này chạy MỖI SEGMENT (~1800 lần cho một phiên xem 2 tiếng, nhân số người
// xem đồng thời). Bản cũ mỗi lần gọi đều `String(...).trim().toLowerCase()` trên
// `process.env` — trong Node, đọc `process.env` KHÔNG phải đọc một object
// JavaScript thường mà là một lời gọi xuống môi trường tiến trình, đắt hơn đáng
// kể so với đọc biến. Ba phép biến đổi chuỗi nữa thì thành rác cấp phát liên tục
// trên đúng đường nóng nhất hệ thống.
//
// AN TOÀN VỚI CÁCH ĐỔI MODE ĐANG DÙNG: `AUTH_MODE` được đổi bằng
// `pm2 restart server --update-env`, tức là tiến trình mới — cache không bao giờ
// cũ. Vẫn để `resetCache()` cho test.
let cachedAuthMode = null;
let cachedAuthModeRaw = null;

const mode = () => {
  const raw = process.env.AUTH_MODE;
  if (raw === cachedAuthModeRaw) return cachedAuthMode;
  const normalized = String(raw || MODES.OFF).trim().toLowerCase();
  cachedAuthModeRaw = raw;
  cachedAuthMode = normalized === MODES.LOG || normalized === MODES.ENFORCE ? normalized : MODES.OFF;
  return cachedAuthMode;
};

// Cùng lý do: `jwt.verify` nhận `clockTolerance` mỗi lần gọi, và giá trị đó đến
// từ `process.env` ở bản cũ.
let cachedSkew = null;
let cachedSkewRaw = null;

const clockSkew = () => {
  const raw = process.env.AUTH_CLOCK_SKEW;
  if (raw === cachedSkewRaw) return cachedSkew;
  const parsed = Number(raw || 30);
  cachedSkewRaw = raw;
  cachedSkew = Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
  return cachedSkew;
};

// -----------------------------------------------------------------------------
// Lấy token. Hỗ trợ 3 nguồn vì mỗi loại client bị giới hạn khác nhau:
//   1. Header X-Player-Token — sạch nhất (không lọt vào access.log/referrer),
//      nhưng player phải sửa được request header. dash.js làm được qua
//      RequestModifier; <video src> thuần và nhiều smart TV thì KHÔNG.
//   2. Query ?token= — kém riêng tư hơn (ghi vào access.log, dính vào URL chia
//      sẻ) nhưng chạy với MỌI player. Đây là cách CDN thương mại dùng
//      (Akamai token auth, CloudFront signed URL) chính vì lý do tương thích.
//   3. Path /dash-token/<jwt>/... — dạng repo đang dùng sẵn ở videoController.
// Thứ tự ưu tiên: header > query > path (cụ thể hơn thì thắng).
// -----------------------------------------------------------------------------
const extractToken = (uri, headers = {}) => {
  const headerToken = headers['x-player-token'];
  if (headerToken) return String(headerToken).trim();

  const queryIndex = String(uri || '').indexOf('?');
  if (queryIndex > -1) {
    const params = new URLSearchParams(String(uri).slice(queryIndex + 1));
    const queryToken = params.get('token');
    if (queryToken) return queryToken.trim();
  }

  const match = String(uri || '').match(/\/dash-token\/([^/?]+)/);
  if (match) return match[1];

  return '';
};

// -----------------------------------------------------------------------------
// Chuẩn hoá URI gốc (nginx gửi qua header X-Original-URI = $request_uri, tức là
// CÒN NGUYÊN query string và còn percent-encoding).
// Trả '' nếu URI không hợp lệ -> gọi bên ngoài phải coi đó là từ chối, KHÔNG
// được coi là "không có ràng buộc path".
// -----------------------------------------------------------------------------
const normalizeUri = (rawUri) => {
  let value = String(rawUri || '');
  const queryIndex = value.indexOf('?');
  if (queryIndex > -1) value = value.slice(0, queryIndex);

  try {
    value = decodeURIComponent(value);
  } catch (e) {
    return ''; // percent-encoding hỏng (VD '%zz') -> coi như URI bẩn
  }

  // Chặn path traversal và NUL byte. nginx đã tự normalize '..' trước khi map
  // vào filesystem, NHƯNG token check chạy trên chuỗi thô: nếu không chặn ở đây
  // thì token cấp cho videos/A có thể kèm '..' để khớp prefix rồi trỏ sang B.
  if (value.includes('..') || value.includes('\0')) return '';

  return value.replace(/^\/+/, '').replace(/\/+/g, '/');
};

// Prefix tài nguyên mà token được phép chạm tới. Chấp nhận cả 2 dạng claim:
//   - `url`: chuỗi, dạng cũ đang dùng ở videoController ("videos/qBsLm06Dash")
//   - `acl`: mảng chuỗi, cho trường hợp 1 token mở nhiều thư mục (audio+video
//            tách folder, hoặc nhiều bitrate ladder)
// Hậu tố '*' = khớp theo prefix.
const aclOf = (claims) => {
  const raw = [];
  if (typeof claims.url === 'string') raw.push(claims.url);
  if (Array.isArray(claims.acl)) raw.push(...claims.acl.filter((e) => typeof e === 'string'));
  return raw.map((entry) => entry.replace(/^\/+/, '').replace(/\/+$/, ''));
};

const matchesAcl = (uriPath, acl) =>
  acl.some((entry) => {
    if (entry.endsWith('*')) return uriPath.startsWith(entry.slice(0, -1));
    return uriPath === entry || uriPath.startsWith(`${entry}/`);
  });

// So sánh IP có nới lỏng: chỉ so /24 (IPv4) vì client di động đổi IP giữa phiên
// là chuyện bình thường (CGNAT, chuyển 4G<->Wi-Fi). So khít tuyệt đối sẽ đá
// người dùng thật ra ngoài nhiều hơn là chặn được chia sẻ link.
const sameNetwork = (a, b) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const left = String(a).split('.');
  const right = String(b).split('.');
  if (left.length !== 4 || right.length !== 4) return false;
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
};

// -----------------------------------------------------------------------------
// Rút `storageKey` ra khỏi đường dẫn đã chuẩn hoá.
// URL contract: `videos/<storageKey>/init.mpd` -> `<storageKey>`.
// Đây là nguồn CHÍNH XÁC (đến từ URI thật), khác `sessionID` vốn là claim.
// -----------------------------------------------------------------------------
const storageKeyOf = (uriPath) => {
  if (!uriPath) return '';
  const segments = uriPath.split('/').filter(Boolean);
  if (segments[0] === 'videos') return segments[1] || '';
  // Đường `/dash-token/<jwt>/...` không mang storageKey ở URI — chặn theo
  // storageKey không áp dụng được cho nó (xem ghi chú ở `evaluateBlocks`).
  return segments[0] || '';
};

const firstClientIp = (headers, ip) => {
  const raw = headers['x-real-ip'] || headers['x-forwarded-for'] || ip || '';
  return String(raw).split(',')[0].trim();
};

// -----------------------------------------------------------------------------
// CHẶN TUYỆT ĐỐI — chạy TRƯỚC cả kiểm tra AUTH_MODE.
//
// Vì sao trước: `AUTH_MODE=off` và `log` đều luôn cho qua theo thiết kế. Nếu
// đặt kiểm tra này sau, Sub sẽ không chặn được gì trừ khi đã bật `enforce` cho
// TOÀN BỘ hệ thống từ trước — tức là phải chấp nhận rủi ro chặn nhầm hàng loạt
// người xem hợp lệ chỉ để chặn đúng một phiên.
//
// ĐỘ CHÍNH XÁC KHÔNG ĐỒNG ĐỀU, phải nói rõ:
//   - `storageKey` và `ip` lấy từ URI và từ kết nối -> CHÍNH XÁC, không giả được.
//   - `session` lấy từ claim trong token. Ở mode `off`/`log` token KHÔNG được
//     verify chữ ký (đó là định nghĩa của hai mode đó), nên ở đây dùng
//     `jwt.decode` không verify. Người cố tình né có thể tự sửa `sessionID`
//     trong token. Chấp nhận được vì ở `off`/`log` vốn không có bảo đảm nào cả;
//     còn ở `enforce` thì token phải qua chữ ký nên chặn theo session là chắc.
//     => Cần chặn CHẮC CHẮN ngay mà chưa bật enforce: chặn theo `storageKey`.
//
// Chi phí trên đường nóng: khi danh sách rỗng (bình thường), `hasBlocks()` chỉ
// là một phép so sánh số và hàm này thoát ngay.
// -----------------------------------------------------------------------------
const sessionIdOf = (originalUri, headers) => {
  const token = extractToken(originalUri, headers);
  if (!token) return '';
  try {
    const decoded = jwt.decode(token);
    return decoded && typeof decoded === 'object' ? String(decoded.sessionID || '') : '';
  } catch (e) {
    return '';
  }
};

const evaluateBlocks = ({ originalUri, uriPath, headers, ip }) => {
  if (!playbackBlocks.hasBlocks()) return null;
  return playbackBlocks.evaluate({
    sessionID: sessionIdOf(originalUri, headers),
    storageKey: storageKeyOf(uriPath),
    ip: firstClientIp(headers, ip),
  });
};

// -----------------------------------------------------------------------------
// HÀM CHÍNH.
// Trả về { allow, code, reason, claims, mode } — KHÔNG bao giờ throw.
// "Không bao giờ throw" là yêu cầu cứng: một exception lọt ra ngoài sẽ thành 500
// ở Express -> nginx dịch thành 500 cho client -> mất hẳn khả năng phân biệt
// "token sai" với "auth service hỏng".
// -----------------------------------------------------------------------------
const verifyPlaybackToken = ({ uri, headers = {}, ip = '', method = 'GET' } = {}) => {
  const currentMode = mode();
  const decide = (outcome, claims = null) => ({
    allow: outcome.code === ALLOW.code || currentMode !== MODES.ENFORCE,
    enforced: currentMode === MODES.ENFORCE,
    mode: currentMode,
    code: outcome.code,
    reason: outcome.reason,
    claims,
  });

  // --- Chặn tuyệt đối, độc lập AUTH_MODE ------------------------------------
  // `allow: false` được đặt CỨNG ở đây chứ không đi qua `decide()`, vì `decide`
  // cố ý cho qua khi mode khác `enforce` — đúng cho mọi lý do khác, sai cho cái
  // này.
  const rawUri = headers['x-original-uri'] || uri || '';
  const blockVerdict = evaluateBlocks({
    originalUri: rawUri,
    uriPath: normalizeUri(rawUri),
    headers,
    ip,
  });
  if (blockVerdict && blockVerdict.blocked) {
    return {
      allow: false,
      enforced: true, // chặn thật, bất kể mode
      mode: currentMode,
      code: DENY.BLOCKED.code,
      reason: DENY.BLOCKED.reason,
      claims: null,
      block: { id: blockVerdict.entry.id, type: blockVerdict.entry.type, reason: blockVerdict.entry.reason },
    };
  }

  if (currentMode === MODES.OFF) return decide(ALLOW);

  // Chỉ GET/HEAD mới có nghĩa trên data plane. (nginx tạo auth subrequest luôn
  // bằng GET, nên nhánh này chủ yếu bảo vệ khi service được gọi trực tiếp.)
  if (method !== 'GET' && method !== 'HEAD') return decide(DENY.BAD_METHOD);

  const originalUri = headers['x-original-uri'] || uri || '';
  const uriPath = normalizeUri(originalUri);
  if (!uriPath) return decide(DENY.MALFORMED_URI);

  const token = extractToken(originalUri, headers);
  if (!token) return decide(DENY.NO_TOKEN);

  let claims = null;
  try {
    claims = jwt.verify(token, process.env.JWT_SECRET, {
      // Lệch đồng hồ giữa Central (ký token) và Sub (verify) là nguyên nhân
      // false-reject phổ biến nhất khi bật token auth trên nhiều VM khác zone.
      clockTolerance: clockSkew(),
    });
  } catch (e) {
    if (e && e.name === 'TokenExpiredError') return decide(DENY.EXPIRED);
    if (e && e.name === 'NotBeforeError') return decide(DENY.NOT_YET_VALID);
    return decide(DENY.BAD_SIGNATURE);
  }

  if (!claims || typeof claims !== 'object') return decide(DENY.BAD_SIGNATURE);

  // Ràng buộc tài nguyên — kiểm tra QUAN TRỌNG NHẤT. Không có nó, token hợp lệ
  // của phim miễn phí mở được mọi phim trên node. Token KHÔNG có claim ràng
  // buộc nào thì coi như không hợp lệ (fail-closed), không phải "mở tất cả".
  const acl = aclOf(claims);
  if (acl.length === 0) return decide(DENY.RESOURCE_MISMATCH, claims);
  if (!matchesAcl(uriPath, acl)) return decide(DENY.RESOURCE_MISMATCH, claims);

  // Thu hồi phiên: dùng chung blacklist in-memory với /api/v1/streaming/stop-streaming.
  // GIỚI HẠN ĐÃ BIẾT: blacklist nằm trong RAM của đúng 1 process -> pm2 restart
  // là mất, và node khác không thấy. Muốn thu hồi thật ở quy mô nhiều node thì
  // phải chuyển sang store dùng chung (modules/redisAPI.js đã có sẵn khung).
  if (claims.sessionID) {
    const revoked = blacklist.blacklist.findIndex((e) => e && e.sessionID === claims.sessionID) > -1;
    if (revoked) return decide(DENY.SESSION_REVOKED, claims);
  }

  // Ghim IP — TẮT MẶC ĐỊNH. Bật khi cần chống chia sẻ link, chấp nhận đánh đổi
  // là người dùng đổi mạng giữa chừng sẽ bị đá (xem sameNetwork ở trên).
  if (truthy(process.env.AUTH_BIND_IP) && claims.ip) {
    const clientIp = headers['x-real-ip'] || headers['x-forwarded-for'] || ip;
    const first = String(clientIp || '').split(',')[0].trim();
    if (!sameNetwork(claims.ip, first)) return decide(DENY.IP_MISMATCH, claims);
  }

  return decide(ALLOW, claims);
};

module.exports = {
  MODES,
  DENY,
  ALLOW,
  mode,
  clockSkew,
  extractToken,
  normalizeUri,
  storageKeyOf,
  sessionIdOf,
  evaluateBlocks,
  aclOf,
  matchesAcl,
  verifyPlaybackToken,
};
