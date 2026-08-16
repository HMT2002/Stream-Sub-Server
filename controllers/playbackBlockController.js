'use strict';

// =============================================================================
// playbackBlockController — API quản trị công tắc chặn phát.
//
// Đây là cách Sub "chặn nginx bất cứ khi nào muốn": nginx hỏi Node cho MỖI file
// qua `auth_request`, nên một mục trong danh sách này có hiệu lực ngay ở request
// segment tiếp theo — không cần reload nginx, không cần restart Node.
//
// ĐỘ TRỄ THỰC TẾ: đúng bằng thời lượng segment đang phát dở (2–6 giây), vì
// người xem đã tải sẵn buffer. Nếu `location = /__auth` có bật `proxy_cache`
// thì cộng thêm TTL của cache đó — đây chính là cái giá của việc cache auth,
// đã ghi trong config nginx.
//
// CHƯA CÓ XÁC THỰC. Route này nằm sau nginx `:80`, và cổng `9100` không mở
// firewall, nên phạm vi tấn công hiện là mạng nội bộ. Xác thực node-to-node
// (HMAC) là Phase 2 — xem mục 4.4 của
// `markdowns/sub-node-code-standardization-draft.md`.
// =============================================================================

const playbackBlockService = require('../services/playbackBlockService');
const authService = require('../services/authService');
const presenter = require('../presenters/v2Presenter');
const catchAsync = require('../utils/catchAsync');

exports.list = catchAsync(async (req, res) => {
  presenter.ok(res, {
    blocks: playbackBlockService.list(),
    ...playbackBlockService.stats(),
    // Người vận hành cần thấy hai số này cạnh nhau: block có hiệu lực bất kể
    // authMode, nhưng authMode vẫn quyết định phần còn lại của chính sách.
    authMode: authService.mode(),
  });
});

exports.create = catchAsync(async (req, res) => {
  const entry = playbackBlockService.add({
    type: req.body.type,
    value: req.body.value,
    reason: req.body.reason,
    ttlSeconds: req.body.ttlSeconds,
    createdBy: req.get('X-Node-Id') || req.ip,
  });
  presenter.created(res, { block: entry, ...playbackBlockService.stats() });
});

exports.remove = catchAsync(async (req, res) => {
  const entry = playbackBlockService.removeById(req.params.id);
  presenter.ok(res, { block: entry, ...playbackBlockService.stats() });
});

exports.clear = catchAsync(async (req, res) => {
  const removed = playbackBlockService.clear();
  presenter.ok(res, { removed, ...playbackBlockService.stats() });
});

// Kiểm tra thử một request sẽ bị chặn hay không, KHÔNG cần phát thật.
// Có mục này vì cách duy nhất để tự tin trước khi chặn một phim là thử trước.
exports.probe = catchAsync(async (req, res) => {
  const result = authService.verifyPlaybackToken({
    uri: req.query.uri || '',
    headers: { 'x-original-uri': req.query.uri || '', ...(req.query.token ? { 'x-player-token': req.query.token } : {}) },
    ip: req.query.ip || '',
    method: 'GET',
  });
  presenter.ok(res, {
    uri: req.query.uri || null,
    allow: result.allow,
    code: result.code,
    reason: result.reason,
    mode: result.mode,
    enforced: result.enforced,
    block: result.block || null,
  });
});
