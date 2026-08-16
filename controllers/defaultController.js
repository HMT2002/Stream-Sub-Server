const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const heartbeatAPI = require('../modules/heartbeatAPI');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('./../utils/appError');
const APIFeatures = require('./../utils/apiFeatures');
var FormData = require('form-data');
const axios = require('axios');
const { getHeapSnapshot } = require('v8');
const config = require('../platform/config');
const legacyProbe = require('../middleware/legacyProbe');
const dataPlaneGuard = require('../middleware/dataPlaneGuard');
const nodeAuthGuard = require('../middleware/nodeAuthGuard');
const encodeJobService = require('../services/encodeJobService');

// [FIXED 2026-08-16] URL Central từng bị hardcode `http://localhost:9000` ở hai
// chỗ redirect bên dưới, dù `config.env` đã có `CENTRAL_API`. Trên VM thật thì
// `localhost:9000` là chính node đó, không phải Central -> redirect vào hư không.
const centralRecallUrl = (videoname, host) =>
  `${config.get().centralApi}/redirect/recall?videoname=${encodeURIComponent(videoname)}&url=${encodeURIComponent(host)}`;

exports.Default = catchAsync(async (req, res, next) => {
  res.status(200).json({
    default: 'default',
  });
});

exports.CheckHlsFile = catchAsync(async (req, res, next) => {
  const filename = req.params.filename || 'mkvmedium';
  const videoPath = 'videos/' + filename + 'Hls/' + filename + '.m3u8';
  // console.log(filename)
  const dir = 'videos/' + filename + 'Hls';
  console.log(dir);

  if (fs.existsSync(videoPath)) {
    const fileList = fs.readdirSync(dir);

    res.status(200).json({
      existed: true,
      path: videoPath,
      fileList,
    });
    return;
  } else {
    // res.status(200).json({
    //   existed:false,
    //   path:videoPath,
    // });
    const host = req.get('host');
    res.redirect(308, centralRecallUrl(filename, host));

    return;
  }
});

exports.CheckDashFile = catchAsync(async (req, res, next) => {
  const filename = req.params.filename || 'largetest5';
  const videoPath = 'videos/' + filename + '/init.mpd';
  const dir = 'videos/' + filename;
  console.log(dir);

  // console.log(fileList);
  if (fs.existsSync(videoPath)) {
    const fileList = fs.readdirSync(dir);

    res.status(200).json({
      existed: true,
      path: videoPath,
      fileList,
    });
    return;
  } else {
    // res.status(200).json({
    //   existed: false,
    //   path: videoPath,
    // });
    const host = req.get('host');
    //the 307 http code spec 307 Temporary Redirect , a POST request must be repeated using another POST request.
    //308 preserves not only the HTTP method, but also indicates this is a permanent redirect.
    res.redirect(308, centralRecallUrl(filename, host));

    return;
  }
});

exports.CheckIfThisServerIsFckingAlive = catchAsync(async (req, res, next) => {
  console.log('Check alive');
  const host = req.get('host');
  const testURL = req.protocol + '://' + host + req.originalUrl;
  const uploadURL = req.protocol + '://' + host + '/api/v1/upload/';
  console.log(uploadURL);
  res.status(200).json({
    status: 'alive',
    message: 'This server is alive',
    alive: true,
    testURL,
    uploadURL,
  });
});

exports.heartbeatCheck = catchAsync(async (req, res, next) => {
  const host = req.get('host');
  const fullURL = req.protocol + '://' + host + req.originalUrl;
  const heartbeatInfo = await heartbeatAPI.gatherHeartbeatInfo();

  // [FIXED 2026-08-16] Trước đây gửi thẳng `heartbeatInfo`, trong khi vòng lặp
  // nền gửi `buildPayload(heartbeatInfo)` — cùng một node báo cáo theo hai
  // schema khác nhau, tuỳ ai kích hoạt. Central phải đoán, và nhánh đoán sai
  // làm node rơi vào `suspect`.
  const delivered = await heartbeatAPI.sendHeartbeat(heartbeatAPI.buildPayload(heartbeatInfo));

  res.status(200).json({
    status: 'alive',
    message: 'This server is alive',
    alive: true,
    fullURL,
    delivered,
    heartbeatInfo,
  });
});

// GET /api/default/legacy-usage — route v1 nào còn được gọi, và bao nhiêu lần.
// Đây là dữ liệu để quyết định XOÁ code cũ; xem `middleware/legacyProbe.js`.
// Bộ đếm nằm trong RAM một process nên `pm2 restart` là mất — nguồn sự thật
// bền vững là log `legacy.route.hit`, đây chỉ để xem nhanh.
exports.LegacyUsage = catchAsync(async (req, res) => {
  res.status(200).json({ ok: true, data: legacyProbe.snapshot() });
});

// GET /api/default/node-auth — đọc TRƯỚC khi bật `NODE_AUTH_MODE=enforce`.
// `wouldDeny > 0` nghĩa là đang có node/Central gửi request không ký; bật
// enforce lúc đó là cắt liên lạc với chính chúng.
exports.NodeAuthStatus = catchAsync(async (req, res) => {
  res.status(200).json({ ok: true, data: nodeAuthGuard.snapshot() });
});

// GET /api/default/data-plane — có client nào còn xin media thẳng từ Node không.
// Con số `refused > 0` nghĩa là đang có đường phát KHÔNG đi qua nginx, tức là
// không qua auth_request và không qua danh sách chặn. Xem middleware/dataPlaneGuard.js.
exports.DataPlaneStatus = catchAsync(async (req, res) => {
  res.status(200).json({ ok: true, data: dataPlaneGuard.snapshot() });
});

// GET /api/default/encode-jobs — hàng đợi encode và các job đang có trên node.
exports.EncodeJobs = catchAsync(async (req, res) => {
  const jobs = encodeJobService.listJobFiles().map((file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      return { file, unreadable: true };
    }
  });
  res.status(200).json({
    ok: true,
    data: {
      queue: encodeJobService.stats(),
      // Job mới nhất trước; chỉ trả phần tóm tắt, không trả stderrTail.
      jobs: jobs
        .map(({ stderrTail, ...rest }) => rest)
        .sort((left, right) => String(right.queuedAt || '').localeCompare(String(left.queuedAt || ''))),
    },
  });
});
