'use strict';

// Test cho ba module nền của Phase 0: platform/log, platform/config, storage/paths.
// Chạy bằng `node --test tests/` — không dựng HTTP server, không đụng mạng.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const log = require('../platform/log');
const config = require('../platform/config');
const paths = require('../storage/paths');
const requestContext = require('../utils/requestContext');

// --- helper ------------------------------------------------------------------

// Bắt stdout/stderr để đọc đúng dòng JSON logger vừa in ra.
const captureLog = (fn) => {
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (line) => lines.push(String(line));
  console.error = (line) => lines.push(String(line));
  try {
    fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines;
};

const withEnv = (values, fn) => {
  const previous = {};
  Object.entries(values).forEach(([key, value]) => {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  config.reload();
  try {
    return fn();
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    config.reload();
  }
};

// =============================================================================
// platform/log
// =============================================================================

test('log: JSON format giữ đúng tên field của Central (time/level/scope/message)', () => {
  const lines = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    captureLog(() => log.child('unitTest').info('hello', { a: 1 }))
  );
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.level, 'info');
  assert.equal(entry.scope, 'unitTest');
  assert.equal(entry.message, 'hello');
  assert.deepEqual(entry.meta, { a: 1 });
  assert.ok(entry.time, 'phải có field `time` (Central dùng tên này, không phải `timestamp`)');
});

test('log: event() gắn thêm field `event` theo quy ước <domain>.<object>.<outcome>', () => {
  const lines = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    captureLog(() => log.child('media-contract-v2').event('upload.chunk.accepted', { chunkIndex: 0 }))
  );
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.event, 'upload.chunk.accepted');
  assert.equal(entry.message, 'upload.chunk.accepted');
  assert.deepEqual(entry.meta, { chunkIndex: 0 });
});

test('log: LOG_LEVEL cắt được dòng dưới ngưỡng — thứ console.log không làm được', () => {
  const lines = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'warn' }, () =>
    captureLog(() => {
      log.child('unitTest').info('bị cắt');
      log.child('unitTest').warn('được giữ');
    })
  );
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).message, 'được giữ');
});

test('log: field nhạy cảm bị che, Buffer không bị đổ nguyên nội dung ra log', () => {
  const lines = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    captureLog(() =>
      log.child('unitTest').info('req', {
        playerToken: 'eyJhbGciOi...',
        authorization: 'Bearer abc',
        body: Buffer.alloc(1024),
        safe: 'giữ nguyên',
      })
    )
  );
  const { meta } = JSON.parse(lines[0]);
  assert.equal(meta.playerToken, '[REDACTED]');
  assert.equal(meta.authorization, '[REDACTED]');
  assert.equal(meta.body, '[Buffer 1024 bytes]');
  assert.equal(meta.safe, 'giữ nguyên');
});

test('log: ngoài phạm vi request thì BỎ HẲN requestId, trong request thì có', () => {
  const outside = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    captureLog(() => log.child('unitTest').info('no request'))
  );
  assert.equal('requestId' in JSON.parse(outside[0]), false);

  const inside = withEnv({ LOG_FORMAT: 'json', LOG_LEVEL: 'info' }, () =>
    captureLog(() => requestContext.run({ requestId: 'trace-1' }, () => log.child('unitTest').info('in request')))
  );
  assert.equal(JSON.parse(inside[0]).requestId, 'trace-1');
});

// =============================================================================
// platform/config
// =============================================================================

test('config: công thức cổng ra đúng 9100 cho cả config.env thật lẫn khi thiếu env', () => {
  withEnv({ PORT: '9000', SERVERINDEX: '1', SERVERREP: '100' }, () => {
    assert.equal(config.get().port, 9100);
  });
  withEnv({ PORT: undefined, SERVERINDEX: undefined, SERVERREP: undefined }, () => {
    assert.equal(config.get().port, 9100);
  });
});

test('config: JITTER đọc ra SỐ, không phải chuỗi như process.env', () => {
  withEnv({ JITTER: '10' }, () => {
    assert.equal(typeof config.get().heartbeat.jitterMs, 'number');
    assert.equal(config.get().heartbeat.jitterMs, 10);
  });
});

test('config: heartbeat mặc định BẬT (lỗi cũ: chỉ chạy khi NODE_ENV=development)', () => {
  withEnv({ HEARTBEAT_ENABLED: undefined, NODE_ENV: 'deployment' }, () => {
    assert.equal(config.get().heartbeat.enabled, true);
  });
  withEnv({ HEARTBEAT_ENABLED: 'off' }, () => {
    assert.equal(config.get().heartbeat.enabled, false);
  });
});

test('config: inspect() chỉ ra biến thiếu thay vì để lỗi nổ giữa lúc encode', () => {
  withEnv({ JWT_SECRET: undefined, ENCODE_TYPE: undefined, CENTRAL_API: 'http://localhost:9000' }, () => {
    const problems = config.inspect();
    assert.ok(problems.some((line) => line.startsWith('JWT_SECRET:')));
    assert.ok(problems.some((line) => line.startsWith('ENCODE_TYPE:')));
    assert.throws(() => config.assertRequired(), /config\.env/);
  });
  withEnv({ JWT_SECRET: 'x', ENCODE_TYPE: '7', CENTRAL_API: 'http://localhost:9000' }, () => {
    assert.deepEqual(config.inspect(), []);
  });
});

test('config: AUTH_MODE lạ thì lùi về `off`, không phải bật nhầm enforce', () => {
  withEnv({ AUTH_MODE: 'ENFORCE' }, () => assert.equal(config.get().auth.mode, 'enforce'));
  withEnv({ AUTH_MODE: 'khong-biet' }, () => assert.equal(config.get().auth.mode, 'off'));
});

// =============================================================================
// storage/paths
// =============================================================================

test('paths: mediaRoot giữ NGUYÊN `videos/` — đó là `root` của nginx :9150', () => {
  withEnv({ MEDIA_ROOT: undefined, STAGING_ROOT: undefined }, () => {
    const mediaRoot = path.resolve(__dirname, '..', 'videos');
    // Ràng buộc không được phá: URL contract là :9150/videos/<key>/init.mpd.
    assert.equal(paths.mediaRoot(), mediaRoot);
    assert.equal(paths.mediaDir('key1'), path.join(mediaRoot, 'key1'));
    assert.equal(paths.mediaFile('key1', 'init.mpd'), path.join(mediaRoot, 'key1', 'init.mpd'));
  });
});

test('paths: [Phase 2] file tạm TÁCH khỏi thư mục nginx serve', () => {
  withEnv({ MEDIA_ROOT: undefined, STAGING_ROOT: undefined }, () => {
    const mediaRoot = path.resolve(__dirname, '..', 'videos');
    const staging = path.resolve(__dirname, '..', 'var', 'incoming');

    assert.notEqual(paths.stagingRoot(), mediaRoot, 'staging không được nằm trong thư mục nginx serve');
    assert.equal(paths.stagingRoot(), staging);
    assert.equal(paths.chunkPart('abc-1', 2), path.join(staging, 'abc-1.part.2'));
    assert.equal(paths.sourceFile('key1', 'mp4'), path.join(staging, 'key1.mp4'));
    assert.equal(paths.uploadMarker('abc-1'), path.join(staging, '.abc-1.accepted.json'));
    assert.equal(paths.jobFile('key1'), path.join(staging, '.key1.job.json'));
  });
});

test('paths: migration chỉ đụng file tạm, KHÔNG đụng nội dung DASH', () => {
  const os = require('os');
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'media-'));
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-'));

  // Nội dung thật (thư mục) + file tạm (file) nằm lẫn nhau, đúng như trước Phase 2.
  fs.mkdirSync(path.join(media, 'phim01'));
  fs.writeFileSync(path.join(media, 'phim01', 'init.mpd'), 'manifest');
  fs.writeFileSync(path.join(media, 'up-1.part.0'), 'chunk');
  fs.writeFileSync(path.join(media, '.up-1.accepted.json'), '{}');
  fs.writeFileSync(path.join(media, '.key1.job.json'), '{}');
  fs.writeFileSync(path.join(media, 'khong-lien-quan.txt'), 'giữ nguyên');

  withEnv({ MEDIA_ROOT: media, STAGING_ROOT: staging }, () => {
    const summary = paths.migrateLegacyStaging();
    assert.equal(summary.moved, 3);
    assert.equal(summary.failed, 0);
  });

  assert.ok(fs.existsSync(path.join(staging, 'up-1.part.0')));
  assert.ok(fs.existsSync(path.join(staging, '.up-1.accepted.json')));
  assert.ok(fs.existsSync(path.join(staging, '.key1.job.json')));
  assert.ok(fs.existsSync(path.join(media, 'phim01', 'init.mpd')), 'nội dung DASH phải nguyên vẹn');
  assert.ok(fs.existsSync(path.join(media, 'khong-lien-quan.txt')), 'file lạ không bị đụng');

  fs.rmSync(media, { recursive: true, force: true });
  fs.rmSync(staging, { recursive: true, force: true });
});

test('paths: chặn path traversal ngay trong hàm dựng path, không nhờ middleware', () => {
  assert.throws(() => paths.mediaDir('../../etc'), /storageKey is invalid/);
  assert.throws(() => paths.mediaDir('a/b'), /storageKey is invalid/);
  assert.throws(() => paths.mediaFile('key1', '../escape.mpd'), /fileName is invalid/);
  assert.throws(() => paths.sourceFile('', 'mp4'), /storageKey is invalid/);
  assert.throws(() => paths.chunkPart('abc', -1), /chunkIndex is invalid/);
  assert.throws(() => paths.chunkPart('abc', 'x'), /chunkIndex is invalid/);
});

test('paths: lỗi mang apiCode để Central rẽ nhánh được theo mã, không theo message', () => {
  try {
    paths.mediaDir('../../etc');
    assert.fail('phải ném lỗi');
  } catch (error) {
    assert.equal(error.statusCode, 400);
    assert.equal(error.apiCode, 'IDENTITY_INVALID');
  }
});

test('paths: assertInside không để `/videos-old` lọt qua vì trùng tiền tố `/videos`', () => {
  const root = path.resolve('/tmp/videos');
  assert.throws(() => paths.assertInside(root, path.resolve('/tmp/videos-old/x')), /escapes its storage root/);
  assert.equal(paths.assertInside(root, path.resolve('/tmp/videos/x')), path.resolve('/tmp/videos/x'));
});
