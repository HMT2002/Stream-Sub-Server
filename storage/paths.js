'use strict';

// =============================================================================
// paths — NƠI DUY NHẤT được ghép đường dẫn filesystem của Sub node.
//
// -----------------------------------------------------------------------------
// 1. Vì sao gom lại
// -----------------------------------------------------------------------------
// Trước đây có BỐN khái niệm "thư mục videos" khác nhau trong cùng một repo:
//
//   path.resolve(__dirname,'..','videos')   services/uploadSessionService.js   ← tuyệt đối
//   path.resolve(__dirname,'..','videos')   services/replicationService.js     ← tuyệt đối
//   'videos/'                               modules/multerAPI.js               ← theo CWD
//   'videos/' + filename                    controllers/deleteController.js    ← theo CWD
//   './' + req.url                          controllers/videoController.js     ← CWD + input người dùng
//   root /home/ubuntu/Stream-Sub-Server;    streamingVer3 (nginx)              ← tuyệt đối
//
// Hệ quả: chạy `node server.js` hoặc `pm2 start` với CWD khác thì một nửa repo
// tìm file ở chỗ này, nửa còn lại tìm ở chỗ khác — và triệu chứng là "file vừa
// upload xong lại không thấy", rất khó lần ra.
//
// -----------------------------------------------------------------------------
// 2. Vì sao assertInside nằm BÊN TRONG mỗi hàm
// -----------------------------------------------------------------------------
// `services/replicationService.js` có `safeStorageKey()`, nhưng
// `services/uploadSessionService.js` thì KHÔNG — nó tin `middleware/uploadContract`
// đã validate. Đúng trên đường HTTP thật, nhưng bảo đảm nằm ở FILE KHÁC: ai gọi
// service trực tiếp (test, script vận hành, code viết sau) là mất sạch bảo đảm đó.
//
// Ở đây validate là tính chất CỤC BỘ của hàm dựng đường dẫn. Không có đường nào
// tạo ra path mà không đi qua kiểm tra.
//
// -----------------------------------------------------------------------------
// 3. Hai gốc, hai vai trò
// -----------------------------------------------------------------------------
//   mediaRoot   = `videos/`      NỘI DUNG PHÁT ĐƯỢC. Là `root` của nginx :9150.
//   stagingRoot = `var/incoming/` FILE TẠM: .part.N, .accepted.json, .job.json
//
// > [SUPERSEDED 2026-08-16] Phase 0 để `stagingRoot` TRÙNG `mediaRoot` nhằm giữ
// > cam kết "không đổi hành vi".
// > [UPDATED 2026-08-16 Phase 2] Đã tách. `migrateLegacyStaging()` (cuối file,
// > gọi từ `server.js`) chuyển các file tạm còn sót sang chỗ mới lúc boot, nên
// > phiên upload đang dở dang lúc deploy không mất chunk.
//
// RÀNG BUỘC KHÔNG ĐƯỢC PHÁ: `mediaDir()` phải ra đúng `<repo>/videos/<storageKey>`,
// vì nginx `:9150` có `root <repo>` và URL contract là
// `http://<ip>:9150/videos/<storageKey>/init.mpd`. Đổi ở đây mà quên nginx thì
// `nginx -t` vẫn PASS và mọi video trả 404.
// =============================================================================

const fs = require('fs');
const path = require('path');
const AppError = require('../utils/appError');
const config = require('../platform/config');

// Token an toàn cho filesystem: chữ, số, dấu chấm, gạch dưới, gạch ngang.
// Cùng biểu thức đang dùng ở `middleware/uploadContract.js` và
// `middleware/replicationContract.js` — gom về một chỗ để ba nơi không lệch nhau.
const SAFE_TOKEN = /^[a-zA-Z0-9._-]+$/;

const mediaRoot = () => config.get().storage.mediaRoot;

// [UPDATED 2026-08-16 Phase 2] Mặc định đã TÁCH khỏi `mediaRoot`.
//
// Vì sao tách: `mediaRoot` là `root` của nginx `:9150`. File `.part.N` dở dang,
// marker `.accepted.json` và `.job.json` nằm trong đó là bề mặt không cần thiết
// — chúng bắt đầu bằng dấu chấm nên nginx vẫn serve được nếu ai đó đoán đúng
// tên, và mọi thao tác liệt kê/dọn dẹp/backup đều phải lọc thủ công.
//
// DI CHUYỂN AN TOÀN: `migrateLegacyStaging()` bên dưới được `server.js` gọi lúc
// boot, chuyển các file tạm còn sót từ `videos/` sang chỗ mới. Không có bước đó
// thì một phiên upload đang dở dang lúc deploy sẽ mất chunk đã nhận.
//
// Đặt `STAGING_ROOT=<đường dẫn mediaRoot>` để quay lại hành vi cũ.
const stagingRoot = () => {
  const configured = String(process.env.STAGING_ROOT || '').trim();
  return configured ? path.resolve(configured) : path.resolve(__dirname, '..', 'var', 'incoming');
};

const assertToken = (value, field) => {
  const token = String(value === undefined || value === null ? '' : value).trim();
  if (!token || !SAFE_TOKEN.test(token)) {
    throw new AppError(`${field} is invalid`, 400, 'IDENTITY_INVALID');
  }
  return token;
};

// Lưới an toàn cuối. `assertToken` đã chặn `..` và `/`, nhưng kiểm tra lại kết
// quả đã resolve là thứ duy nhất đúng với MỌI cách ghép chuỗi — kể cả những
// cách chưa nghĩ ra. So sánh có `path.sep` để `/videos-old` không lọt qua vì
// tình cờ cùng tiền tố với `/videos`.
const assertInside = (root, resolved) => {
  const base = path.resolve(root);
  const target = path.resolve(resolved);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new AppError('Resolved path escapes its storage root', 400, 'PATH_OUTSIDE_ROOT');
  }
  return target;
};

const within = (root, ...parts) => assertInside(root, path.join(root, ...parts));

// --- Nội dung được phục vụ ----------------------------------------------------

// Thư mục DASH của một video: <mediaRoot>/<storageKey>
const mediaDir = (storageKey) => within(mediaRoot(), assertToken(storageKey, 'storageKey'));

// Một file bên trong thư mục đó (dùng cho replication receiver).
const mediaFile = (storageKey, fileName) =>
  within(mediaRoot(), assertToken(storageKey, 'storageKey'), assertToken(fileName, 'fileName'));

// --- File tạm -----------------------------------------------------------------

// File gốc đã ghép, chờ encode: <stagingRoot>/<storageKey>.<extension>
const sourceFile = (storageKey, extension) =>
  within(stagingRoot(), `${assertToken(storageKey, 'storageKey')}.${assertToken(extension, 'extension').toLowerCase()}`);

// Mảnh chunk: <stagingRoot>/<uploadId>.part.<index>
const chunkPart = (uploadId, chunkIndex) => {
  const index = Number(chunkIndex);
  if (!Number.isInteger(index) || index < 0) throw new AppError('chunkIndex is invalid', 400, 'CHUNK_RANGE_INVALID');
  return within(stagingRoot(), `${assertToken(uploadId, 'uploadId')}.part.${index}`);
};

// Marker "đã ghép xong": <stagingRoot>/.<uploadId>.accepted.json
// Dấu chấm đầu là cố ý — đây là file ẩn, không phải nội dung phát được.
const uploadMarker = (uploadId) => within(stagingRoot(), `.${assertToken(uploadId, 'uploadId')}.accepted.json`);

// Trạng thái job encode: <stagingRoot>/.<storageKey>.job.json
//
// Đặt ở stagingRoot chứ KHÔNG trong `videos/<storageKey>/` vì hai lý do:
//   1. Lúc job bắt đầu, thư mục đó chưa tồn tại (FFmpeg mới là bên tạo ra nó).
//   2. Reconcile lúc boot cần quét MỘT thư mục để tìm mọi job dở dang, thay vì
//      duyệt toàn bộ thư mục media.
const jobFile = (storageKey) => within(stagingRoot(), `.${assertToken(storageKey, 'storageKey')}.job.json`);

// Hậu tố dùng để quét job lúc khởi động lại.
const JOB_FILE_SUFFIX = '.job.json';

// Nơi lưu danh sách chặn phát. KHÔNG nằm trong `videos/` (thư mục nginx serve):
// một file cấu hình nội bộ không có lý do gì để tải được qua HTTP.
const blockStoreFile = () => {
  const configured = String(process.env.PLAYBACK_BLOCK_STORE || '').trim();
  return configured ? path.resolve(configured) : path.resolve(__dirname, '..', 'var', 'playback-blocks.json');
};

// =============================================================================
// migrateLegacyStaging — chuyển file tạm từ `videos/` sang `stagingRoot` mới.
//
// Chạy MỘT LẦN lúc boot. Không có nó, lần deploy đổi `stagingRoot` sẽ làm mọi
// phiên upload đang dở dang mất sạch chunk đã nhận: Sub đi tìm `.part.N` ở chỗ
// mới, không thấy, và coi như chưa nhận gì — FE gửi nốt chunk cuối rồi nhận 202
// "chưa đủ" mãi mãi.
//
// KHÔNG BAO GIỜ throw: một file không di chuyển được không được phép chặn node
// khởi động. Ghi log để người vận hành xử lý tay.
//
// Chỉ đụng vào file khớp đúng ba mẫu đã biết. Thư mục (nội dung DASH thật) và
// mọi thứ khác trong `videos/` được giữ nguyên tuyệt đối.
// =============================================================================
const LEGACY_STAGING_PATTERNS = [/\.part\.\d+$/, /^\.[a-zA-Z0-9._-]+\.accepted\.json$/, /^\.[a-zA-Z0-9._-]+\.job\.json$/];

const migrateLegacyStaging = () => {
  const source = mediaRoot();
  const target = stagingRoot();
  const summary = { moved: 0, skipped: 0, failed: 0, from: source, to: target };

  // Cấu hình cũ (staging trùng media) thì không có gì để làm.
  if (path.resolve(source) === path.resolve(target)) return { ...summary, skipped: -1, reason: 'same-root' };
  if (!fs.existsSync(source)) return { ...summary, reason: 'no-media-root' };

  let entries;
  try {
    entries = fs.readdirSync(source, { withFileTypes: true });
  } catch (error) {
    return { ...summary, failed: 1, reason: error.message };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!LEGACY_STAGING_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;

    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    try {
      fs.mkdirSync(target, { recursive: true });
      // `rename` giữa hai thư mục KHÁC filesystem sẽ ném EXDEV. Trên node thật
      // hai thư mục này cùng ổ, nhưng bind-mount/Docker volume thì không chắc —
      // nên có nhánh copy dự phòng.
      try {
        fs.renameSync(from, to);
      } catch (error) {
        if (error.code !== 'EXDEV') throw error;
        fs.copyFileSync(from, to);
        fs.unlinkSync(from);
      }
      summary.moved += 1;
    } catch (error) {
      summary.failed += 1;
      summary.lastError = `${entry.name}: ${error.message}`;
    }
  }
  return summary;
};

module.exports = Object.freeze({
  SAFE_TOKEN,
  JOB_FILE_SUFFIX,
  LEGACY_STAGING_PATTERNS,
  migrateLegacyStaging,
  mediaRoot,
  stagingRoot,
  assertToken,
  assertInside,
  mediaDir,
  mediaFile,
  sourceFile,
  chunkPart,
  uploadMarker,
  jobFile,
  blockStoreFile,
});
