'use strict';

// =============================================================================
// replicationService — Sub NGUỒN đọc thư mục media và đẩy từng file sang Sub ĐÍCH.
//
// Source KHÔNG query DB: mọi thứ cần biết nằm trong `command` do Central gửi
// (`markdowns/upload-replication-contract-v2.md` §4).
//
// LUẬT ACK: chỉ trả kết quả khi MỌI file được đích xác nhận đúng
// `jobId`/`storageKey`/`fileName`. Central kiểm lại `filesSent > 0` trước khi
// cập nhật placement — nếu source báo thành công lỏng lẻo thì DB sẽ ghi là đã
// có bản sao trong khi đĩa đích thiếu file, và lỗi chỉ lộ ra lúc người xem bấm
// play.
//
// [UPDATED 2026-08-16] Đường dẫn chuyển sang `storage/paths`; log chuyển sang
// `platform/log`. Hành vi HTTP không đổi.
// =============================================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const AppError = require('../utils/appError');
const requestContext = require('../utils/requestContext');
const paths = require('../storage/paths');
const log = require('../platform/log');
const nodeAuth = require('../platform/nodeAuth');
const config = require('../platform/config');

const replicationLog = log.child('replicationService');

// Contract v2 §4: source giữ HTTP mở tối đa 120 giây cho mỗi file. `server.js`
// đặt `server.timeout = 125000` và nginx `proxy_read_timeout 180s` để khớp —
// đổi số này thì phải đổi cả hai chỗ kia, nếu không đích sẽ bị cắt giữa chừng.
const TRANSFER_TIMEOUT_MS = 120000;

/**
 * @deprecated 2026-08-16 — dùng `storage/paths.assertToken(value,'storageKey')`.
 * Giữ export để không phá call site/test cũ.
 * Xoá khi: không còn nơi nào require tên này.
 */
const safeStorageKey = (value) => paths.assertToken(value, 'storageKey');

const assertReceiveUrl = (receiveUrl) => {
  let parsed;
  try {
    parsed = new URL(receiveUrl);
  } catch (error) {
    throw new AppError('destination.receiveUrl is invalid', 400, 'DESTINATION_URL_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AppError('destination.receiveUrl protocol is invalid', 400, 'DESTINATION_URL_INVALID');
  }
  return parsed;
};

// Đích phải xác nhận ĐÚNG file vừa gửi, không chỉ "trả 2xx". Một đích trả 200
// rỗng, hoặc ack nhầm file khác, đều là thất bại.
const isValidAcknowledgement = (response, { jobId, storageKey, fileName }) => {
  if (response.status < 200 || response.status >= 300) return false;
  if (response.data?.ok !== true) return false;
  const ack = response.data?.data;
  return ack?.jobId === jobId && ack?.storageKey === storageKey && ack?.fileName === fileName && ack?.received === true;
};

const sendFolder = async (command) => {
  if (command.contractVersion !== 'stream-replication-v2') {
    throw new AppError('stream-replication-v2 contract is required', 400, 'CONTRACT_VERSION_REQUIRED');
  }
  const jobId = paths.assertToken(command.jobId, 'jobId');
  const storageKey = paths.assertToken(command.video?.storageKey, 'storageKey');
  const receiveUrl = command.destination?.receiveUrl;
  assertReceiveUrl(receiveUrl);

  const folder = paths.mediaDir(storageKey);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new AppError('Video folder not found', 404, 'MEDIA_NOT_FOUND');
  }

  const files = fs
    .readdirSync(folder)
    .filter((name) => fs.statSync(path.join(folder, name)).isFile())
    .sort();

  replicationLog.info('sending folder', { jobId, storageKey, fileCount: files.length });

  const results = [];
  for (const fileName of files) {
    const form = new FormData();
    form.append('replicationFile', fs.createReadStream(path.join(folder, fileName)));

    const response = await axios.post(receiveUrl, form, {
      timeout: TRANSFER_TIMEOUT_MS,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      // Status là DỮ LIỆU, không phải exception — cùng nguyên tắc với
      // `clients/nodeClient.js` của Central. Để axios ném thì một 404 hợp lệ
      // của đích lẫn lộn với "đích chết", hai chuyện hoàn toàn khác nhau.
      validateStatus: () => true,
      headers: {
        ...form.getHeaders(),
        'X-Replication-Contract': 'stream-replication-v2',
        'X-Job-Id': jobId,
        'X-Storage-Key': storageKey,
        'X-File-Name': fileName,
        'X-Video-Id': command.video?.id || '',
        // Hop thứ hai của chuỗi Central → source Sub → destination Sub. Thiếu
        // header này thì trace đứt đúng ở đoạn truyền dữ liệu thật.
        ...requestContext.getTraceHeaders(),
        // [THÊM 2026-08-16 Phase 2] Ký chặng Sub → Sub. Node đích bật
        // `NODE_AUTH_MODE=enforce` sẽ từ chối file không có chữ ký — nếu không,
        // bất kỳ ai cũng đẩy được nội dung tuỳ ý vào `videos/<storageKey>` của
        // node khác. Ký theo `jobId` nên chữ ký của job này không dùng lại được
        // cho job khác.
        ...nodeAuth.signRequest({
          method: 'POST',
          path: new URL(receiveUrl).pathname,
          contractVersion: 'stream-replication-v2',
          primaryId: jobId,
          nodeId: config.get().nodeId,
        }),
      },
    });

    if (!isValidAcknowledgement(response, { jobId, storageKey, fileName })) {
      replicationLog.error('destination rejected file', {
        jobId,
        storageKey,
        fileName,
        status: response.status,
        code: response.data?.error?.code,
      });
      throw new AppError(`Destination rejected ${fileName}`, 502, 'DESTINATION_REJECTED');
    }
    results.push({ fileName, status: response.status });
  }

  return { jobId, storageKey, filesSent: results.length, files: results };
};

module.exports = Object.freeze({
  get videosRoot() {
    return paths.mediaRoot();
  },
  TRANSFER_TIMEOUT_MS,
  safeStorageKey,
  isValidAcknowledgement,
  sendFolder,
});
