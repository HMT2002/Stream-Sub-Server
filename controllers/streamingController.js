'use strict';

// =============================================================================
// streamingController — dừng/tiếp tục một phiên xem theo token.
//
// [UPDATED 2026-08-16 Phase 1] Hai handler này giờ ghi vào
// `services/playbackBlockService` (bền qua restart) thay vì CHỈ vào
// `globals/blacklist` (mảng trong RAM).
//
// VÌ SAO ĐỔI: cơ chế cũ mất sạch khi `pm2 restart`. Người vừa bị chặn xem tiếp
// được ngay sau lần deploy kế tiếp, và không có dấu vết nào cho thấy điều đó đã
// xảy ra. Với một thao tác mang nghĩa "cắt quyền xem", quên sau khi restart là
// kiểu hỏng tệ nhất: im lặng và ngược hoàn toàn với ý định.
//
// Vẫn ghi vào `globals/blacklist` song song để nhánh kiểm tra cũ trong
// `services/authService` (`claims.sessionID` -> blacklist) không đổi hành vi.
//
// @deprecated 2026-08-16 — đường v1. Thay bằng `/api/v2/playback/blocks`, nơi
// chặn được cả theo `storageKey` và `ip` chứ không chỉ theo session, có TTL, và
// liệt kê/gỡ được.
// Xoá khi: `legacy.route.hit` của `GET /api/v1/streaming` = 0 trong 30 ngày.
// =============================================================================

const helperAPI = require('../modules/helperAPI');
const playbackBlockService = require('../services/playbackBlockService');
const blacklist = require('../globals/blacklist');
const catchAsync = require('../utils/catchAsync');
const log = require('../platform/log');

const streamingLog = log.child('streaming');

// Token ở đây do client đưa vào. `DecodeToken` verify chữ ký, nên sessionID lấy
// ra là đáng tin — khác với đường `off`/`log` của authService (xem ghi chú
// `sessionIdOf` ở services/authService.js).
const decodeOrNull = (token) => {
  try {
    return helperAPI.DecodeToken(token);
  } catch (error) {
    streamingLog.warn('token khong giai ma duoc', { message: error.message });
    return null;
  }
};

exports.StopStreaming = catchAsync(async (req, res) => {
  const decoded = decodeOrNull(req.params.token);
  if (decoded === null) {
    // Giữ nguyên mã 500 và hình dạng body của bản cũ: Central/FE hiện tại đang
    // đọc đúng hai field này. (400 mới là mã đúng — đổi ở Phase 2 cùng lúc với
    // việc chuyển route sang envelope v2.)
    return res.status(500).json({ status: 500, data: 'Streaming not found!' });
  }

  blacklist.AddToBlacklist(decoded);

  let block = null;
  if (decoded.sessionID) {
    block = playbackBlockService.add({
      type: 'session',
      value: String(decoded.sessionID),
      reason: 'stop-streaming (v1)',
      createdBy: req.ip,
    });
  } else {
    // Không có sessionID thì chỉ chặn được trong RAM — nói thẳng ra trong log,
    // vì người vận hành sẽ tưởng đã chặn bền vững.
    streamingLog.warn('token khong co sessionID; chi chan duoc trong RAM, mat sau restart');
  }

  streamingLog.event('playback.session.stopped', { sessionID: decoded.sessionID || null, durable: Boolean(block) });
  return res.status(200).json({ status: 200, data: 'Streaming stopped!' });
});

exports.AddStreaming = catchAsync(async (req, res) => {
  const decoded = decodeOrNull(req.params.token);
  if (decoded === null) {
    return res.status(500).json({ status: 500, data: 'Streaming not found!' });
  }

  blacklist.RemoveFromBlacklist(decoded);
  if (decoded.sessionID) playbackBlockService.removeByValue('session', String(decoded.sessionID));

  streamingLog.event('playback.session.resumed', { sessionID: decoded.sessionID || null });
  return res.status(200).json({ status: 200, data: 'Streaming continued!' });
});
