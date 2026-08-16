'use strict';

// =============================================================================
// probe — hỏi ffprobe về file nguồn.
//
// -----------------------------------------------------------------------------
// Vì sao KHÔNG dùng fluent-ffmpeg như bản cũ
// -----------------------------------------------------------------------------
// `modules/encodeAPI.js` đặt `fluentFfmpeg.setFfmpegPath('..\\ffmpeg.exe')` —
// đường dẫn Windows tương đối, hardcode, trong khi dòng
// `require('@ffmpeg-installer/ffmpeg')` ngay trên đã bị comment. Lệnh encode
// thật không dính vì nó đi qua `spawn(... shell:true)` gọi `ffmpeg` trong PATH,
// nhưng `fluentFfmpeg.ffprobe()` thì đi qua fluent-ffmpeg.
//
// Quan trọng hơn: bản cũ gọi ffprobe theo kiểu callback KHÔNG await
// (`encodeAPI.js` đặt `videoDuration` trong callback rồi đọc biến đó ở chỗ
// khác), nên `videoDuration` gần như luôn còn là 0 khi được ghi ra log. Con số
// "encode 812 giây cho video 0 giây" trong log cũ đến từ đây.
//
// Ở đây gọi thẳng binary `ffprobe` trong PATH, có await, có timeout, và KHÔNG
// BAO GIỜ throw: không lấy được thời lượng thì trả `null`. Thời lượng chỉ là
// thông tin báo cáo — để nó làm hỏng cả job encode là sai tỷ lệ.
// =============================================================================

const { execFile } = require('child_process');
const log = require('../platform/log');

const probeLog = log.child('probe');

const PROBE_TIMEOUT_MS = 30000;

// Dùng execFile với MẢNG tham số (không shell) — ở đây không cần `&&`/`||` nên
// không có lý do gì đi qua shell, và mảng argv thì đường dẫn có ký tự lạ cũng
// không thể thoát ra thành lệnh khác.
const runFfprobe = (sourceFile) =>
  new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height',
      '-of', 'json',
      sourceFile,
    ];
    execFile('ffprobe', args, { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) return resolve({ ok: false, error: error.message, raw: null });
      try {
        return resolve({ ok: true, error: null, raw: JSON.parse(stdout) });
      } catch (parseError) {
        return resolve({ ok: false, error: `ffprobe output is not JSON: ${parseError.message}`, raw: null });
      }
    });
  });

/**
 * Trả `{ durationSec, width, height, videoCodec, audioCodec }`, mọi field có thể
 * là null. KHÔNG throw.
 */
const inspect = async (sourceFile) => {
  const result = await runFfprobe(sourceFile);
  if (!result.ok) {
    // `warn` chứ không `error`: không probe được thì encode vẫn chạy bình thường.
    probeLog.warn('ffprobe failed', { sourceFile, message: result.error });
    return { durationSec: null, width: null, height: null, videoCodec: null, audioCodec: null, probed: false };
  }

  const streams = Array.isArray(result.raw?.streams) ? result.raw.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video') || null;
  const audio = streams.find((stream) => stream.codec_type === 'audio') || null;
  const duration = Number(result.raw?.format?.duration);

  return {
    durationSec: Number.isFinite(duration) ? Math.round(duration * 10) / 10 : null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    probed: true,
  };
};

module.exports = Object.freeze({ inspect, PROBE_TIMEOUT_MS });
