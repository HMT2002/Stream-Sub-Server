const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'auth-test-secret';

const authService = require('../services/authService');
const blacklist = require('../globals/blacklist');

const sign = (claims, options = {}) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '5m', ...options });

// nginx gửi URI gốc qua header này; test mô phỏng đúng hình dạng đó thay vì
// truyền `uri` trực tiếp, để bắt được lỗi nếu ai đó đổi tên header.
const verify = (originalUri, extraHeaders = {}) =>
  authService.verifyPlaybackToken({
    method: 'GET',
    headers: { 'x-original-uri': originalUri, ...extraHeaders },
  });

const withMode = (mode, fn) => {
  const previous = process.env.AUTH_MODE;
  process.env.AUTH_MODE = mode;
  try {
    return fn();
  } finally {
    process.env.AUTH_MODE = previous;
  }
};

test('mode off cho qua tất cả, kể cả khi không có token', () => {
  withMode('off', () => {
    const result = verify('/videos/abc/chunk_0_00001.m4s');
    assert.equal(result.allow, true);
    assert.equal(result.code, 204);
  });
});

test('enforce: thiếu token trả 401 để player biết đường đi xin token mới', () => {
  withMode('enforce', () => {
    const result = verify('/videos/abc/chunk_0_00001.m4s');
    assert.equal(result.allow, false);
    assert.equal(result.code, 401);
    assert.equal(result.reason, 'no-token');
  });
});

test('enforce: chữ ký sai là 401, không phải 403', () => {
  withMode('enforce', () => {
    const forged = jwt.sign({ url: 'videos/abc' }, 'wrong-secret');
    const result = verify(`/videos/abc/init.mpd?token=${forged}`);
    assert.equal(result.code, 401);
    assert.equal(result.reason, 'bad-signature');
  });
});

test('enforce: token hết hạn là 401 (retry có ý nghĩa), không phải 403', () => {
  withMode('enforce', () => {
    const expired = sign({ url: 'videos/abc' }, { expiresIn: '-1h' });
    const result = verify(`/videos/abc/init.mpd?token=${expired}`);
    assert.equal(result.code, 401);
    assert.equal(result.reason, 'expired');
  });
});

test('enforce: token hợp lệ và đúng thư mục thì cho qua', () => {
  withMode('enforce', () => {
    const token = sign({ url: 'videos/abc', sessionID: 'sess-ok' });
    const result = verify(`/videos/abc/chunk_0_00001.m4s?token=${token}`);
    assert.equal(result.allow, true);
    assert.equal(result.code, 204);
    assert.equal(result.claims.sessionID, 'sess-ok');
  });
});

test('enforce: token của phim A KHÔNG mở được phim B (403, không phải 401)', () => {
  withMode('enforce', () => {
    const token = sign({ url: 'videos/abc' });
    const result = verify(`/videos/khac/chunk_0_00001.m4s?token=${token}`);
    assert.equal(result.code, 403);
    assert.equal(result.reason, 'resource-mismatch');
  });
});

test('enforce: token không có ràng buộc tài nguyên nào bị coi là không hợp lệ', () => {
  withMode('enforce', () => {
    const token = sign({ sessionID: 'sess-no-acl' });
    const result = verify(`/videos/abc/init.mpd?token=${token}`);
    assert.equal(result.code, 403);
    assert.equal(result.reason, 'resource-mismatch');
  });
});

test('enforce: path traversal bị chặn trước cả khi so ACL', () => {
  withMode('enforce', () => {
    const token = sign({ url: 'videos/abc' });
    const result = verify(`/videos/abc/../khac/secret.m4s?token=${token}`);
    assert.equal(result.code, 403);
    assert.equal(result.reason, 'malformed-uri');
  });
});

test('enforce: token đọc được từ header X-Player-Token, ưu tiên hơn query', () => {
  withMode('enforce', () => {
    const good = sign({ url: 'videos/abc' });
    const bad = jwt.sign({ url: 'videos/abc' }, 'wrong-secret');
    const result = verify(`/videos/abc/init.mpd?token=${bad}`, { 'x-player-token': good });
    assert.equal(result.allow, true);
  });
});

test('enforce: phiên đã bị thu hồi trả 403 session-revoked', () => {
  withMode('enforce', () => {
    const sessionID = `sess-revoked-${process.pid}`;
    blacklist.AddToBlacklist({ sessionID });
    try {
      const token = sign({ url: 'videos/abc', sessionID });
      const result = verify(`/videos/abc/init.mpd?token=${token}`);
      assert.equal(result.code, 403);
      assert.equal(result.reason, 'session-revoked');
    } finally {
      blacklist.RemoveFromBlacklist({ sessionID });
    }
  });
});

test('mode log: vẫn cho qua nhưng giữ nguyên lý do để đếm', () => {
  withMode('log', () => {
    const result = verify('/videos/abc/chunk_0_00001.m4s');
    assert.equal(result.allow, true, 'mode log không được chặn');
    assert.equal(result.enforced, false);
    assert.equal(result.reason, 'no-token', 'phải giữ lý do để thống kê trước khi bật enforce');
  });
});

test('ACL dạng mảng và wildcard hoạt động cho token mở nhiều thư mục', () => {
  withMode('enforce', () => {
    const token = sign({ acl: ['videos/phim-a', 'videos/audio-*'] });
    assert.equal(verify(`/videos/phim-a/init.mpd?token=${token}`).allow, true);
    assert.equal(verify(`/videos/audio-vi/chunk.m4s?token=${token}`).allow, true);
    assert.equal(verify(`/videos/phim-b/init.mpd?token=${token}`).allow, false);
  });
});
