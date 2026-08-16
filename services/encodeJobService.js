'use strict';

// =============================================================================
// encodeJobService — vòng đời một job encode, từ lúc nhận tới lúc báo về Central.
//
//   accepted -> queued -> running -> ready | failed
//
// Mỗi lần đổi trạng thái đều ghi `<stagingRoot>/.<storageKey>.job.json`.
//
// -----------------------------------------------------------------------------
// 1. Vì sao phải có file trạng thái
// -----------------------------------------------------------------------------
// Bản cũ chạy fire-and-forget:
//     void encodeAPI.encodeIntoDashVer4(...).catch(...)
// Node restart giữa chừng (pm2 reload, VM reboot, OOM) là job biến mất KHÔNG
// ĐỂ LẠI DẤU VẾT. Video ở trạng thái "đã upload xong" mãi mãi, và không có cách
// nào biết ngoài việc vào node xem thư mục.
//
// `.job.json` được ghi TRƯỚC khi bắt đầu và TRƯỚC khi gọi callback, nên
// `reconcile()` lúc boot luôn tìm lại được các job dở dang.
//
// -----------------------------------------------------------------------------
// 2. Vì sao ghi atomic (tmp + rename)
// -----------------------------------------------------------------------------
// Mất điện đúng lúc `writeFile` đang chạy sẽ để lại JSON cụt. Lúc đó reconcile
// gặp file hỏng và, nếu không cẩn thận, sẽ chết ngay lúc khởi động — biến một
// job hỏng thành cả node hỏng. `rename` trong cùng filesystem là atomic trên cả
// POSIX lẫn NTFS, nên file hoặc là bản cũ nguyên vẹn, hoặc là bản mới nguyên vẹn.
//
// -----------------------------------------------------------------------------
// 3. Vì sao callback KHÔNG được phép làm hỏng job
// -----------------------------------------------------------------------------
// Encode xong là encode xong, kể cả khi Central đang chết. `deliveredToCentral`
// được lưu riêng để `reconcile()` gửi lại sau, thay vì coi cả job là thất bại.
// =============================================================================

const fs = require('fs');
const path = require('path');

const config = require('../platform/config');
const paths = require('../storage/paths');
const log = require('../platform/log');
const dashCommand = require('../media/dashCommand');
const encodeRunner = require('../media/encodeRunner');
const encodeQueue = require('../media/encodeQueue');
const probe = require('../media/probe');
const centralClient = require('../clients/centralClient');
const requestContext = require('../utils/requestContext');

const jobLog = log.child('encodeJob');

const CONTRACT_VERSION = 'stream-encode-v1';

const STATES = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  READY: 'ready',
  FAILED: 'failed',
});

// Một hàng đợi cho cả tiến trình. `config.get()` được đọc lúc tạo, tức là lúc
// require đầu tiên — sau `dotenv.config()` trong server.js.
let queue = null;
const getQueue = () => {
  if (!queue) queue = encodeQueue.create({ concurrency: config.get().encode.concurrency, name: 'dash-encode' });
  return queue;
};

// --- Lưu trạng thái ----------------------------------------------------------

const writeJobFile = (state) => {
  const target = paths.jobFile(state.storageKey);
  const temporary = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, target); // atomic
  return target;
};

const readJobFile = (storageKey) => {
  try {
    return JSON.parse(fs.readFileSync(paths.jobFile(storageKey), 'utf8'));
  } catch (error) {
    return null;
  }
};

const listJobFiles = () => {
  const root = paths.stagingRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith('.') && name.endsWith(paths.JOB_FILE_SUFFIX))
    .map((name) => path.join(root, name));
};

// --- Báo về Central ----------------------------------------------------------

const buildCallbackPayload = (state) => ({
  contractVersion: CONTRACT_VERSION,
  nodeId: config.get().nodeId,
  jobId: state.jobId,
  uploadId: state.uploadId,
  storageKey: state.storageKey,
  state: state.state,
  media: {
    videoId: state.videoId,
    infoId: state.infoId,
    type: state.mediaType,
    mediaDir: `videos/${state.storageKey}`,
    manifest: 'init.mpd',
    files: state.fileCount,
    durationSec: state.durationSec,
  },
  encode: {
    profile: state.profile,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    encodeSec: state.encodeSec,
  },
  error: state.error || null,
});

const deliver = async (state) => {
  if (!config.get().encode.callbackEnabled) {
    jobLog.debug('callback disabled', { storageKey: state.storageKey });
    return state;
  }

  const result = await centralClient.reportEncodeResult(buildCallbackPayload(state));
  const next = {
    ...state,
    deliveredToCentral: result.ok,
    deliveryAttemptedAt: new Date().toISOString(),
    deliveryError: result.ok ? null : { transport: result.transport, status: result.status, code: result.error?.code },
  };
  writeJobFile(next);

  if (result.ok) {
    jobLog.event('encode.result.delivered', { jobId: next.jobId, storageKey: next.storageKey, state: next.state });
  } else {
    // KHÔNG nâng lên `error`: job vẫn xong, chỉ là Central chưa biết. Việc chưa
    // giao được sẽ do `reconcile()` gánh ở lần khởi động sau.
    jobLog.warn('encode result not delivered; will retry on next reconcile', {
      jobId: next.jobId,
      storageKey: next.storageKey,
      transport: result.transport,
      status: result.status,
    });
  }
  return next;
};

// --- Chạy job ----------------------------------------------------------------

const countMediaFiles = (storageKey) => {
  try {
    const directory = paths.mediaDir(storageKey);
    return fs.readdirSync(directory).filter((name) => fs.statSync(path.join(directory, name)).isFile()).length;
  } catch (error) {
    return 0;
  }
};

const execute = async (initial) => {
  const profile = config.get().encode.type;
  let state = { ...initial, state: STATES.RUNNING, startedAt: new Date().toISOString(), profile };
  writeJobFile(state);
  jobLog.event('encode.job.started', { jobId: state.jobId, storageKey: state.storageKey, profile });

  // Probe TRƯỚC khi encode: file nguồn bị FFmpeg xoá ở cuối chuỗi lệnh cũ
  // (`fs.unlinkSync(filePath)` trong encodeIntoDashVer4), nên hỏi sau là muộn.
  const media = await probe.inspect(state.sourceFile);

  // [PHASE 3] `buildDashPlan` + `runPlan` chạy FFmpeg bằng ARGV, không qua shell.
  //
  // Đã kiểm chứng bằng encode thật (clip 12 giây, cùng profile): hai đường cho
  // ra 19 file giống hệt tên, manifest giống hệt nội dung, và segment đầu bằng
  // nhau từng byte. Nói cách khác đây là đổi CÁCH GỌI, không đổi kết quả.
  let plan;
  try {
    plan = dashCommand.buildDashPlan({
      profile,
      sourceFile: state.sourceFile,
      mediaDir: state.mediaDir,
      manifestPath: `${state.mediaDir}/init.mpd`,
    });
  } catch (error) {
    state = {
      ...state,
      state: STATES.FAILED,
      finishedAt: new Date().toISOString(),
      durationSec: media.durationSec,
      error: { code: error.apiCode || 'ENCODE_START_FAILED', message: error.message },
    };
    writeJobFile(state);
    jobLog.error('cannot build ffmpeg command', { jobId: state.jobId, storageKey: state.storageKey, message: error.message });
    return deliver(state);
  }

  fs.mkdirSync(state.mediaDir, { recursive: true });

  const result = await encodeRunner.runPlan(plan);

  state = {
    ...state,
    state: result.ok ? STATES.READY : STATES.FAILED,
    finishedAt: new Date().toISOString(),
    encodeSec: result.encodeSec,
    durationSec: media.durationSec,
    width: media.width,
    height: media.height,
    fileCount: result.ok ? countMediaFiles(state.storageKey) : 0,
    // `steps` cho biết BƯỚC NÀO hỏng — thumbnail, thumb.webp hay chính encode
    // DASH. Bản shell gộp cả ba vào một exit code duy nhất nên không phân biệt
    // được, và một node thiếu libwebp trông y hệt một node encode hỏng.
    steps: result.steps,
    error: result.ok
      ? null
      : {
          code: result.timedOut ? 'ENCODE_TIMEOUT' : 'ENCODE_FAILED',
          message: `ffmpeg step "${result.failedStep}" exit ${result.exitCode}${result.signal ? ` signal ${result.signal}` : ''}`,
          stderrTail: result.stderrTail,
        },
  };
  writeJobFile(state);

  if (result.ok) {
    // Chỉ xoá file nguồn KHI encode thành công. Bản cũ xoá vô điều kiện trong
    // `close` handler, kể cả khi exit code khác 0 — mất luôn khả năng chạy lại.
    try {
      if (fs.existsSync(state.sourceFile)) fs.unlinkSync(state.sourceFile);
    } catch (error) {
      jobLog.warn('cannot remove source file', { sourceFile: state.sourceFile, message: error.message });
    }
    jobLog.event('encode.job.ready', {
      jobId: state.jobId,
      storageKey: state.storageKey,
      encodeSec: state.encodeSec,
      durationSec: state.durationSec,
      files: state.fileCount,
    });
  } else {
    jobLog.error('encode failed', {
      event: 'encode.job.failed',
      jobId: state.jobId,
      storageKey: state.storageKey,
      failedStep: result.failedStep,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      steps: result.steps,
      // Chỉ vài dòng cuối — đúng phần cần đọc, xem media/encodeRunner.js.
      stderrTail: result.stderrTail,
    });
  }

  return deliver(state);
};

/**
 * Nhận một job. Trả về NGAY (không đợi encode) để controller kịp trả 202.
 *
 * `requestId` được chụp lại ở đây vì AsyncLocalStorage KHÔNG sống qua ranh giới
 * hàng đợi — lúc job thật sự chạy thì request HTTP đã kết thúc từ lâu. Chụp lại
 * rồi `run()` lần nữa là cách giữ được sợi trace xuyên suốt tới tận callback.
 */
const submit = ({ uploadId, storageKey, extension, videoId, infoId, mediaType }) => {
  const requestId = requestContext.getRequestId();
  const jobId = `encode-${Date.now()}-${storageKey}`;

  const initial = {
    contractVersion: CONTRACT_VERSION,
    jobId,
    uploadId,
    storageKey,
    videoId: videoId || null,
    infoId: infoId || null,
    mediaType: mediaType || 'DASH',
    sourceFile: paths.sourceFile(storageKey, extension),
    mediaDir: paths.mediaDir(storageKey),
    state: STATES.QUEUED,
    requestId,
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    encodeSec: null,
    durationSec: null,
    fileCount: 0,
    deliveredToCentral: false,
    error: null,
  };
  writeJobFile(initial);
  jobLog.event('encode.job.queued', { jobId, storageKey, ...getQueue().stats() });

  // Không await: caller trả 202 ngay. Lỗi ngoài dự kiến vẫn phải được ghi lại
  // chứ không thành unhandled rejection.
  getQueue()
    .add(() => (requestId ? requestContext.run({ requestId }, () => execute(initial)) : execute(initial)))
    .catch((error) => jobLog.error('job crashed outside its own error handling', { jobId, storageKey, message: error.message }));

  return { jobId, state: STATES.QUEUED, queue: getQueue().stats() };
};

/**
 * Chạy lúc khởi động. Hai việc:
 *
 *   1. Job còn ở `running` mà tiến trình đã chết -> đánh `failed`. Không có
 *      bước này thì `.job.json` nói "đang chạy" vĩnh viễn và không ai biết.
 *   2. Job đã xong nhưng chưa giao được cho Central -> gửi lại.
 *
 * KHÔNG BAO GIỜ throw: một file trạng thái hỏng không được phép chặn node khởi động.
 */
const reconcile = async () => {
  const summary = { scanned: 0, markedFailed: 0, redelivered: 0, corrupt: 0 };

  for (const file of listJobFiles()) {
    summary.scanned += 1;
    let state;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      summary.corrupt += 1;
      jobLog.warn('job file is unreadable; leaving it in place for inspection', { file, message: error.message });
      continue;
    }

    try {
      if (state.state === STATES.RUNNING || state.state === STATES.QUEUED) {
        const recovered = {
          ...state,
          state: STATES.FAILED,
          finishedAt: new Date().toISOString(),
          error: {
            code: 'ENCODE_INTERRUPTED',
            message: 'Tiến trình Node dừng giữa chừng (restart/OOM/reboot); job không tự chạy tiếp',
          },
        };
        writeJobFile(recovered);
        summary.markedFailed += 1;
        jobLog.event('encode.job.interrupted', { jobId: recovered.jobId, storageKey: recovered.storageKey });
        await deliver(recovered);
        continue;
      }

      if (state.deliveredToCentral === false) {
        const delivered = await deliver(state);
        if (delivered.deliveredToCentral) summary.redelivered += 1;
      }
    } catch (error) {
      jobLog.error('reconcile failed for one job', { file, message: error.message });
    }
  }

  if (summary.scanned) jobLog.event('encode.reconcile.done', summary);
  return summary;
};

module.exports = Object.freeze({
  CONTRACT_VERSION,
  STATES,
  submit,
  reconcile,
  buildCallbackPayload,
  readJobFile,
  listJobFiles,
  stats: () => getQueue().stats(),
  drain: () => getQueue().drain(),
});
