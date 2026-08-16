'use strict';

// =============================================================================
// nodeAuth — xác thực giữa các thành phần của hệ thống bằng HMAC dùng chung khoá.
//
// BẢN THAM CHIẾU. `Stream-Central-Server/backend/utils/nodeAuth.js` là bản sao
// PHẢI KHỚP TỪNG BYTE của chuỗi canonical — lệch một dấu `\n` là mọi chữ ký sai
// mà không có triệu chứng nào ngoài "401 hết".
//
// -----------------------------------------------------------------------------
// 1. Lỗ hổng đang có
// -----------------------------------------------------------------------------
// `POST /api/v2/uploads/chunks`, `/api/v2/replications/*` và `/api/v2/playback/*`
// hiện KHÔNG xác thực gì. Ai tới được cổng 80 của node đều:
//   - ghi file tuỳ ý vào `videos/`,
//   - ra lệnh cho node đẩy cả thư mục media sang một host bất kỳ,
//   - chặn phát toàn bộ nội dung.
// Contract v2 §6 đã ghi nhận đây là "hardening tiếp theo".
//
// -----------------------------------------------------------------------------
// 2. Vì sao HMAC shared-secret, không phải mTLS
// -----------------------------------------------------------------------------
// mTLS đúng hơn về mặt bảo mật, nhưng kéo theo quản lý CA và xoay vòng chứng chỉ
// trên nhiều VM ở nhiều nhà cung cấp. Chi phí vận hành đó lớn hơn nhiều so với
// mức rủi ro hiện tại (hệ thống nội bộ, cổng 9100 không mở firewall). HMAC cho
// 90% giá trị với 5% chi phí, và đổi sang mTLS sau này không phải bỏ đi gì —
// nó nằm ở tầng vận chuyển, độc lập với tầng này.
//
// -----------------------------------------------------------------------------
// 3. HAI loại chữ ký, vì có HAI loại người gọi
// -----------------------------------------------------------------------------
// Đây là điểm dễ làm sai nhất khi thiết kế phần này.
//
//   (a) NODE-TO-NODE — Central → Sub, Sub → Sub.
//       Cả hai bên đều giữ được bí mật. Ký từng request, có timestamp chống
//       phát lại.  ->  signRequest / verifyRequest
//
//   (b) FE → SUB (upload chunk).
//       FE là TRÌNH DUYỆT. Nó KHÔNG được và KHÔNG THỂ giữ khoá bí mật — nhét
//       khoá vào JS là công khai khoá. Nhưng chunk lại đi THẲNG từ FE tới Sub,
//       không qua Central (contract v2 §3), nên Sub không thể hỏi lại Central
//       cho từng chunk.
//
//       Cách giải: Central ký SẴN danh tính của phiên upload rồi phát cho FE
//       trong upload session; FE chỉ chuyển tiếp chuỗi đó như một token mờ. Sub
//       verify bằng khoá chung. FE không bao giờ chạm vào bí mật, mà vẫn không
//       tự bịa được `storageKey` hay `chunkCount`.
//       ->  signUploadSession / verifyUploadSession
//
// Áp (a) cho endpoint FE gọi sẽ làm hỏng mọi lần upload; áp (b) cho node-to-node
// thì mất chống phát lại. Không hoán đổi được.
//
// -----------------------------------------------------------------------------
// 4. Vì sao KHÔNG ký body
// -----------------------------------------------------------------------------
// Body là file hàng chục MiB. Băm lại toàn bộ là nhân đôi I/O trên đúng đường
// nóng nhất của việc nhận dữ liệu. Ký metadata đủ để chặn "người lạ tự tạo
// job"; chống sửa nội dung trên đường truyền là việc của checksum từng file
// (vẫn đang là backlog) và của TLS.
// =============================================================================

const crypto = require('crypto');

const MODES = Object.freeze({ OFF: 'off', LOG: 'log', ENFORCE: 'enforce' });

const SCHEME = 'v1';

// Cửa sổ chấp nhận lệch đồng hồ giữa hai node. Lệch giờ giữa VM khác zone là
// nguyên nhân false-reject phổ biến nhất khi bật xác thực có timestamp — cùng
// lý do `services/authService.js` đã có `AUTH_CLOCK_SKEW`.
const DEFAULT_SKEW_SEC = 300;

const mode = () => {
  const raw = String(process.env.NODE_AUTH_MODE || MODES.OFF).trim().toLowerCase();
  return raw === MODES.LOG || raw === MODES.ENFORCE ? raw : MODES.OFF;
};

const secret = () => String(process.env.NODE_SHARED_SECRET || '');

const skewSec = () => {
  const parsed = Number(process.env.NODE_AUTH_SKEW || DEFAULT_SKEW_SEC);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SKEW_SEC;
};

// So sánh chống timing attack. `crypto.timingSafeEqual` ném khi hai buffer khác
// độ dài, nên phải chặn trước — và chặn theo cách không tiết lộ gì thêm.
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const hmac = (payload) => crypto.createHmac('sha256', secret()).update(payload, 'utf8').digest('hex');

// -----------------------------------------------------------------------------
// (a) NODE-TO-NODE
// -----------------------------------------------------------------------------

/**
 * Chuỗi canonical. THỨ TỰ VÀ DẤU PHÂN CÁCH LÀ MỘT PHẦN CỦA CONTRACT.
 *
 * Dùng '\n' làm dấu phân cách chứ không phải ':' hay '|' vì `\n` không xuất
 * hiện được trong bất kỳ thành phần nào (path đã percent-encode, id đã qua
 * regex token). Dấu phân cách có thể xuất hiện trong dữ liệu sẽ mở đường cho
 * tấn công ghép chuỗi: ("a:b", "c") và ("a", "b:c") băm ra cùng một giá trị.
 */
const canonicalRequest = ({ method, path: requestPath, contractVersion, primaryId, timestamp }) =>
  [
    String(method || '').toUpperCase(),
    String(requestPath || '').split('?')[0],
    String(contractVersion || ''),
    String(primaryId || ''),
    String(timestamp || ''),
  ].join('\n');

const signRequest = ({ method, path: requestPath, contractVersion, primaryId, nodeId, timestamp }) => {
  const ts = timestamp || Math.floor(Date.now() / 1000);
  const signature = hmac(canonicalRequest({ method, path: requestPath, contractVersion, primaryId, timestamp: ts }));
  return {
    'X-Node-Id': String(nodeId || ''),
    'X-Node-Ts': String(ts),
    'X-Node-Auth': `${SCHEME}=${signature}`,
  };
};

const DENY = Object.freeze({
  NO_SECRET: 'no-shared-secret',
  NO_SIGNATURE: 'no-signature',
  BAD_SCHEME: 'bad-scheme',
  BAD_TIMESTAMP: 'bad-timestamp',
  EXPIRED: 'timestamp-outside-window',
  BAD_SIGNATURE: 'bad-signature',
});

/**
 * Trả `{ allow, enforced, mode, reason, nodeId }`. KHÔNG BAO GIỜ throw.
 *
 * `allow` đã tính sẵn theo mode: ở `off`/`log` luôn true. Caller chỉ cần đọc
 * `allow`, không phải tự suy luận theo mode — đúng khuôn `authService`.
 */
const verifyRequest = ({ method, path: requestPath, contractVersion, primaryId, headers = {} }) => {
  const currentMode = mode();
  const decide = (reason) => ({
    allow: reason === 'ok' || currentMode !== MODES.ENFORCE,
    enforced: currentMode === MODES.ENFORCE,
    mode: currentMode,
    reason,
    nodeId: headers['x-node-id'] || null,
  });

  if (currentMode === MODES.OFF) return decide('ok');

  // Bật enforce mà quên đặt khoá sẽ chặn sạch hệ thống. Trả lý do riêng để
  // người vận hành nhìn log là biết ngay, thay vì đi tìm chữ ký sai.
  if (!secret()) return decide(DENY.NO_SECRET);

  const provided = String(headers['x-node-auth'] || '');
  if (!provided) return decide(DENY.NO_SIGNATURE);

  const [scheme, signature] = provided.split('=');
  if (scheme !== SCHEME || !signature) return decide(DENY.BAD_SCHEME);

  const timestamp = Number(headers['x-node-ts']);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return decide(DENY.BAD_TIMESTAMP);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > skewSec()) return decide(DENY.EXPIRED);

  const expected = hmac(canonicalRequest({ method, path: requestPath, contractVersion, primaryId, timestamp }));
  if (!safeEqual(expected, signature)) return decide(DENY.BAD_SIGNATURE);

  return decide('ok');
};

// -----------------------------------------------------------------------------
// (b) UPLOAD SESSION — Central ký, FE chuyển tiếp, Sub verify
// -----------------------------------------------------------------------------

/**
 * Ràng buộc ĐÚNG những gì Sub sẽ tin từ header của FE.
 *
 * Không có `chunkCount` trong chữ ký thì FE sửa được `X-Chunk-Count` và điều
 * khiển được thời điểm Sub coi là "đủ chunk" — tức là ép Sub ghép file dở dang
 * rồi đem đi encode.
 *
 * Không có `expiresAt` thì một session rò rỉ dùng được vĩnh viễn.
 */
const canonicalUploadSession = ({ uploadId, storageKey, extension, chunkCount, videoId, expiresAt }) =>
  [
    'upload',
    String(uploadId || ''),
    String(storageKey || ''),
    String(extension || ''),
    String(chunkCount || ''),
    String(videoId || ''),
    String(expiresAt || ''),
  ].join('\n');

const signUploadSession = ({ uploadId, storageKey, extension, chunkCount, videoId, ttlSeconds = 24 * 3600 }) => {
  // TTL rộng có chủ đích: người dùng upload phim vài GB qua mạng chậm có thể
  // mất nhiều giờ, và session hết hạn giữa chừng là mất trắng cả lần upload.
  // Đây KHÔNG phải token phát video (thứ cần TTL ngắn vì rò rỉ là xem được) —
  // rò rỉ token upload chỉ cho phép ghi vào đúng một storageKey đã được cấp.
  const expiresAt = Math.floor(Date.now() / 1000) + Number(ttlSeconds);
  const signature = hmac(canonicalUploadSession({ uploadId, storageKey, extension, chunkCount, videoId, expiresAt }));
  return `${SCHEME}.${expiresAt}.${signature}`;
};

const verifyUploadSession = (token, { uploadId, storageKey, extension, chunkCount, videoId }) => {
  const currentMode = mode();
  const decide = (reason) => ({
    allow: reason === 'ok' || currentMode !== MODES.ENFORCE,
    enforced: currentMode === MODES.ENFORCE,
    mode: currentMode,
    reason,
  });

  if (currentMode === MODES.OFF) return decide('ok');
  if (!secret()) return decide(DENY.NO_SECRET);

  const raw = String(token || '');
  if (!raw) return decide(DENY.NO_SIGNATURE);

  const [scheme, expiresRaw, signature] = raw.split('.');
  if (scheme !== SCHEME || !expiresRaw || !signature) return decide(DENY.BAD_SCHEME);

  const expiresAt = Number(expiresRaw);
  if (!Number.isInteger(expiresAt)) return decide(DENY.BAD_TIMESTAMP);
  // Không cộng skew ở đây: TTL đã tính bằng giờ, vài trăm giây lệch đồng hồ
  // không đáng kể so với nó.
  if (Math.floor(Date.now() / 1000) > expiresAt) return decide(DENY.EXPIRED);

  const expected = hmac(canonicalUploadSession({ uploadId, storageKey, extension, chunkCount, videoId, expiresAt }));
  if (!safeEqual(expected, signature)) return decide(DENY.BAD_SIGNATURE);

  return decide('ok');
};

module.exports = Object.freeze({
  MODES,
  SCHEME,
  DENY,
  DEFAULT_SKEW_SEC,
  mode,
  skewSec,
  hasSecret: () => Boolean(secret()),
  canonicalRequest,
  canonicalUploadSession,
  signRequest,
  verifyRequest,
  signUploadSession,
  verifyUploadSession,
});
