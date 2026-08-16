'use strict';

// =============================================================================
// encodeQueue — giới hạn số tiến trình FFmpeg chạy cùng lúc trên một node.
//
// -----------------------------------------------------------------------------
// Vì sao cần
// -----------------------------------------------------------------------------
// `controllers/uploadV2Controller` cũ gọi
//     void encodeAPI.encodeIntoDashVer4(...).catch(...)
// tức là fire-and-forget KHÔNG có giới hạn nào. Hai upload kết thúc cách nhau
// vài giây = hai FFmpeg NVENC chạy song song trên cùng một VM free-tier. Với
// NVENC còn tệ hơn CPU: card tiêu dùng giới hạn số phiên encode đồng thời ở mức
// rất thấp, phiên vượt hạn mức sẽ LỖI KHỞI TẠO chứ không xếp hàng chờ.
//
// -----------------------------------------------------------------------------
// Vì sao tự viết thay vì dùng p-queue
// -----------------------------------------------------------------------------
// `p-queue` từ v7 là ESM-only, còn repo này là CommonJS — kéo về sẽ phải đổi cả
// hệ thống module hoặc dynamic import, đắt hơn nhiều so với thứ cần dùng. Cái
// cần ở đây chỉ là: giới hạn concurrency, đo độ sâu hàng đợi, và chờ được lúc
// tắt máy. Chừng đó là ~40 dòng và test được trọn vẹn.
//
// (Ghi chú kiến trúc: `SKILL.sub-node.md` nói dùng `p-queue`. Ý định của quyết
// định đó là "hàng đợi in-process, không BullMQ, không Redis trên node" — điều
// module này thoả mãn. Đổi sang p-queue thật sau này chỉ là thay phần ruột.)
// =============================================================================

const log = require('../platform/log');

const queueLog = log.child('encodeQueue');

const create = ({ concurrency = 1, name = 'encode' } = {}) => {
  const limit = Math.max(1, Number(concurrency) || 1);
  const pending = [];
  let running = 0;
  let drainResolvers = [];

  const settleDrain = () => {
    if (running === 0 && pending.length === 0 && drainResolvers.length) {
      drainResolvers.forEach((resolve) => resolve());
      drainResolvers = [];
    }
  };

  const pump = () => {
    while (running < limit && pending.length) {
      const task = pending.shift();
      running += 1;
      queueLog.debug('task started', { name, running, waiting: pending.length });

      // `task.job()` được bọc trong Promise.resolve để nhận cả hàm sync lẫn async.
      Promise.resolve()
        .then(() => task.job())
        .then(task.resolve, task.reject)
        .finally(() => {
          running -= 1;
          queueLog.debug('task finished', { name, running, waiting: pending.length });
          settleDrain();
          pump();
        });
    }
    settleDrain();
  };

  return Object.freeze({
    name,
    concurrency: limit,

    /**
     * Xếp một việc vào hàng. Promise trả về resolve/reject theo chính việc đó,
     * nên caller vẫn bắt được lỗi như khi gọi trực tiếp.
     */
    add(job) {
      return new Promise((resolve, reject) => {
        pending.push({ job, resolve, reject });
        pump();
      });
    },

    // Độ sâu hàng đợi — số này đi vào heartbeat để Central biết node nào đang
    // quá tải trước khi phân bổ upload tiếp theo.
    stats() {
      return { name, concurrency: limit, running, waiting: pending.length };
    },

    // Dùng cho graceful shutdown và cho test.
    drain() {
      if (running === 0 && pending.length === 0) return Promise.resolve();
      return new Promise((resolve) => drainResolvers.push(resolve));
    },
  });
};

module.exports = Object.freeze({ create });
