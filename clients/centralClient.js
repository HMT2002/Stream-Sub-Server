'use strict';

// =============================================================================
// centralClient — CỬA DUY NHẤT để Sub gọi ngược lên Central.
//
// Đối xứng với `Stream-Central-Server/backend/clients/nodeClient.js` (cửa duy
// nhất theo chiều ngược lại), và mượn nguyên ba nguyên tắc đã được chứng minh ở
// đó:
//
//   1. HTTP STATUS LÀ DỮ LIỆU, KHÔNG PHẢI EXCEPTION.
//      Mặc định axios ném khi status >= 300. Nhưng Central trả 404 "không biết
//      job này" là một CÂU TRẢ LỜI hợp lệ, khác hẳn ECONNREFUSED nghĩa là chưa
//      hỏi được ai. Gộp hai thứ vào một `catch` là mất khả năng phân biệt
//      "Central từ chối" với "Central chết" — và hai tình huống đó cần hai cách
//      xử lý ngược nhau (bỏ job vs thử lại sau).
//
//   2. KHÔNG BAO GIỜ THROW. Trả object đã phân loại:
//        result.transport !== 'ok'               -> không tới được Central
//        result.transport === 'ok' && !result.ok -> tới được, Central từ chối
//        result.ok                               -> thành công
//
//   3. CHỈ RETRY LỖI TRANSPORT. Một 400 từ Central nghĩa là payload của Sub sai;
//      gửi lại y hệt chỉ sai thêm một lần nữa.
//
// -----------------------------------------------------------------------------
// Vì sao module này tồn tại: khoảng trống lớn nhất của contract v2
// -----------------------------------------------------------------------------
// Trước đây chuỗi upload đứt ngay sau `202 Accepted`:
//     FE -> Sub: chunk cuối · Sub -> FE: 202 {job:{state:'accepted'}}
//     Sub: spawn ffmpeg ... (30 phút) ... xong / chết
//     Central: không biết gì
// `markdowns/upload-replication-contract-v2.md` §6 ghi nhận đây là backlog.
// =============================================================================

const axios = require('axios');
const http = require('http');
const https = require('https');

const config = require('../platform/config');
const requestContext = require('../utils/requestContext');
const nodeAuth = require('../platform/nodeAuth');
const log = require('../platform/log');

const clientLog = log.child('centralClient');

// Agent dùng chung: callback thưa nhưng heartbeat thì 10 giây một lần suốt đời
// tiến trình. Không keep-alive là mỗi nhịp một lần bắt tay TCP.
const agentOptions = { keepAlive: true, keepAliveMsecs: 15000, maxSockets: 16, maxFreeSockets: 4 };
const httpAgent = new http.Agent(agentOptions);
const httpsAgent = new https.Agent(agentOptions);

const TIMEOUTS = Object.freeze({ heartbeat: 5000, callback: 15000 });

// 5 lần, 5s -> 80s. Chọn theo tình huống thật cần chịu được: Central restart
// hoặc deploy đúng lúc một job encode dài vừa xong.
const RETRY = Object.freeze({ attempts: 5, baseDelayMs: 5000, maxDelayMs: 80000 });

const classifyTransportError = (error) => {
  const code = error?.code || '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  return 'network';
};

const isRetryableTransport = (transport) => ['timeout', 'refused', 'reset', 'dns', 'network'].includes(transport);

// 5xx của Central là "Central nhận rồi tự hỏng" — thử lại có ý nghĩa (có thể là
// một instance lỗi, hoặc DB vừa mất kết nối). 4xx thì không.
const isRetryableStatus = (status) => status >= 500 && status < 600;

const backoffDelay = (attempt) => {
  const exponential = Math.min(RETRY.maxDelayMs, RETRY.baseDelayMs * 2 ** (attempt - 1));
  // Jitter: N node cùng khởi động lại sau sự cố sẽ không retry đồng pha.
  return Math.round(exponential / 2 + Math.random() * (exponential / 2));
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildResult = ({ op, url, startedAt, response, error, attempt }) => {
  const durationMs = Date.now() - startedAt;

  if (error) {
    const transport = classifyTransportError(error);
    return { ok: false, transport, status: null, data: null, durationMs, op, url, attempt, error: { code: error.code || transport, message: error.message } };
  }

  const status = response.status;
  const httpOk = status >= 200 && status < 300;
  // Central dùng envelope `{ok:false}` kèm HTTP 200 ở một số đường — coi đó là
  // thất bại nghiệp vụ, đúng như nodeClient của Central làm với Sub.
  const bodyOk = response.data?.ok !== false;

  return {
    ok: httpOk && bodyOk,
    transport: 'ok',
    status,
    data: response.data,
    durationMs,
    op,
    url,
    attempt,
    error: httpOk && bodyOk ? null : { code: response.data?.error?.code || `HTTP_${status}`, message: response.data?.error?.message || `Central responded ${status}` },
  };
};

const execute = async ({ op, path: requestPath, method = 'POST', body, timeoutMs, retry, baseUrl }) => {
  // `baseUrl` cho phép callback đi tới địa chỉ khác đường gọi thường — xem
  // `CENTRAL_CALLBACK_URL` trong platform/config.js.
  const base = (baseUrl || config.get().centralApi).replace(/\/+$/, '');
  const url = `${base}${requestPath.startsWith('/') ? '' : '/'}${requestPath}`;
  const maxAttempts = retry ? RETRY.attempts : 1;

  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await axios({
        method,
        url,
        data: body,
        timeout: timeoutMs,
        httpAgent,
        httpsAgent,
        headers: {
          'Content-Type': 'application/json',
          'X-Node-Id': config.get().nodeId,
          // Nối log của Sub với log của Central cho cùng một thao tác. Với
          // callback encode, id này là id của phiên upload từ nhiều giờ trước.
          ...requestContext.getTraceHeaders(),
          // [THÊM 2026-08-16 Phase 2] Ký chặng Sub → Central. Không có nó thì
          // bất kỳ ai cũng gửi được "job xong" giả và ép Central đánh dấu một
          // video là sẵn sàng phát trong khi trên đĩa không có gì.
          ...nodeAuth.signRequest({
            method,
            path: requestPath,
            contractVersion: body?.contractVersion || '',
            primaryId: body?.jobId || '',
            nodeId: config.get().nodeId,
          }),
        },
        validateStatus: () => true,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      last = buildResult({ op, url, startedAt, response, attempt });
    } catch (error) {
      last = buildResult({ op, url, startedAt, error, attempt });
    }

    if (last.ok) {
      clientLog.debug(`${op} ok`, { url, attempt, durationMs: last.durationMs, status: last.status });
      return last;
    }

    const retryable = last.transport !== 'ok' ? isRetryableTransport(last.transport) : isRetryableStatus(last.status);
    clientLog[retryable ? 'warn' : 'error'](`${op} failed`, {
      url,
      attempt,
      transport: last.transport,
      status: last.status,
      code: last.error?.code,
      retryable,
    });

    if (!retryable || attempt >= maxAttempts) return last;
    await sleep(backoffDelay(attempt));
  }
  return last;
};

/**
 * Báo kết quả một job encode. Contract `stream-encode-v1`.
 *
 * Endpoint phía Central: `POST /api/v2/nodes/jobs/result`
 * (`Stream-Central-Server/backend/routes/v2/nodeJobRoute.js`,
 *  mô tả: `backend/contracts/encode-v1.md`).
 *
 * Cả ĐỊA CHỈ lẫn ĐƯỜNG DẪN đều cấu hình được (`CENTRAL_CALLBACK_URL`,
 * `ENCODE_CALLBACK_PATH`) — xem lý do ở `platform/config.js`.
 *
 * Central trả 404 (endpoint chưa có/đổi path) là lỗi KHÔNG đáng retry: job vẫn
 * xong ở phía Sub, `.job.json` giữ `deliveredToCentral: false` và `reconcile()`
 * lúc khởi động sau sẽ gửi lại.
 */
const reportEncodeResult = (payload) =>
  execute({
    op: 'encode.result',
    baseUrl: config.get().encode.callbackUrl,
    path: config.get().encode.callbackPath,
    method: 'POST',
    body: payload,
    timeoutMs: TIMEOUTS.callback,
    retry: true,
  });

module.exports = Object.freeze({
  TIMEOUTS,
  RETRY,
  execute,
  reportEncodeResult,
  classifyTransportError,
  _private: { buildResult, isRetryableTransport, isRetryableStatus, backoffDelay },
});
