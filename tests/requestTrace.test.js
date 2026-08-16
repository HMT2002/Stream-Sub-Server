'use strict';

// Trace của một thao tác upload/replicate phải nối được ba mắt xích:
//   FE → Central → Sub (và Sub nguồn → Sub đích khi replicate).
// Trước đây `X-Request-Id` chỉ nằm trong CORS allowlist rồi bị bỏ đi, nên mắt
// xích cuối luôn đứt. Các test dưới khoá lại hành vi mới.
//
// Ràng buộc quan trọng không kém: trace KHÔNG được chạm vào data path
// (`/api/auth/verify` chạy mỗi segment). Có test riêng cho việc đó.

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

const requestTrace = require('../middleware/requestTrace');
const requestContext = require('../utils/requestContext');
const operationLog = require('../utils/operationLog');

const listen = (app) =>
  new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path, headers }, (response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode, headers: response.headers, body: body ? JSON.parse(body) : null })
      );
    });
    request.on('error', reject);
  });

// Đại diện cho tầng service: không nhận `req`, chỉ đọc AsyncLocalStorage.
const deepLayer = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  return { requestId: requestContext.getRequestId(), traceHeaders: requestContext.getTraceHeaders() };
};

const buildApp = () => {
  const app = express();
  app.use(['/api/v2/uploads', '/api/v2/replications'], requestTrace);
  app.get('/api/v2/uploads/probe', async (req, res) => res.json(await deepLayer()));
  // Đường data plane: cố tình KHÔNG đi qua requestTrace.
  app.get('/api/auth/verify', async (req, res) => res.json(await deepLayer()));
  return app;
};

test('a Central supplied request id is adopted and echoed back', async () => {
  const server = await listen(buildApp());
  try {
    const response = await get(server.address().port, '/api/v2/uploads/probe', { 'X-Request-Id': 'central-job-7' });
    assert.strictEqual(response.headers['x-request-id'], 'central-job-7');
    assert.strictEqual(response.body.requestId, 'central-job-7');
    // Đúng header này sẽ được gắn lại ở hop Sub nguồn → Sub đích.
    assert.deepStrictEqual(response.body.traceHeaders, { 'X-Request-Id': 'central-job-7' });
  } finally {
    server.close();
  }
});

test('a request without an id still gets one so the work stays traceable', async () => {
  const server = await listen(buildApp());
  try {
    const response = await get(server.address().port, '/api/v2/uploads/probe');
    assert.match(response.headers['x-request-id'], /^[A-Za-z0-9._:-]{1,128}$/);
    assert.strictEqual(response.body.requestId, response.headers['x-request-id']);
  } finally {
    server.close();
  }
});

test('a malformed id is replaced, never echoed into logs or outbound headers', async () => {
  const server = await listen(buildApp());
  try {
    // Xuống dòng trong id = giả mạo được một dòng log JSON.
    const response = await get(server.address().port, '/api/v2/uploads/probe', { 'X-Request-Id': 'abc def' });
    assert.notStrictEqual(response.headers['x-request-id'], 'abc def');
    assert.match(response.headers['x-request-id'], /^[A-Za-z0-9._:-]{1,128}$/);
  } finally {
    server.close();
  }
});

test('concurrent uploads never share a trace id', async () => {
  const server = await listen(buildApp());
  try {
    const responses = await Promise.all([
      get(server.address().port, '/api/v2/uploads/probe', { 'X-Request-Id': 'up-a' }),
      get(server.address().port, '/api/v2/uploads/probe', { 'X-Request-Id': 'up-b' }),
      get(server.address().port, '/api/v2/uploads/probe', { 'X-Request-Id': 'up-c' }),
    ]);
    assert.deepStrictEqual(
      responses.map((response) => response.body.requestId),
      ['up-a', 'up-b', 'up-c']
    );
  } finally {
    server.close();
  }
});

test('the per-segment auth path carries no trace context at all', async () => {
  // nginx gọi /api/auth/verify cho MỖI segment. Nếu route này lọt vào
  // requestTrace thì mỗi phiên xem gánh thêm hàng nghìn lần als.run + setHeader.
  const server = await listen(buildApp());
  try {
    const response = await get(server.address().port, '/api/auth/verify');
    assert.strictEqual(response.body.requestId, null);
    assert.deepStrictEqual(response.body.traceHeaders, {});
    assert.strictEqual(response.headers['x-request-id'], undefined);
  } finally {
    server.close();
  }
});

test('operationLog stamps every line with the current request id', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    await requestContext.run({ requestId: 'log-me' }, async () => {
      operationLog.write('upload.chunk.accepted', { uploadId: 'u1', chunkIndex: 0 });
    });
  } finally {
    console.log = originalLog;
  }

  assert.strictEqual(lines[0].requestId, 'log-me');
  assert.strictEqual(lines[0].event, 'upload.chunk.accepted');

  // [UPDATED 2026-08-16] `operationLog` nay chạy qua `platform/log`, nên field
  // nghiệp vụ nằm trong `meta` thay vì trải phẳng ở gốc. Đây là thay đổi CÓ CHỦ
  // ĐÍCH để khớp `Stream-Central-Server/backend/utils/logger.js`: hai bên cùng
  // schema thì mới query chung một lượt được. Tách `meta` cũng ngăn field
  // nghiệp vụ đụng tên field khung (`level`, `time`, `scope`).
  assert.strictEqual(lines[0].meta.uploadId, 'u1');
  assert.strictEqual(lines[0].meta.chunkIndex, 0);
});

test('outside a request operationLog omits requestId instead of writing null', async () => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(JSON.parse(line));
  try {
    // Ví dụ thật: callback encode chạy nền sau khi response đã trả xong.
    operationLog.write('upload.encode.start_failed', { uploadId: 'u2' });
  } finally {
    console.log = originalLog;
  }

  assert.ok(!('requestId' in lines[0]), 'không ghi field rỗng để lọc theo requestId không dính rác');
});

test('id validation accepts Central style ids and rejects log injection', () => {
  assert.strictEqual(requestTrace.resolveRequestId({ headers: { 'x-request-id': 'fe-upload-42' } }).origin, 'upstream');
  assert.strictEqual(requestTrace.resolveRequestId({ headers: { 'x-request-id': 'a'.repeat(129) } }).origin, 'generated');
  assert.strictEqual(requestTrace.resolveRequestId({ headers: { 'x-request-id': 'a\nb' } }).origin, 'generated');
  assert.strictEqual(requestTrace.resolveRequestId({ headers: {} }).origin, 'generated');
});
