'use strict';

// =============================================================================
// dataPlaneGuard — Node KHÔNG phục vụ media nữa. Phải đi qua nginx :9150.
//
// -----------------------------------------------------------------------------
// 1. Vì sao đóng hẳn thay vì chỉ "không dùng nữa"
// -----------------------------------------------------------------------------
// Chừng nào Node còn trả được `.m4s`/`.mpd`, luôn tồn tại một đường phát video
// KHÔNG đi qua `auth_request` của nginx — tức là không qua bất kỳ kiểm tra token
// hay danh sách chặn nào. Có hai cửa mà chỉ khoá một cửa thì cửa còn lại chính
// là cửa mọi người sẽ dùng khi cửa kia phiền.
//
// Đóng hẳn ở đây biến "phải đi qua nginx" từ MỘT QUY ƯỚC thành MỘT TÍNH CHẤT:
// trên node này không còn tồn tại đường nào khác để lấy segment.
//
// -----------------------------------------------------------------------------
// 2. Vì sao 410 Gone chứ không phải 404
// -----------------------------------------------------------------------------
// 404 nói "không có ở đây", và client hợp lý sẽ thử lại hoặc đi tìm chỗ khác.
// 410 nói "từng có, đã bỏ hẳn, đừng hỏi lại" (RFC 9110 §15.5.11) — đúng nghĩa
// tình huống này. Quan trọng hơn cho vận hành: 410 trong access.log là dấu hiệu
// KHÔNG THỂ NHẦM rằng còn client cũ đang gọi sai cửa, trong khi 404 lẫn với đủ
// thứ nguyên nhân khác.
//
// Body kèm `hint` chỉ đúng URL cần dùng, để người debug không phải đi tra tài liệu.
//
// -----------------------------------------------------------------------------
// 3. Van xả
// -----------------------------------------------------------------------------
// `MEDIA_SERVING=on` bật lại đường cũ. Có mặt vì một tình huống thật: nginx hỏng
// hoặc chưa cài `auth_request` trên một node nào đó, và cần phát tạm. Mặc định
// `off` — van phải khó mở thì mới là van.
//
// -----------------------------------------------------------------------------
// 4. Không log per-request
// -----------------------------------------------------------------------------
// Nếu còn client cũ, chúng sẽ gọi hàng nghìn lần mỗi phiên. Ghi log mỗi lần là
// tự tạo ra sự cố thứ hai. Ở đây chỉ ĐẾM, và log mẫu theo thời gian
// (nhiều nhất một dòng mỗi 60 giây), giống cách `controllers/authController.js`
// xử lý đường nóng.
// =============================================================================

const config = require('../platform/config');
const log = require('../platform/log');

const guardLog = log.child('dataPlaneGuard');

const SAMPLE_INTERVAL_MS = 60000;

const state = {
  startedAt: new Date().toISOString(),
  refused: 0,
  byExtension: Object.create(null),
  lastSampleAt: 0,
  lastPath: null,
};

const extensionOf = (url) => {
  const clean = String(url || '').split('?')[0];
  const dot = clean.lastIndexOf('.');
  return dot > -1 ? clean.slice(dot + 1).toLowerCase().slice(0, 8) : 'none';
};

module.exports = (req, res, next) => {
  if (config.get().mediaServing) return next();

  const extension = extensionOf(req.originalUrl);
  state.refused += 1;
  state.byExtension[extension] = (state.byExtension[extension] || 0) + 1;
  state.lastPath = req.originalUrl;

  const now = Date.now();
  if (now - state.lastSampleAt > SAMPLE_INTERVAL_MS) {
    state.lastSampleAt = now;
    guardLog.warn('media request refused; client is bypassing nginx', {
      event: 'dataplane.refused',
      path: req.originalUrl,
      extension,
      refusedTotal: state.refused,
      caller: req.get('X-Node-Id') || req.ip,
      note: 'chỉ ghi mẫu tối đa 1 dòng/60s — xem GET /api/default/data-plane để có số đầy đủ',
    });
  }

  return res.status(410).json({
    ok: false,
    error: {
      code: 'MEDIA_SERVING_DISABLED',
      message: 'Sub node không phục vụ media qua Node nữa. Dùng nginx cổng 9150.',
      hint: `http://<node-host>:9150${req.originalUrl.startsWith('/') ? '' : '/'}${req.originalUrl}`,
    },
  });
};

module.exports.snapshot = () => ({
  enabled: config.get().mediaServing,
  startedAt: state.startedAt,
  refused: state.refused,
  byExtension: { ...state.byExtension },
  lastPath: state.lastPath,
});
