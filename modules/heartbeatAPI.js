'use strict';

// =============================================================================
// heartbeatAPI — node tự báo cáo tình trạng về Central theo mô hình PUSH.
//
// Vì sao push chứ không để Central polling: Central restart vẫn dựng lại được
// state từ heartbeat đến sau đó, còn polling thì mất luôn khoảng thời gian
// Central chết. Đây là quyết định kiến trúc đã chốt
// (`markdowns/central-node-architecture-comparison.md`).
//
// -----------------------------------------------------------------------------
// [UPDATED 2026-08-16] Phase 0 — sửa lỗi, KHÔNG đổi schema trên dây
// -----------------------------------------------------------------------------
// Schema gửi đi vẫn là `{payload, ts, status}` tới `api/v1/heartbeat/receive`.
// Central chấp nhận nó qua nhánh "legacy envelope" của
// `services/heartbeat/heartbeatPayloadService.normalize()`, nhưng gán
// `apiVersion: 'v1-legacy'` và suy `nodeId` ra `legacy:<baseURL>:<serverIndex>`.
// Chuyển sang `stream-heartbeat-v2` (có `nodeId`, `sentAt`, inventory theo hash)
// là việc của Phase 2 — nó cần Central và Sub đổi cùng lúc.
//
// Bốn thứ đã sửa ở đây, đều độc lập với schema:
//   1. `gatherVideosInfo` gọi `readdir` HAI LẦN, lần đầu vứt kết quả đi.
//   2. Đường dẫn `'videos/'` giải theo CWD -> chạy từ thư mục khác là đọc nhầm
//      chỗ. Nay dùng `storage/paths.mediaRoot()` (tuyệt đối).
//   3. Thư mục `videos/` nằm trong `.gitignore` nên KHÔNG có sau `git clone`;
//      trước đây thiếu nó là loop ném lỗi mỗi 10 giây.
//   4. `gatherHeartbeatInfo` gán vào biến `heartbeatInfo` CHƯA KHAI BÁO —
//      rò một biến toàn cục (và sẽ là ReferenceError dưới 'use strict').
// =============================================================================

const fs = require('fs');
const path = require('path');

const axios = require('axios');
const hash = require('object-hash');

const config = require('../platform/config');
const paths = require('../storage/paths');
const log = require('../platform/log');
const heartbeatService = require('../services/heartbeatService');
const encodeJobService = require('../services/encodeJobService');

const heartbeatLog = log.child('heartbeat');

// Tạo lazy: `dotenv.config()` chạy trong `server.js` TRƯỚC khi require app, nên
// đọc lúc require thường đúng — nhưng test require thẳng module này thì không.
// Lazy bỏ hẳn sự phụ thuộc vào thứ tự require.
let client = null;
const getClient = () => {
  if (!client) {
    client = axios.create({
      baseURL: config.get().centralApi,
      timeout: 5000, // bắt buộc cho heartbeat: một Central treo không được giữ vòng lặp
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return client;
};

// Đường v2 và đường v1. Central hiện có cả hai; `/api/v1/heartbeat/receive` chỉ
// còn để nói chuyện với Central chưa cập nhật.
const HEARTBEAT_PATHS = Object.freeze({ v2: 'api/v2/heartbeat/receive', v1: 'api/v1/heartbeat/receive' });

// Nhớ lại kết quả dò để không thử v2 rồi rơi xuống v1 ở MỌI nhịp 10 giây.
let activeContract = null;

/**
 * Gửi heartbeat. Thử v2 trước; Central cũ trả 404/405 thì hạ xuống v1 và NHỚ.
 *
 * Chỉ hạ cấp khi Central THẬT SỰ TRẢ LỜI. Lỗi transport (Central chết, timeout)
 * mà đem đi thử v1 chỉ là hỏng thêm một lần nữa và làm mờ nguyên nhân gốc —
 * cùng nguyên tắc với `NEEDS_LEGACY_CONNECTOR` bên Central.
 */
async function post(path, payload) {
  try {
    const response = await getClient().post(path, payload, { validateStatus: () => true });
    return { ok: response.status >= 200 && response.status < 300, status: response.status, transport: 'ok' };
  } catch (err) {
    return { ok: false, status: null, transport: err.code || 'network' };
  }
}

const NEEDS_LEGACY_HEARTBEAT = [404, 405, 426];

async function sendHeartbeat(payload) {
  const configured = String(process.env.HEARTBEAT_CONTRACT || 'auto').toLowerCase();
  const contract = configured === 'v1' || configured === 'v2' ? configured : activeContract || 'v2';

  let result = await post(HEARTBEAT_PATHS[contract], payload);

  if (!result.ok && contract === 'v2' && result.transport === 'ok' && NEEDS_LEGACY_HEARTBEAT.includes(result.status)) {
    heartbeatLog.warn('central does not know heartbeat v2; downgrading to v1', { status: result.status });
    activeContract = 'v1';
    result = await post(HEARTBEAT_PATHS.v1, buildLegacyPayload(payload));
  } else if (result.ok) {
    activeContract = contract;
  }

  if (!result.ok) {
    // Gom cả network error lẫn 4xx/5xx: với heartbeat thì cả hai chỉ dẫn tới
    // một hành động — thử lại ở nhịp sau.
    heartbeatLog.warn('send failed', { code: result.status || result.transport, contract });
    return false;
  }
  return true;
}

const gatherServerStatus = async () => {};

const gatherServerInfo = async () => {
  const current = config.get();
  return { baseURL: current.centralApi, serverIndex: current.serverIndex };
};

const gatherVideosInfo = async () => {
  const mediaRoot = paths.mediaRoot();

  let entries;
  try {
    entries = await fs.promises.readdir(mediaRoot, { withFileTypes: true });
  } catch (error) {
    // ENOENT là bình thường trên node vừa clone (`videos/` bị .gitignore).
    // Trả danh sách rỗng để heartbeat vẫn gửi được "node sống, chưa có video",
    // thay vì làm hỏng cả nhịp báo cáo.
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((folder) => {
      const folderPath = path.join(mediaRoot, folder.name);
      const videoFiles = fs.readdirSync(folderPath).filter((file) => path.extname(file).toLowerCase() === '.mpd');
      return { folder: folder.name, videos: videoFiles };
    });
};

const gatherHeartbeatInfo = async () => {
  const serverStatus = await gatherServerStatus();
  const serverInfo = await gatherServerInfo();
  const videosInfo = await gatherVideosInfo();

  // Central dùng hash này để biết inventory có đổi không mà không phải so cả
  // danh sách; từ Phase 2, `videosInfo` chỉ được gửi kèm khi hash đổi
  // (`services/heartbeatService.js`).
  const videosInfoHash = hash(videosInfo);

  // Độ sâu hàng đợi encode là số Central cần TRƯỚC khi phân bổ upload tiếp
  // theo: một node có 8 job đang chờ không nên nhận thêm việc, dù nó vẫn `alive`.
  const health = { encodeQueue: encodeJobService.stats(), mediaServing: config.get().mediaServing };

  return { serverStatus, serverInfo, videosInfo, videosInfoHash, health };
};

// MỘT chỗ dựng payload duy nhất.
// [FIXED 2026-08-16] Trước đây vòng lặp gửi `buildPayload(info)` còn
// `GET /heartbeat` (`controllers/defaultController.js`) gửi thẳng `info` — cùng
// một node báo cáo cho Central theo HAI schema khác nhau, tuỳ ai gọi.
//
// [UPDATED 2026-08-16 Phase 2] Mặc định dựng `stream-heartbeat-v2`
// (`services/heartbeatService.js`). Bản legacy giữ lại cho đường fallback.
function buildPayload(info) {
  return heartbeatService.buildPayload({
    videosInfo: info.videosInfo,
    videosInfoHash: info.videosInfoHash,
    health: info.health || null,
  });
}

/**
 * @deprecated 2026-08-16 — schema v1. Chỉ dùng khi Central trả 404/405 cho
 * `/api/v2/heartbeat/receive`, nghĩa là Central chưa cập nhật.
 * Xoá khi: mọi Central trong hệ thống đã có route v2 (nó đã có từ trước Phase 2,
 * nên nhánh này chủ yếu để phòng lệch phiên bản lúc rollout).
 */
function buildLegacyPayload(payloadV2) {
  return {
    payload: {
      serverInfo: { baseURL: config.get().centralApi, serverIndex: config.get().serverIndex },
      videosInfo: payloadV2?.inventory?.videos || [],
      videosInfoHash: payloadV2?.inventory?.checksum || null,
    },
    ts: Date.now(),
    status: 'alive',
  };
}

//#region autoHeartbeat
let stopped = false;

// Rải đều trong [interval - jitter, interval + jitter] để N node không cùng đập
// vào Central đúng một thời điểm sau khi cả cụm khởi động lại.
// [FIXED 2026-08-16] `process.env.JITTER` là CHUỖI; công thức cũ chạy được chỉ
// nhờ ép kiểu ngầm của `-` và `*`. `config` trả về số thật.
function nextDelay() {
  const { intervalMs, jitterMs } = config.get().heartbeat;
  return intervalMs - jitterMs + Math.random() * (2 * jitterMs);
}

// `unref()` — timer này KHÔNG được giữ tiến trình sống.
//
// Vòng lặp heartbeat chạy mãi mãi theo thiết kế. Nếu timer chờ giữa hai nhịp
// được tính vào event loop, tiến trình không bao giờ thoát: `node --test` treo
// sau khi test xong, và một script vận hành lỡ require `app.js` cũng treo theo.
// Điều đúng đắn cho một vòng lặp NỀN là: sống chừng nào còn thứ khác (HTTP
// server) giữ tiến trình sống, và biến mất cùng nó.
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

async function heartbeatLoop() {
  heartbeatLog.info('loop started', { intervalMs: config.get().heartbeat.intervalMs, central: config.get().centralApi });
  while (!stopped) {
    try {
      const heartbeatInfo = await gatherHeartbeatInfo();
      const payload = buildPayload(heartbeatInfo);
      const delivered = await sendHeartbeat(payload);
      // Chỉ ghi nhận inventory là "đã gửi" khi Central XÁC NHẬN. Ghi nhận sớm
      // hơn thì một lần gửi hỏng sẽ khiến inventory mới không bao giờ đi lại.
      if (delivered) heartbeatService.markDelivered(payload);
    } catch (err) {
      heartbeatLog.error('loop error', err);
    }
    await sleep(nextDelay()); // chỉ chờ SAU khi gửi xong
  }
}

const stop = () => {
  stopped = true;
};
//#endregion

module.exports = {
  buildLegacyPayload,
  gatherServerStatus,
  gatherServerInfo,
  gatherVideosInfo,
  gatherHeartbeatInfo,
  buildPayload,
  sendHeartbeat,
  heartbeatLoop,
  stop,
};
