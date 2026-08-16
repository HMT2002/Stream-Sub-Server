'use strict';

// Test Phase 1: hàng đợi encode, công tắc chặn phát, dựng lệnh FFmpeg,
// và cam kết "media chỉ đi qua nginx".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase1-test-secret';

// Test này require `app.js`, và app khởi động vòng lặp heartbeat. Tắt tường
// minh: test không có Central để gọi, mỗi nhịp chỉ tạo ra một ECONNREFUSED và
// làm nhiễu output.
process.env.HEARTBEAT_ENABLED = 'off';

// Kho chặn phải trỏ vào thư mục tạm TRƯỚC khi require service — nếu không test
// sẽ ghi đè danh sách chặn thật của máy đang chạy.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'substore-'));
process.env.PLAYBACK_BLOCK_STORE = path.join(scratch, 'blocks.json');

const config = require('../platform/config');
config.reload();

const encodeQueue = require('../media/encodeQueue');
const dashCommand = require('../media/dashCommand');
const playbackBlocks = require('../services/playbackBlockService');
const authService = require('../services/authService');
const centralClient = require('../clients/centralClient');
const encodeRunner = require('../media/encodeRunner');

const resetBlocks = () => {
  if (fs.existsSync(process.env.PLAYBACK_BLOCK_STORE)) fs.unlinkSync(process.env.PLAYBACK_BLOCK_STORE);
  playbackBlocks._reset();
};

// =============================================================================
// media/encodeQueue
// =============================================================================

test('queue: concurrency 1 nghĩa là KHÔNG bao giờ có 2 FFmpeg chạy cùng lúc', async () => {
  const queue = encodeQueue.create({ concurrency: 1, name: 'test' });
  let running = 0;
  let peak = 0;

  const task = () =>
    new Promise((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setImmediate(() => {
        running -= 1;
        resolve();
      });
    });

  await Promise.all([queue.add(task), queue.add(task), queue.add(task), queue.add(task)]);
  assert.equal(peak, 1);
  assert.deepEqual(queue.stats(), { name: 'test', concurrency: 1, running: 0, waiting: 0 });
});

test('queue: concurrency 2 chạy song song đúng 2, phần còn lại xếp hàng', async () => {
  const queue = encodeQueue.create({ concurrency: 2 });
  let running = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      running += 1;
      peak = Math.max(peak, running);
      setTimeout(() => {
        running -= 1;
        resolve();
      }, 10);
    });
  await Promise.all([1, 2, 3, 4, 5].map(() => queue.add(task)));
  assert.equal(peak, 2);
});

test('queue: một job hỏng không được kéo cả hàng đợi theo', async () => {
  const queue = encodeQueue.create({ concurrency: 1 });
  const failure = queue.add(() => Promise.reject(new Error('boom')));
  await assert.rejects(failure, /boom/);

  // Hàng đợi vẫn chạy tiếp được sau khi một job ném lỗi.
  assert.equal(await queue.add(() => 'vẫn sống'), 'vẫn sống');
  await queue.drain();
  assert.equal(queue.stats().running, 0);
});

// =============================================================================
// media/dashCommand
// =============================================================================

test('dashCommand: chuỗi lệnh có đủ thumbnail, bản webp được phép hỏng, rồi mới encode DASH', () => {
  const command = dashCommand.buildDashCommand({
    profile: 7,
    sourceFile: '/srv/videos/abc123.mp4',
    mediaDir: '/srv/videos/abc123',
  });
  assert.match(command, /thumbnail\.png/);
  // `||` cho phép thumb.webp thất bại mà không làm hỏng exit code của cả chuỗi
  // — xem markdowns/encode_explain.md.
  assert.match(command, /\|\| echo \[encode\] thumb\.webp skipped/);
  assert.match(command, /-f dash "\/srv\/videos\/abc123\/init\.mpd"/);
  assert.match(command, /-adaptation_sets/);
});

test('dashCommand: từ chối tên file chứa ký tự có nghĩa với shell', () => {
  assert.throws(
    () => dashCommand.buildDashCommand({ profile: 7, sourceFile: '/srv/videos/a`whoami`.mp4', mediaDir: '/srv/videos/a' }),
    /shell metacharacters/
  );
  assert.throws(
    () => dashCommand.buildDashCommand({ profile: 7, sourceFile: '/srv/videos/a.mp4', mediaDir: '/srv/videos/a;rm -rf x' }),
    /shell metacharacters/
  );
});

// =============================================================================
// [Phase 3] argv thay cho shell
// =============================================================================

test('tokenize: tái tạo ĐÚNG những gì shell truyền cho ffmpeg', () => {
  // Trường hợp tinh tế nhất và là lý do cách này đúng: nháy giữa token là để
  // shell không nuốt `$`; bỏ nháy khi tokenize cho ra chuỗi ffmpeg cần.
  assert.deepEqual(dashCommand.tokenize('-init_seg_name init_"$"RepresentationID"$".m4s'), [
    '-init_seg_name',
    'init_$RepresentationID$.m4s',
  ]);
  // Nháy gộp khoảng trắng thành MỘT tham số.
  assert.deepEqual(dashCommand.tokenize('-adaptation_sets "id=0,streams=v id=1,streams=a"'), [
    '-adaptation_sets',
    'id=0,streams=v id=1,streams=a',
  ]);
  assert.deepEqual(dashCommand.tokenize('-map "[s0]"'), ['-map', '[s0]']);
  assert.deepEqual(dashCommand.tokenize('ffmpeg -i "/co khoang trang/a.mp4"'), [
    'ffmpeg',
    '-i',
    '/co khoang trang/a.mp4',
  ]);
});

test('buildDashPlan: ba bước, thumb.webp là bước ĐƯỢC PHÉP thất bại', () => {
  const plan = dashCommand.buildDashPlan({ profile: 7, sourceFile: '/v/abc.mp4', mediaDir: '/v/abc' });
  assert.deepEqual(
    plan.steps.map((step) => step.name),
    ['thumbnail.png', 'thumb.webp', 'dash']
  );
  assert.deepEqual(
    plan.steps.map((step) => step.optional),
    [false, true, false],
    'chỉ thumb.webp được phép hỏng — node thiếu libwebp không được giết cả encode'
  );
  plan.steps.forEach((step) => {
    assert.equal(step.file, 'ffmpeg');
    assert.ok(Array.isArray(step.args) && step.args.length > 0);
    // Không còn token nào mang ký tự điều khiển của shell.
    step.args.forEach((arg) => assert.doesNotMatch(String(arg), /&&|\|\|/));
  });
});

test('runPlan: bước tuỳ chọn hỏng thì đi tiếp; bước bắt buộc hỏng thì dừng', async () => {
  const okStep = (name) => ({ name, file: process.execPath, args: ['-e', 'process.exit(0)'], optional: false });
  const failStep = (name, optional) => ({ name, file: process.execPath, args: ['-e', 'process.exit(4)'], optional });

  const tolerated = await encodeRunner.runPlan({ steps: [failStep('optional-fail', true), okStep('after')] });
  assert.equal(tolerated.ok, true, 'bước optional hỏng không được dừng plan');
  assert.equal(tolerated.steps.length, 2);

  const stopped = await encodeRunner.runPlan({ steps: [failStep('required-fail', false), okStep('never-runs')] });
  assert.equal(stopped.ok, false);
  assert.equal(stopped.failedStep, 'required-fail');
  assert.equal(stopped.exitCode, 4);
  assert.equal(stopped.steps.length, 1, 'bước sau KHÔNG được chạy');
});

test('dashCommand: ENCODE_TYPE lạ rơi vào nhánh default (case 8 = libx264), KHÔNG phải lệnh rỗng', () => {
  // Khẳng định này thay cho ghi chú sai trong bản draft đầu tiên: `case 8` dùng
  // chung `default:`, nên một giá trị lạ vẫn ra lệnh hợp lệ — chỉ là dùng CPU
  // thay vì NVENC, im lặng và chỉ lộ ra ở thời gian encode.
  const command = dashCommand.buildDashCommand({ profile: 999, sourceFile: '/v/a.mp4', mediaDir: '/v/a' });
  assert.match(command, /libx264/);
  assert.doesNotMatch(command, /nvenc/);
});

// =============================================================================
// media/encodeRunner
// =============================================================================

test('runner: exit code khác 0 là DỮ LIỆU trả về, không phải exception', async () => {
  const result = await encodeRunner.run('node -e "process.exit(3)"', { label: 'test' });
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(typeof result.encodeSec, 'number');
});

test('runner: chỉ giữ N dòng stderr cuối, không giữ toàn bộ output', () => {
  const tail = encodeRunner.createTail(3);
  for (let i = 1; i <= 100; i += 1) tail.push(`dòng ${i}\n`);
  assert.deepEqual(tail.value(), ['dòng 98', 'dòng 99', 'dòng 100']);
});

// =============================================================================
// services/playbackBlockService — công tắc chặn
// =============================================================================

test('block: CHẶN THẬT ngay cả khi AUTH_MODE=off — đây là lý do module tồn tại', () => {
  resetBlocks();
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = 'off';
  try {
    // Trước khi chặn: off cho qua tất cả.
    const before = authService.verifyPlaybackToken({
      method: 'GET',
      headers: { 'x-original-uri': '/videos/phim01/chunk_0_00001.m4s' },
    });
    assert.equal(before.allow, true);

    playbackBlocks.add({ type: 'storageKey', value: 'phim01', reason: 'gỡ theo yêu cầu' });

    const after = authService.verifyPlaybackToken({
      method: 'GET',
      headers: { 'x-original-uri': '/videos/phim01/chunk_0_00001.m4s' },
    });
    assert.equal(after.allow, false, 'block phải thắng AUTH_MODE=off');
    assert.equal(after.code, 403);
    assert.equal(after.reason, 'blocked');
    assert.equal(after.enforced, true);

    // Video khác vẫn xem được — chặn có phạm vi, không phải tắt cả node.
    const other = authService.verifyPlaybackToken({
      method: 'GET',
      headers: { 'x-original-uri': '/videos/phim02/chunk_0_00001.m4s' },
    });
    assert.equal(other.allow, true);
  } finally {
    process.env.AUTH_MODE = previous;
    resetBlocks();
  }
});

test('block: sống qua restart — nạp lại từ đĩa cho ra đúng danh sách cũ', () => {
  resetBlocks();
  playbackBlocks.add({ type: 'ip', value: '10.1.2.3', reason: 'abuse' });
  assert.equal(playbackBlocks.stats().active, 1);

  // Mô phỏng `pm2 restart`: xoá sạch trạng thái RAM rồi nạp lại từ file.
  playbackBlocks._reset();
  assert.equal(playbackBlocks.stats().active, 1, 'RAM trống nhưng phải tự nạp lại từ đĩa');
  assert.equal(playbackBlocks.find('ip', '10.1.2.3').reason, 'abuse');
  resetBlocks();
});

test('block: hết hạn thì tự hết hiệu lực, không cần timer nền', () => {
  resetBlocks();
  const entry = playbackBlocks.add({ type: 'session', value: 'sess-1', ttlSeconds: 1 });
  assert.equal(playbackBlocks.find('session', 'sess-1').id, entry.id);

  // Lùi hạn về quá khứ thay vì ngồi chờ 1 giây.
  const store = JSON.parse(fs.readFileSync(process.env.PLAYBACK_BLOCK_STORE, 'utf8'));
  store.blocks[0].expiresAt = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(process.env.PLAYBACK_BLOCK_STORE, JSON.stringify(store));
  playbackBlocks._reset();

  assert.equal(playbackBlocks.find('session', 'sess-1'), null);
  assert.equal(playbackBlocks.hasBlocks(), false);
  resetBlocks();
});

test('block: từ chối type/value rác, kèm apiCode để Central rẽ nhánh được', () => {
  resetBlocks();
  assert.throws(() => playbackBlocks.add({ type: 'khong-biet', value: 'x' }), (error) => error.apiCode === 'BLOCK_TYPE_INVALID');
  assert.throws(() => playbackBlocks.add({ type: 'storageKey', value: '../../etc' }), (error) => error.apiCode === 'BLOCK_VALUE_INVALID');
  assert.throws(() => playbackBlocks.removeById('khong-ton-tai'), (error) => error.apiCode === 'BLOCK_NOT_FOUND');
  resetBlocks();
});

test('block: danh sách rỗng thì đường nóng không đụng gì tới cấu trúc dữ liệu', () => {
  resetBlocks();
  assert.equal(playbackBlocks.hasBlocks(), false);
  assert.deepEqual(playbackBlocks.evaluate({ sessionID: 'a', storageKey: 'b', ip: 'c' }), { blocked: false, entry: null });
});

test('authService: rút storageKey từ URL contract videos/<key>/...', () => {
  assert.equal(authService.storageKeyOf('videos/abc123/init.mpd'), 'abc123');
  assert.equal(authService.storageKeyOf('videos/abc123/chunk_0_00001.m4s'), 'abc123');
  assert.equal(authService.storageKeyOf(''), '');
});

// =============================================================================
// clients/centralClient — phân loại kết quả
// =============================================================================

test('centralClient: 404 của Central là CÂU TRẢ LỜI, ECONNREFUSED mới là không hỏi được', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { code: 'ROUTE_NOT_FOUND', message: 'chưa có endpoint' } }));
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  const previousApi = process.env.CENTRAL_API;
  const previousPath = process.env.ENCODE_CALLBACK_PATH;
  try {
    process.env.CENTRAL_API = `http://127.0.0.1:${port}`;
    process.env.ENCODE_CALLBACK_PATH = '/api/v2/nodes/jobs/result';
    config.reload();

    const answered = await centralClient.reportEncodeResult({ jobId: 'j1' });
    assert.equal(answered.transport, 'ok', 'tới được Central');
    assert.equal(answered.ok, false, 'nhưng Central từ chối');
    assert.equal(answered.status, 404);
    assert.equal(answered.error.code, 'ROUTE_NOT_FOUND');
    assert.equal(answered.attempt, 1, '404 KHÔNG đáng retry');
  } finally {
    server.close();
    process.env.CENTRAL_API = previousApi;
    process.env.ENCODE_CALLBACK_PATH = previousPath;
    config.reload();
  }
});

test('centralClient: backoff tăng dần và luôn nằm trong trần', () => {
  const { backoffDelay } = centralClient._private;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const delay = backoffDelay(attempt);
    assert.ok(delay > 0);
    assert.ok(delay <= centralClient.RETRY.maxDelayMs);
  }
  assert.ok(backoffDelay(1) < backoffDelay(4));
});

// =============================================================================
// Data plane: media KHÔNG được phục vụ bởi Node
// =============================================================================

// =============================================================================
// Trace xuyên multer — lỗi phát hiện 2026-08-16
// =============================================================================

test('trace: requestId SỐNG SÓT qua multer (AsyncLocalStorage mất context ở stream)', async () => {
  const previousHeartbeat = process.env.HEARTBEAT_ENABLED;
  process.env.HEARTBEAT_ENABLED = 'off';
  config.reload();

  const FormData = require('form-data');
  const app = require('../app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const uploadId = `tracetest${Date.now().toString(36)}`;
  const storageKey = `tracekey${Date.now().toString(36)}`;

  // Bắt log để xem dòng `upload.chunk.accepted` có mang requestId không.
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => {
    try {
      lines.push(JSON.parse(line));
    } catch (error) {
      /* dòng không phải JSON */
    }
  };

  try {
    const form = new FormData();
    form.append('multipartFileChunk', Buffer.from('xyz'), { filename: 'client-chosen.bin' });
    const response = await new Promise((resolve) => {
      const request = http.request(
        {
          port,
          path: '/api/v2/uploads/chunks',
          method: 'POST',
          headers: {
            'X-Upload-Contract': 'stream-upload-v2',
            'X-Upload-Id': uploadId,
            'X-Storage-Key': storageKey,
            'X-Media-Extension': 'mp4',
            'X-Chunk-Index': '0',
            'X-Chunk-Count': '2', // cố ý CHƯA đủ chunk -> không kích hoạt encode
            'X-Request-Id': 'trace-abc',
            ...form.getHeaders(),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }
      );
      form.pipe(request);
    });

    assert.equal(response.status, 202);
    assert.equal(response.headers['x-request-id'], 'trace-abc');

    const milestone = lines.find((entry) => entry.event === 'upload.chunk.accepted');
    assert.ok(milestone, 'phải có dòng log upload.chunk.accepted');
    assert.equal(milestone.requestId, 'trace-abc', 'requestId phải sống sót qua multer');
  } finally {
    console.log = originalLog;
    server.close();
    const paths = require('../storage/paths');
    try {
      fs.unlinkSync(paths.chunkPart(uploadId, 0));
    } catch (error) {
      /* đã dọn */
    }
    process.env.HEARTBEAT_ENABLED = previousHeartbeat;
    config.reload();
  }
});

test('data plane: Node trả 410 cho mọi đuôi media, để chỉ còn đúng một đường qua nginx', async () => {
  const previous = process.env.MEDIA_SERVING;
  process.env.MEDIA_SERVING = 'off';
  config.reload();

  // require sau khi đặt env: app.js đọc config lúc dựng route.
  const app = require('../app');
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;

  const get = (requestPath) =>
    new Promise((resolve) => {
      http.get({ port, path: requestPath }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
    });

  try {
    for (const requestPath of [
      '/videos/abc/chunk_0_00001.m4s',
      '/videos/abc/init.mpd',
      '/videos/abc/thumbnail.png',
      '/videos/abc/sub.vtt',
      '/dash-token/xyz/init.mpd',
    ]) {
      const response = await get(requestPath);
      assert.equal(response.status, 410, `${requestPath} phải bị từ chối`);
      assert.equal(JSON.parse(response.body).error.code, 'MEDIA_SERVING_DISABLED');
    }
  } finally {
    server.close();
    process.env.MEDIA_SERVING = previous;
    config.reload();
  }
});
