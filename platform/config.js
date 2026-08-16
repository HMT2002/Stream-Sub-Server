'use strict';

// =============================================================================
// config — đọc và kiểm tra biến môi trường MỘT LẦN, ở MỘT CHỖ.
//
// -----------------------------------------------------------------------------
// 1. Vấn đề đang có
// -----------------------------------------------------------------------------
// `process.env` đang được đọc rải rác, mỗi chỗ một kiểu và không chỗ nào kiểm tra:
//
//   process.env.JITTER            modules/heartbeatAPI.js — dùng làm SỐ nhưng là CHUỖI.
//                                 `10000 - "10"` chạy được nhờ ép kiểu ngầm của
//                                 toán tử `-`; đổi thành `+` là sai lặng lẽ.
//   process.env.ENCODE_TYPE       modules/encodeAPI.js — `Number(undefined)` = NaN
//                                 -> rơi vào nhánh `default:` (dùng chung với
//                                 case 8 = libx264/CPU) thay vì case 7 = NVENC.
//                                 Không có lỗi, không có log; chỉ có encode chậm
//                                 gấp nhiều lần trên node có GPU.
//   process.env.JWT_SECRET        services/authService.js — thiếu thì jwt.verify
//                                 ném lỗi ở TỪNG segment, không phải lúc boot.
//
// Điểm chung: **thiếu/sai biến môi trường chỉ lộ ra lúc chạy nghiệp vụ**, tức là
// sau khi đã nhận file của người dùng. Đó là lúc tệ nhất để phát hiện.
//
// -----------------------------------------------------------------------------
// 2. Vì sao lazy + cache, không đọc lúc require
// -----------------------------------------------------------------------------
// `server.js` gọi `dotenv.config()` RỒI mới `require('./app')`. Nhưng test lại
// require thẳng service mà không qua `server.js`. Nếu module này đọc env ngay
// lúc require thì thứ tự đó quyết định kết quả — một dạng lỗi rất khó nhìn ra.
// Vì vậy: đọc lần đầu khi `get()` được gọi, rồi cache. `reload()` cho test.
//
// -----------------------------------------------------------------------------
// 3. Vì sao KHÔNG tự động chết khi thiếu biến
// -----------------------------------------------------------------------------
// `assertRequired()` được gọi TƯỜNG MINH từ `server.js`. Module bị require trong
// test/script vận hành thì không nên tự kết thúc tiến trình.
//
// PHASE 0: file này CHƯA được các module cũ dùng — chúng vẫn đọc `process.env`
// như trước, để Phase 0 giữ đúng cam kết "không đổi hành vi". Code mới dùng nó
// ngay; các module cũ chuyển dần ở Phase 1.
// =============================================================================

const path = require('path');

const str = (name, fallback = '') => {
  const value = process.env[name];
  return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
};

// Biến KHÔNG được đặt phải ra `fallback`, không phải 0. `Number('')` là 0 —
// đúng cái bẫy làm `ENCODE_TYPE` thiếu trông như đã đặt và `inspect()` im lặng.
const num = (name, fallback) => {
  const raw = str(name, '');
  if (raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// `on`/`true`/`1` là bật. Giữ đúng cách `services/authService.js` đang hiểu
// AUTH_BIND_IP, để hai chỗ không diễn giải cùng một giá trị theo hai kiểu.
const bool = (name, fallback = false) => {
  const value = str(name, '').toLowerCase();
  if (value === '') return fallback;
  return value === 'on' || value === 'true' || value === '1';
};

const oneOf = (name, allowed, fallback) => {
  const value = str(name, '').toLowerCase();
  return allowed.includes(value) ? value : fallback;
};

const build = () => {
  const nodeEnv = str('NODE_ENV', 'development');
  // Mặc định 1/100/9000 để công thức cổng ra đúng 9100 khi thiếu env — khớp
  // nhánh `|| 9100` của `server.js` cũ, nên đổi sang config không đổi cổng.
  const serverIndex = num('SERVERINDEX', 1);
  const serverRep = num('SERVERREP', 100);
  const basePort = num('PORT', 9000);

  return Object.freeze({
    nodeEnv,
    isDevelopment: nodeEnv === 'development',

    // Cùng công thức với `server.js` — giữ nguyên để không đổi cổng đang chạy.
    port: basePort + serverIndex * serverRep || 9100,
    serverIndex,
    serverRep,

    // Định danh node. `SERVERINDEX` là số thứ tự cục bộ, KHÔNG phải id toàn cục;
    // Central định danh node bằng `_id` của Mongo. `NODE_ID` là chỗ để đặt id
    // hai bên cùng hiểu — xem mục 4.6 của sub-node-code-standardization-draft.md.
    nodeId: str('NODE_ID', '') || `legacy:sub-${serverIndex}`,

    centralApi: str('CENTRAL_API', 'http://localhost:9000').replace(/\/+$/, ''),
    // Địa chỉ Sub gửi callback kết quả encode về. Xem `encode.callbackUrl`.
    centralCallbackUrl: (str('CENTRAL_CALLBACK_URL', '') || str('CENTRAL_API', 'http://localhost:9000')).replace(/\/+$/, ''),

    jwtSecret: str('JWT_SECRET', ''),
    jwtExpiresIn: str('JWT_EXPIRES_IN', '90d'),

    auth: Object.freeze({
      mode: oneOf('AUTH_MODE', ['off', 'log', 'enforce'], 'off'),
      clockSkewSec: num('AUTH_CLOCK_SKEW', 30),
      bindIp: bool('AUTH_BIND_IP', false),
    }),

    // Danh tính node theo cách Central hiểu. `SERVER_ID` là `_id` của bản ghi
    // `Server` trong MongoDB của Central — đặt được nó thì node lên `active`
    // ngay; thiếu thì Central phải suy từ `publicURL` + `port`, và nếu cũng
    // không có thì node ở lại `suspect` mãi dù chạy hoàn toàn bình thường
    // (`contracts/heartbeat-v2.md` bên Central).
    serverId: str('SERVER_ID', '') || null,
    publicUrl: str('PUBLIC_URL', '') || null,
    publicPort: str('PUBLIC_PORT', '') || null,

    heartbeat: Object.freeze({
      // `app.js` cũ bật heartbeat khi NODE_ENV === 'development' — ĐIỀU KIỆN
      // NGƯỢC: node deploy (NODE_ENV=deployment) không bao giờ gửi heartbeat.
      // Nay mặc định BẬT, tắt tường minh bằng HEARTBEAT_ENABLED=off.
      enabled: bool('HEARTBEAT_ENABLED', true),
      intervalMs: num('HEARTBEAT_INTERVAL_MS', 10000),
      jitterMs: num('JITTER', 10),
    }),

    encode: Object.freeze({
      // --- Callback kết quả encode (contract `stream-encode-v1`) --------------
      // `CENTRAL_CALLBACK_URL` TÁCH RIÊNG khỏi `CENTRAL_API` có chủ đích, dù
      // mặc định trùng nhau. Hai biến trả lời hai câu hỏi khác nhau:
      //
      //   CENTRAL_API          "Sub gọi Central ở đâu cho việc thường?"
      //   CENTRAL_CALLBACK_URL "Kết quả encode gửi về đâu?"
      //
      // Chúng tách nhau ra ngay khi có nhu cầu thật:
      //   - test: trỏ callback vào một collector cục bộ để xem payload mà không
      //     cần dựng cả Central;
      //   - deploy nhiều vùng: Central có địa chỉ nội bộ khác địa chỉ public;
      //   - Central đứng sau load balancer nhưng callback cần đi thẳng vào một
      //     instance có DB.
      // Gộp chung thì mỗi lần cần một trong ba thứ trên là phải sửa code.
      callbackEnabled: bool('ENCODE_CALLBACK', true),
      callbackUrl: str('CENTRAL_CALLBACK_URL', '') || str('CENTRAL_API', 'http://localhost:9000'),
      callbackPath: str('ENCODE_CALLBACK_PATH', '/api/v2/nodes/jobs/result'),
      // Không có fallback ngầm: ENCODE_TYPE sai thì `assertRequired` phải kêu,
      // chứ không được lặng lẽ sinh ra lệnh ffmpeg rỗng.
      type: num('ENCODE_TYPE', NaN),
      concurrency: Math.max(1, num('ENCODE_CONCURRENCY', 1)),
    }),

    // Node có tự phục vụ file media không. MẶC ĐỊNH KHÔNG — nginx `:9150` là
    // đường phát duy nhất, vì chỉ đường đó mới đi qua `auth_request` và do đó
    // qua danh sách chặn của `services/playbackBlockService`. Xem
    // `middleware/dataPlaneGuard.js`.
    mediaServing: bool('MEDIA_SERVING', false),

    storage: Object.freeze({
      // Đường dẫn tuyệt đối, KHÔNG phụ thuộc CWD. Xem `storage/paths.js`.
      mediaRoot: path.resolve(str('MEDIA_ROOT', path.resolve(__dirname, '..', 'videos'))),
    }),

    log: Object.freeze({
      level: oneOf('LOG_LEVEL', ['debug', 'info', 'warn', 'error', 'silent'], nodeEnv === 'development' ? 'debug' : 'info'),
      format: oneOf('LOG_FORMAT', ['json', 'pretty'], nodeEnv === 'development' ? 'pretty' : 'json'),
    }),
  });
};

let cached = null;

const get = () => {
  if (!cached) cached = build();
  return cached;
};

const reload = () => {
  cached = null;
  return get();
};

// Danh sách biến mà THIẾU là node chạy sai chứ không phải chạy thiếu tính năng.
const REQUIRED = Object.freeze([
  {
    name: 'JWT_SECRET',
    check: (c) => c.jwtSecret.length > 0,
    why: 'authService.verifyPlaybackToken() sẽ ném lỗi ở TỪNG segment thay vì lúc boot',
  },
  {
    name: 'ENCODE_TYPE',
    check: (c) => Number.isFinite(c.encode.type),
    why: 'thiếu thì rơi vào nhánh default (case 8 = libx264/CPU) thay vì encoder đã chọn — im lặng, chỉ lộ ra ở thời gian encode',
  },
  {
    name: 'CENTRAL_API',
    check: (c) => /^https?:\/\//.test(c.centralApi),
    why: 'heartbeat và callback kết quả encode không biết gửi đi đâu',
  },
]);

// Trả về danh sách vấn đề thay vì throw ngay: caller quyết định là chết hay chỉ
// cảnh báo. `server.js` chọn chết; test chọn đọc.
const inspect = () => {
  const current = get();
  return REQUIRED.filter((rule) => !rule.check(current)).map((rule) => `${rule.name}: ${rule.why}`);
};

const assertRequired = () => {
  const problems = inspect();
  if (problems.length) {
    throw new Error(`Cấu hình không hợp lệ trong config.env:\n  - ${problems.join('\n  - ')}`);
  }
  return get();
};

module.exports = Object.freeze({ get, reload, inspect, assertRequired, REQUIRED, _private: { str, num, bool, oneOf } });
