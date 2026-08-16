'use strict';

// =============================================================================
// legacyProbe — đếm xem route v1 nào CÒN THẬT SỰ được gọi, và ai gọi.
//
// -----------------------------------------------------------------------------
// Vì sao cần đo thay vì đoán
// -----------------------------------------------------------------------------
// Sub đang mang ba thế hệ code cùng lúc. Xoá nhầm một route v1 còn sống là làm
// đứt liên lạc với Central, và triệu chứng xuất hiện ở TẦNG KHÁC (Central báo
// "node từ chối") nên rất dễ điều tra sai hướng.
//
// Đặc biệt ở đây: Central mới CỐ TÌNH hạ cấp xuống `/api/v1/replicate/send-folder-v2`
// khi gặp Sub cũ trả 404/405/426 (`services/redirect/replicationService.js`,
// hằng `NEEDS_LEGACY_CONNECTOR`). Nghĩa là một route v1 có thể im lặng hàng
// tuần rồi bỗng được gọi đúng lúc có node phiên bản lệch. "Lâu rồi không thấy
// gọi" KHÔNG phải bằng chứng để xoá.
//
// Vì vậy mỗi `@deprecated` trong repo này phải kèm ĐIỀU KIỆN XOÁ đọc được từ
// đây, ví dụ: "xoá khi legacy.route.hit của /api/v1/upload = 0 trong 30 ngày".
//
// -----------------------------------------------------------------------------
// Chi phí
// -----------------------------------------------------------------------------
// Một phép cộng vào object in-memory + một dòng log mức `warn`. Đặt trên control
// plane v1 (vài request/phút), KHÔNG đặt trên data plane — xem ghi chú hiệu năng
// ở `middleware/requestTrace.js`.
//
// Bộ đếm nằm trong RAM của đúng một process: `pm2 restart` là mất. Đó là chấp
// nhận được vì nguồn sự thật để quyết định xoá là LOG (bền), còn bộ đếm chỉ để
// xem nhanh qua `GET /api/default/legacy-usage`.
// =============================================================================

const log = require('../platform/log');

const legacyLog = log.child('legacy');

const state = {
  startedAt: new Date().toISOString(),
  total: 0,
  byRoute: Object.create(null),
};

// `req.baseUrl` là prefix mà middleware được mount (vd `/api/v1/upload`), ổn
// định hơn `originalUrl` vốn chứa tham số động nên sẽ làm nổ số lượng khoá.
const routeKey = (req) => `${req.method} ${req.baseUrl || req.path || 'unknown'}`;

module.exports = (req, res, next) => {
  const key = routeKey(req);
  state.total += 1;
  state.byRoute[key] = (state.byRoute[key] || 0) + 1;

  legacyLog.warn('legacy route hit', {
    event: 'legacy.route.hit',
    route: key,
    path: req.originalUrl,
    // Ai gọi. `X-Node-Id` chưa được Central gửi (đề xuất ở mục 4.3 của
    // markdowns/sub-node-code-standardization-draft.md) nên hiện thường là IP.
    caller: req.get('X-Node-Id') || req.ip,
  });

  next();
};

module.exports.snapshot = () => ({
  startedAt: state.startedAt,
  total: state.total,
  byRoute: { ...state.byRoute },
});

module.exports.reset = () => {
  state.total = 0;
  state.byRoute = Object.create(null);
  state.startedAt = new Date().toISOString();
};
