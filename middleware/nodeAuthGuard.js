'use strict';

// =============================================================================
// nodeAuthGuard — chặn request node-to-node không có chữ ký hợp lệ.
//
// CHỈ dùng cho endpoint mà NGƯỜI GỌI GIỮ ĐƯỢC BÍ MẬT:
//     /api/v2/replications/*   Central → Sub, và Sub → Sub
//     /api/v2/playback/*       Central → Sub
//
// TUYỆT ĐỐI KHÔNG dùng cho `/api/v2/uploads/chunks`: người gọi ở đó là TRÌNH
// DUYỆT, và trình duyệt không giữ được khoá bí mật. Đường đó dùng token phiên
// upload do Central ký sẵn — xem `middleware/uploadContract.js` và mục 3 của
// `platform/nodeAuth.js`.
//
// Rollout BẮT BUỘC qua ba mức, mượn nguyên mô hình đã chạy tốt của `AUTH_MODE`:
//     off  ->  log  ->  enforce
// Bật thẳng `enforce` trên hệ đang chạy là tự cắt liên lạc với mọi Central chưa
// cập nhật. Ở mức `log`, đọc `GET /api/default/node-auth` để biết bật enforce
// sẽ chặn bao nhiêu request và vì lý do gì.
// =============================================================================

const nodeAuth = require('../platform/nodeAuth');
const errors = require('../platform/errors');
const log = require('../platform/log');

const guardLog = log.child('nodeAuth');

const stats = {
  startedAt: new Date().toISOString(),
  total: 0,
  allowed: 0,
  wouldDeny: 0, // bị chặn khi ở mode log (thực tế vẫn cho qua)
  denied: 0, // bị chặn thật khi ở mode enforce
  byReason: Object.create(null),
  byNode: Object.create(null),
};

/**
 * `primaryIdFrom` rút ra định danh chính của thao tác để đưa vào chữ ký. Ràng
 * buộc chữ ký vào `jobId` nghĩa là một chữ ký hợp lệ của job A không dùng lại
 * được cho job B — nếu không, chặn phát lại theo thời gian là bảo vệ duy nhất.
 */
const primaryIdFrom = (req) =>
  req.body?.jobId ||
  req.headers['x-job-id'] ||
  req.body?.video?.storageKey ||
  req.headers['x-storage-key'] ||
  '';

const contractVersionFrom = (req) =>
  req.body?.contractVersion || req.headers['x-replication-contract'] || req.headers['x-upload-contract'] || '';

module.exports = (req, res, next) => {
  const result = nodeAuth.verifyRequest({
    method: req.method,
    // `originalUrl` gồm cả prefix mount — bên ký cũng dùng đường dẫn đầy đủ.
    path: req.originalUrl,
    contractVersion: contractVersionFrom(req),
    primaryId: primaryIdFrom(req),
    headers: req.headers,
  });

  stats.total += 1;
  stats.byReason[result.reason] = (stats.byReason[result.reason] || 0) + 1;
  if (result.nodeId) stats.byNode[result.nodeId] = (stats.byNode[result.nodeId] || 0) + 1;

  res.setHeader('X-Node-Auth-Mode', result.mode);
  res.setHeader('X-Node-Auth-Reason', result.reason);

  if (result.reason === 'ok') {
    stats.allowed += 1;
    req.nodeAuth = result;
    return next();
  }

  if (!result.enforced) {
    stats.wouldDeny += 1;
    // Đây là dòng log để đọc TRƯỚC khi bật enforce. Nó nói chính xác request
    // nào sẽ bị chặn và từ node nào.
    guardLog.warn('would deny node request', {
      event: 'nodeauth.would_deny',
      reason: result.reason,
      nodeId: result.nodeId,
      method: req.method,
      path: req.originalUrl,
    });
    req.nodeAuth = result;
    return next();
  }

  stats.denied += 1;
  guardLog.error('node request denied', {
    event: 'nodeauth.denied',
    reason: result.reason,
    nodeId: result.nodeId,
    method: req.method,
    path: req.originalUrl,
  });
  return next(errors.fail('NODE_AUTH_FAILED', `node authentication failed: ${result.reason}`));
};

module.exports.snapshot = () => ({
  mode: nodeAuth.mode(),
  hasSecret: nodeAuth.hasSecret(),
  skewSec: nodeAuth.skewSec(),
  ...stats,
  byReason: { ...stats.byReason },
  byNode: { ...stats.byNode },
});
