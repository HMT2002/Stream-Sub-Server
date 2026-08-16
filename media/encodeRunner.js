'use strict';

// =============================================================================
// encodeRunner — CHẠY một chuỗi lệnh FFmpeg và trả về kết quả đã phân loại.
//
// Tách khỏi phần dựng lệnh (`media/dashCommand.js`) và khỏi phần quản lý vòng
// đời job (`services/encodeJobService.js`). Module này chỉ biết: nhận chuỗi,
// spawn, đợi, trả `{ok, exitCode, encodeSec, stderrTail}`. Không fs, không HTTP.
//
// -----------------------------------------------------------------------------
// 1. Vì sao KHÔNG log mỗi data event của stderr
// -----------------------------------------------------------------------------
// `encodeAPI.encodeIntoDashVer4` cũ gọi `console.log` trong
// `process.stderr.on('data')`. FFmpeg in tiến độ liên tục, nên một lần encode
// phim dài sinh ra hàng nghìn dòng log — trong đó 99% vô dụng, và đúng phần cần
// đọc (vài dòng cuối trước khi chết) thì bị chôn ở giữa.
//
// Ở đây dùng VÒNG ĐỆM N dòng cuối. Khi exit code = 0 thì vứt; khi khác 0 thì đó
// chính xác là thứ duy nhất cần xem.
//
// -----------------------------------------------------------------------------
// 2. Vì sao có timeout
// -----------------------------------------------------------------------------
// Bản cũ không có. Một FFmpeg treo (input hỏng, GPU bận, ổ đĩa đầy) sẽ giữ chỗ
// trong hàng đợi vĩnh viễn và chặn mọi upload sau đó — mà không có tín hiệu nào.
// Hết giờ thì `SIGKILL` và báo `failed`, để job sau còn chạy được.
//
// -----------------------------------------------------------------------------
// 3. `shell: true` — có chủ đích, không phải sơ suất
// -----------------------------------------------------------------------------
// Chuỗi lệnh chứa `&&` và `||` (luật "thumbnail nhỏ được phép thất bại", xem
// markdowns/encode_explain.md), nên cần shell diễn giải. Đầu vào đã được
// `dashCommand.assertSafeCommandInput` lọc. Bỏ shell là việc của Phase 2.
// =============================================================================

const { spawn } = require('child_process');
const log = require('../platform/log');

const runnerLog = log.child('encodeRunner');

const STDERR_TAIL_LINES = 50;
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 giờ: đủ cho phim dài trên CPU

// Vòng đệm giữ N dòng cuối, không giữ toàn bộ output.
const createTail = (maxLines) => {
  const lines = [];
  let pending = '';
  return {
    push(chunk) {
      pending += String(chunk);
      const parts = pending.split(/\r?\n|\r/);
      pending = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        lines.push(line);
        if (lines.length > maxLines) lines.shift();
      }
    },
    value() {
      const all = pending.trim() ? [...lines, pending.trim()] : lines;
      return all.slice(-maxLines);
    },
  };
};

/**
 * Chạy một chuỗi lệnh. KHÔNG BAO GIỜ throw — luôn resolve về một object đã phân
 * loại, giống nguyên tắc của `clients/nodeClient.js` bên Central: một tiến trình
 * trả exit code khác 0 là CÂU TRẢ LỜI, không phải sự cố của hệ thống.
 */
const run = (command, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'ffmpeg' } = {}) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const tail = createTail(STDERR_TAIL_LINES);
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, encodeSec: Math.round((Date.now() - startedAt) / 100) / 10, startedAt });
    };

    let child;
    try {
      child = spawn(command, [], { shell: true, windowsHide: true });
    } catch (error) {
      runnerLog.error(`${label} spawn failed`, error);
      return finish({ ok: false, exitCode: null, signal: null, timedOut: false, stderrTail: [String(error.message)] });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      runnerLog.error(`${label} timed out`, { timeoutMs });
      // SIGKILL chứ không SIGTERM: ffmpeg đang ghi file có thể lờ SIGTERM và
      // tiếp tục giữ chỗ trong hàng đợi.
      try {
        child.kill('SIGKILL');
      } catch (error) {
        /* tiến trình đã chết */
      }
    }, timeoutMs);

    child.stdout.on('data', (data) => tail.push(data));
    child.stderr.on('data', (data) => tail.push(data));

    child.on('error', (error) => {
      clearTimeout(timer);
      runnerLog.error(`${label} process error`, error);
      finish({ ok: false, exitCode: null, signal: null, timedOut, stderrTail: [String(error.message)] });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, stderrTail: tail.value() });
    });
  });

/**
 * [PHASE 3] Chạy một bước bằng ARGV — KHÔNG qua shell.
 *
 * Khác `run()` ở đúng một điểm quyết định: `shell` không có mặt, nên không có
 * tiến trình nào diễn giải chuỗi. Ký tự `;`, backtick, `&&` trong tên file (nếu
 * lọt qua được mọi lớp kiểm tra) chỉ còn là ký tự trong một tham số.
 */
const runStep = (step, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const tail = createTail(STDERR_TAIL_LINES);
    let settled = false;
    let timedOut = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, name: step.name, encodeSec: Math.round((Date.now() - startedAt) / 100) / 10 });
    };

    let child;
    try {
      child = spawn(step.file, step.args, { windowsHide: true });
    } catch (error) {
      return finish({ ok: false, exitCode: null, signal: null, timedOut: false, stderrTail: [String(error.message)] });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      runnerLog.error(`${step.name} timed out`, { timeoutMs });
      try {
        child.kill('SIGKILL');
      } catch (error) {
        /* đã chết */
      }
    }, timeoutMs);

    child.stdout.on('data', (data) => tail.push(data));
    child.stderr.on('data', (data) => tail.push(data));

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, exitCode: null, signal: null, timedOut, stderrTail: [String(error.message)] });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      finish({ ok: exitCode === 0 && !timedOut, exitCode, signal, timedOut, stderrTail: tail.value() });
    });
  });

/**
 * Chạy tuần tự các bước của một plan.
 *
 * Luật "bước tuỳ chọn được phép thất bại" nay viết bằng JavaScript thay vì
 * bằng `||` của shell. Bản shell phải dựa vào việc `echo` luôn trả exit code 0
 * để chuỗi đi tiếp — ở đây ý định được nói thẳng ra bằng `step.optional`, và
 * không phụ thuộc vào việc cmd.exe với /bin/sh có hiểu `||` giống nhau không.
 *
 * KHÔNG BAO GIỜ throw. Trả kết quả tổng hợp có `steps` để biết bước nào hỏng.
 */
const runPlan = async (plan, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const startedAt = Date.now();
  const steps = [];

  for (const step of plan.steps) {
    const result = await runStep(step, { timeoutMs });
    steps.push({
      name: result.name,
      ok: result.ok,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      optional: step.optional,
      encodeSec: result.encodeSec,
    });

    if (result.ok) continue;

    if (step.optional) {
      // Đúng nhánh `|| echo [encode] thumb.webp skipped` của bản shell: ghi
      // nhận rồi đi tiếp. Node thiếu libwebp không được phép làm hỏng cả encode.
      runnerLog.warn(`${step.name} failed but is optional; continuing`, {
        exitCode: result.exitCode,
        stderrTail: result.stderrTail.slice(-5),
      });
      continue;
    }

    return {
      ok: false,
      failedStep: step.name,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      stderrTail: result.stderrTail,
      steps,
      encodeSec: Math.round((Date.now() - startedAt) / 100) / 10,
    };
  }

  return {
    ok: true,
    failedStep: null,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stderrTail: [],
    steps,
    encodeSec: Math.round((Date.now() - startedAt) / 100) / 10,
  };
};

module.exports = Object.freeze({ run, runStep, runPlan, createTail, STDERR_TAIL_LINES, DEFAULT_TIMEOUT_MS });
