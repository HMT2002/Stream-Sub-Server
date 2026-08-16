'use strict';

// Test `platform/nodeAuth.js` — và ĐỐI CHIẾU với bản sao bên Central.
//
// Test đối chiếu là thứ quan trọng nhất ở đây: hai repo giữ hai bản của cùng
// một thuật toán, và nếu chúng lệch nhau thì triệu chứng duy nhất là "401 hết"
// trên production, không có gì chỉ ra nguyên nhân.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.NODE_SHARED_SECRET = 'test-shared-secret';

const nodeAuth = require('../platform/nodeAuth');

const CENTRAL_NODE_AUTH = path.resolve(
  __dirname,
  '..',
  '..',
  'Stream-Central-Server',
  'backend',
  'utils',
  'nodeAuth.js'
);

const withMode = (mode, fn) => {
  const previous = process.env.NODE_AUTH_MODE;
  process.env.NODE_AUTH_MODE = mode;
  try {
    return fn();
  } finally {
    process.env.NODE_AUTH_MODE = previous;
  }
};

const requestFields = {
  method: 'POST',
  path: '/api/v2/replications/receive-file',
  contractVersion: 'stream-replication-v2',
  primaryId: 'replicate-1786-abc',
};

// =============================================================================
// Node-to-node
// =============================================================================

test('nodeAuth: chữ ký hợp lệ được chấp nhận ở enforce', () => {
  withMode('enforce', () => {
    const headers = nodeAuth.signRequest({ ...requestFields, nodeId: 'central' });
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const result = nodeAuth.verifyRequest({ ...requestFields, headers: lower });
    assert.equal(result.allow, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.nodeId, 'central');
  });
});

test('nodeAuth: chữ ký của job KHÁC không dùng lại được', () => {
  withMode('enforce', () => {
    const headers = nodeAuth.signRequest({ ...requestFields, primaryId: 'job-A', nodeId: 'central' });
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    // Cùng chữ ký, nhưng đem sang job-B: phải trượt.
    const result = nodeAuth.verifyRequest({ ...requestFields, primaryId: 'job-B', headers: lower });
    assert.equal(result.allow, false);
    assert.equal(result.reason, nodeAuth.DENY.BAD_SIGNATURE);
  });
});

test('nodeAuth: chữ ký của đường dẫn KHÁC không dùng lại được', () => {
  withMode('enforce', () => {
    const headers = nodeAuth.signRequest({ ...requestFields, nodeId: 'central' });
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const result = nodeAuth.verifyRequest({
      ...requestFields,
      path: '/api/v2/replications/send-folder',
      headers: lower,
    });
    assert.equal(result.allow, false);
  });
});

test('nodeAuth: timestamp ngoài cửa sổ bị từ chối (chống phát lại)', () => {
  withMode('enforce', () => {
    const stale = Math.floor(Date.now() / 1000) - (nodeAuth.DEFAULT_SKEW_SEC + 60);
    const headers = nodeAuth.signRequest({ ...requestFields, nodeId: 'central', timestamp: stale });
    const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const result = nodeAuth.verifyRequest({ ...requestFields, headers: lower });
    assert.equal(result.reason, nodeAuth.DENY.EXPIRED);
    assert.equal(result.allow, false);
  });
});

test('nodeAuth: mode off cho qua tất cả; mode log cho qua nhưng nói rõ lý do', () => {
  withMode('off', () => {
    const result = nodeAuth.verifyRequest({ ...requestFields, headers: {} });
    assert.equal(result.allow, true);
    assert.equal(result.reason, 'ok');
  });
  withMode('log', () => {
    const result = nodeAuth.verifyRequest({ ...requestFields, headers: {} });
    assert.equal(result.allow, true, 'log vẫn cho qua');
    assert.equal(result.enforced, false);
    assert.equal(result.reason, nodeAuth.DENY.NO_SIGNATURE, 'nhưng phải ghi nhận lý do');
  });
});

test('nodeAuth: bật enforce mà quên đặt khoá thì báo lý do RIÊNG, không lẫn với chữ ký sai', () => {
  const previousSecret = process.env.NODE_SHARED_SECRET;
  delete process.env.NODE_SHARED_SECRET;
  try {
    withMode('enforce', () => {
      const result = nodeAuth.verifyRequest({ ...requestFields, headers: { 'x-node-auth': 'v1=deadbeef' } });
      assert.equal(result.reason, nodeAuth.DENY.NO_SECRET);
    });
  } finally {
    process.env.NODE_SHARED_SECRET = previousSecret;
  }
});

// =============================================================================
// Upload session (Central ký → FE chuyển tiếp → Sub verify)
// =============================================================================

const session = { uploadId: 'up-1', storageKey: 'abc123', extension: 'mp4', chunkCount: 3, videoId: 'v-1' };

test('upload session: token hợp lệ qua được', () => {
  withMode('enforce', () => {
    const token = nodeAuth.signUploadSession(session);
    assert.equal(nodeAuth.verifyUploadSession(token, session).allow, true);
  });
});

test('upload session: FE KHÔNG sửa được chunkCount — thứ điều khiển thời điểm ghép file', () => {
  withMode('enforce', () => {
    const token = nodeAuth.signUploadSession(session);
    // Sửa chunkCount xuống 1 = ép Sub coi chunk đầu là đủ, ghép file dở dang
    // rồi đem đi encode.
    const tampered = nodeAuth.verifyUploadSession(token, { ...session, chunkCount: 1 });
    assert.equal(tampered.allow, false);
    assert.equal(tampered.reason, nodeAuth.DENY.BAD_SIGNATURE);
  });
});

test('upload session: FE KHÔNG bịa được storageKey của video khác', () => {
  withMode('enforce', () => {
    const token = nodeAuth.signUploadSession(session);
    const result = nodeAuth.verifyUploadSession(token, { ...session, storageKey: 'phim-cua-nguoi-khac' });
    assert.equal(result.allow, false);
  });
});

test('upload session: hết hạn thì trượt', () => {
  withMode('enforce', () => {
    const token = nodeAuth.signUploadSession({ ...session, ttlSeconds: -10 });
    assert.equal(nodeAuth.verifyUploadSession(token, session).reason, nodeAuth.DENY.EXPIRED);
  });
});

// =============================================================================
// ĐỐI CHIẾU HAI REPO — test quan trọng nhất của file này
// =============================================================================

test('parity: bản Central tồn tại và sinh ra CÙNG chữ ký với bản Sub', (t) => {
  if (!fs.existsSync(CENTRAL_NODE_AUTH)) {
    // Không fail: repo Sub phải build/test được một mình. Nhưng phải nói rõ là
    // đã bỏ qua, không im lặng cho qua.
    t.skip(`Không tìm thấy ${CENTRAL_NODE_AUTH} — bỏ qua đối chiếu`);
    return;
  }

  const centralAuth = require(CENTRAL_NODE_AUTH);

  // 1. Chuỗi canonical phải giống hệt — đây là chỗ dễ lệch nhất.
  const requestCanonical = { ...requestFields, timestamp: 1786859819 };
  assert.equal(
    centralAuth.canonicalRequest(requestCanonical),
    nodeAuth.canonicalRequest(requestCanonical),
    'canonicalRequest lệch giữa hai repo -> mọi chữ ký node-to-node sẽ sai'
  );

  const sessionCanonical = { ...session, expiresAt: 1786859819 };
  assert.equal(
    centralAuth.canonicalUploadSession(sessionCanonical),
    nodeAuth.canonicalUploadSession(sessionCanonical),
    'canonicalUploadSession lệch -> mọi upload sẽ bị từ chối'
  );

  // 2. Central ký, Sub verify — đúng chiều dùng thật cho lệnh replication.
  withMode('enforce', () => {
    const centralHeaders = centralAuth.signRequest({ ...requestFields, nodeId: 'central' });
    const lower = Object.fromEntries(Object.entries(centralHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(nodeAuth.verifyRequest({ ...requestFields, headers: lower }).allow, true, 'Sub phải chấp nhận chữ ký của Central');

    // 3. Central ký upload session, Sub verify — đúng chiều dùng thật cho chunk.
    const token = centralAuth.signUploadSession(session);
    assert.equal(nodeAuth.verifyUploadSession(token, session).allow, true, 'Sub phải chấp nhận upload token của Central');

    // 4. Chiều ngược lại: Sub ký callback, Central verify.
    const subHeaders = nodeAuth.signRequest({
      method: 'POST',
      path: '/api/v2/nodes/jobs/result',
      contractVersion: 'stream-encode-v1',
      primaryId: 'encode-1-abc',
      nodeId: 'legacy:sub-1',
    });
    const subLower = Object.fromEntries(Object.entries(subHeaders).map(([key, value]) => [key.toLowerCase(), value]));
    assert.equal(
      centralAuth.verifyRequest({
        method: 'POST',
        path: '/api/v2/nodes/jobs/result',
        contractVersion: 'stream-encode-v1',
        primaryId: 'encode-1-abc',
        headers: subLower,
      }).allow,
      true,
      'Central phải chấp nhận chữ ký của Sub'
    );
  });
});
