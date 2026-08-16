'use strict';

// =============================================================================
// heartbeatService — dựng payload heartbeat theo contract `stream-heartbeat-v2`.
//
// -----------------------------------------------------------------------------
// 1. Vì sao đổi schema
// -----------------------------------------------------------------------------
// Sub đang gửi `{payload, ts, status}` tới `/api/v1/heartbeat/receive`. Central
// chấp nhận nó qua nhánh "legacy envelope" của
// `services/heartbeat/heartbeatPayloadService.normalize()`, NHƯNG:
//
//   - `nodeId` bị SUY RA thành `legacy:<baseURL>:<serverIndex>` vì payload cũ
//     không mang định danh nào;
//   - `apiVersion` bị đánh `v1-legacy`;
//   - và theo `contracts/heartbeat-v2.md`: "Legacy payloads without this
//     identity remain `suspect` instead of being falsely declared disconnected"
//     — tức node CHẠY TỐT vẫn không bao giờ lên được trạng thái `active`.
//
// Central đã có sẵn `/api/v2/heartbeat/receive` và toàn bộ logic liveness nhiều
// mức. Chỉ thiếu đúng việc Sub gửi đúng hình dạng.
//
// -----------------------------------------------------------------------------
// 2. Vì sao inventory gửi theo hash
// -----------------------------------------------------------------------------
// `heartbeatAPI` cũ tính `videosInfoHash` rồi vẫn gửi TOÀN BỘ danh sách video
// mỗi 10 giây. Node có vài nghìn video thì đó là payload lớn lặp lại vô ích
// suốt đời tiến trình, cho một dữ liệu gần như không bao giờ đổi.
//
// Central đã sẵn sàng cho việc này: `modules/storeAPI.recordHeartbeat` giữ
// `previous.videosInfo` khi payload không kèm mảng, và chỉ đặt
// `inventoryChanged = true` khi mảng CÓ MẶT và hash khác lần trước. Nên bỏ mảng
// đi khi hash không đổi là an toàn, và còn làm `inventoryChanged` chính xác hơn.
//
// -----------------------------------------------------------------------------
// 3. bootId và sequence
// -----------------------------------------------------------------------------
// Hai field Central đã hỗ trợ sẵn nhưng chưa ai gửi. `bootId` đổi mỗi lần tiến
// trình khởi động, `sequence` tăng dần trong một đời tiến trình. Cùng nhau,
// chúng phân biệt được ba tình huống mà nếu chỉ nhìn "heartbeat vẫn về" thì
// giống hệt nhau:
//     bootId đổi liên tục      -> node đang crash-loop (pm2 restart vòng lặp)
//     sequence nhảy cóc        -> heartbeat bị rớt trên đường
//     bootId cũ, sequence tăng -> node khoẻ
// =============================================================================

const crypto = require('crypto');

const config = require('../platform/config');

// Đổi mỗi lần tiến trình khởi động — xem mục 3.
const BOOT_ID = crypto.randomUUID ? crypto.randomUUID().slice(0, 12) : crypto.randomBytes(6).toString('hex');

let sequence = 0;

// Hash inventory đã gửi thành công lần gần nhất. `null` = chưa gửi lần nào, nên
// lần đầu luôn kèm đủ danh sách.
let lastSentInventoryHash = null;

const nodeVersion = () => {
  try {
    return require('../package.json').version || null;
  } catch (error) {
    return null;
  }
};

// Khả năng của node. Central lưu vào `features` và có thể dùng để phân bổ job
// (ví dụ chỉ gửi job HEVC tới node có NVENC). Hiện là danh sách tĩnh; khi có
// dò năng lực thật (ffmpeg -encoders) thì thay ở đúng chỗ này.
const features = () => {
  const list = ['dash', 'thumbnail', 'replication-v2', 'encode-callback-v1'];
  if (!config.get().mediaServing) list.push('nginx-only-delivery');
  return list;
};

/**
 * Dựng payload `stream-heartbeat-v2`.
 *
 * `inventory.videos` chỉ có mặt khi hash đổi so với lần gửi thành công trước —
 * xem mục 2. `inventory.checksum` thì LUÔN có, vì đó là thứ Central dùng để
 * biết có đổi hay không.
 */
const buildPayload = ({ videosInfo = [], videosInfoHash = null, health = null } = {}) => {
  sequence += 1;
  const current = config.get();
  const inventoryChanged = videosInfoHash !== lastSentInventoryHash;

  return {
    contractVersion: 'stream-heartbeat-v2',
    nodeId: current.nodeId,
    nodeVersion: nodeVersion(),
    apiVersion: 'v2',
    sentAt: new Date().toISOString(),
    status: 'alive',
    bootId: BOOT_ID,
    sequence,

    // Central map node sang `Server` bằng khối này (`serverInfo.serverId`, hoặc
    // `publicURL` + `port`). Thiếu nó thì node ở lại `suspect` mãi.
    server: {
      serverId: current.serverId || null,
      publicURL: current.publicUrl || null,
      port: current.publicPort || null,
      serverIndex: current.serverIndex,
      baseURL: current.centralApi,
    },

    features: features(),
    health,

    inventory: {
      checksum: videosInfoHash,
      count: Array.isArray(videosInfo) ? videosInfo.length : 0,
      ...(inventoryChanged ? { videos: videosInfo } : {}),
    },
  };
};

// Chỉ ghi nhận sau khi Central XÁC NHẬN đã nhận. Ghi nhận sớm hơn thì một lần
// gửi thất bại sẽ khiến inventory mới không bao giờ được gửi lại.
const markDelivered = (payload) => {
  if (payload?.inventory && Object.prototype.hasOwnProperty.call(payload.inventory, 'videos')) {
    lastSentInventoryHash = payload.inventory.checksum;
  }
};

// Dùng cho test và cho trường hợp cần buộc gửi lại đủ inventory.
const resetInventoryState = () => {
  lastSentInventoryHash = null;
};

module.exports = Object.freeze({
  BOOT_ID,
  buildPayload,
  markDelivered,
  resetInventoryState,
  features,
  nodeVersion,
  currentSequence: () => sequence,
  lastSentInventoryHash: () => lastSentInventoryHash,
});
