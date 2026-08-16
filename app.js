'use strict';
const express = require('express');
const morgan = require('morgan');
const app = express();
const AppError = require('./utils/appError');
const globalErrorHandler = require('./controllers/errorController');
const videoController = require('./controllers/videoController');
const testController = require('./controllers/testController');
const defaultController = require('./controllers/defaultController');

const heartbeatAPI = require('./modules/heartbeatAPI');

const cors = require('cors');
var path = require('path');
const fs = require('fs');

//ROUTES
const videoRoute = require('./routes/videoRoute');
const replicateRoute = require('./routes/replicateRoute');
const uploadRoute = require('./routes/uploadRoute');

const authRoute = require('./routes/authRoute');
const deleteRoute = require('./routes/deleteRoute');
const checkRoute = require('./routes/checkRoute');
const testRoute = require('./routes/testRoute');
const defaultRouter = require('./routes/defaultRoute');
const streamingRoute = require('./routes/streamingRoute');
const uploadV2Route = require('./routes/v2/uploadRoute');
const replicationV2Route = require('./routes/v2/replicationRoute');
const playbackV2Route = require('./routes/v2/playbackRoute');
const requestTrace = require('./middleware/requestTrace');
const legacyProbe = require('./middleware/legacyProbe');
const dataPlaneGuard = require('./middleware/dataPlaneGuard');
const nodeAuthGuard = require('./middleware/nodeAuthGuard');
const config = require('./platform/config');

// const client_posts = JSON.parse(fs.readFileSync('./json-resources/client_posts.json'));

//MIDDLEWARE
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
}
app.use(express.json());

const corsOptions = {
  origin: true,
  credentials: false,
  allowedHeaders: [
    'Content-Type', 'Authorization',
    'X-Upload-Contract', 'X-Upload-Id', 'X-Storage-Key', 'X-Chunk-Index', 'X-Chunk-Count',
    'X-Chunk-Name', 'X-Media-Extension', 'X-Media-Type', 'X-Video-Id', 'X-Info-Id',
    'X-Replication-Contract', 'X-Job-Id', 'X-File-Name',
    'X-Request-Id',
    // Legacy v1 upload/replication headers remain allowed during migration.
    'index', 'chunkname', 'chunknames', 'ext', 'title', 'infoid', 'statusid',
    'filename', 'folder', 'type', 'uploadid',
  ],
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
const whitelist = ['http://localhost:9000', 'http://localhost:9100', 'http://localhost:9200', 'http://localhost:9300'];

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, PATCH, DELETE, OPTIONS, HEAD, PUT');
  // res.setHeader(
  //   'Access-Control-Allow-Headers',
  //   'Access-Control-Allow-Headers, Origin,Accept, X-Api-Key, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Allow-Headers, Authorization, index'
  // );

  // res.setHeader('Access-Control-Allow-Credentials', 'true');
  // res.setHeader('Access-Control-Allow-Methods', '*');
  // res.header('Access-Control-Allow-Origin', '*');
  // res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use((req, res, next) => {
  req.requestTime = new Date().toISOString();
  // console.log(req.requestTime);
  req.url = decodeURIComponent(req.url);
  next();
});
app.get('/is-this-alive', defaultController.CheckIfThisServerIsFckingAlive);
app.use('/heartbeat', defaultController.heartbeatCheck);

// Auth cho data plane — nginx :9150 gọi /api/auth/verify qua auth_request cho MỖI
// segment. Mount SỚM (ngay sau health-check, trước mọi handler file) để request
// nóng nhất hệ thống đi qua ít middleware nhất có thể.
app.use('/api/auth', authRoute);

// =============================================================================
// DATA PLANE — [UPDATED 2026-08-16 Phase 1] Node KHÔNG phục vụ media nữa.
//
// Mọi request media dưới đây đi qua `dataPlaneGuard` TRƯỚC, và mặc định nhận
// 410 Gone. Đường phát duy nhất là nginx `:9150`.
//
// VÌ SAO ĐÓNG HẲN: chừng nào Node còn trả được `.m4s`, vẫn tồn tại một đường
// lấy segment KHÔNG đi qua `auth_request` — tức là không qua token check và
// không qua danh sách chặn của `services/playbackBlockService`. Có hai cửa mà
// chỉ khoá một thì cửa còn lại chính là cửa sẽ được dùng.
//
// Van xả: `MEDIA_SERVING=on` trong config.env bật lại các handler cũ.
// Đếm số lần bị từ chối: `GET /api/default/data-plane`.
// =============================================================================
const mediaRoutePatterns = [
  '/dash-token/:token*.mpd',
  '/dash-token/:token/:segment*.m4s',
  '/*.vtt',
  '/*.ass',
  '/*.srt',
  '/*.mp4',
  '/*.mpd',
  '/*.m4s',
  '/*.png',
];
mediaRoutePatterns.forEach((pattern) => app.get(pattern, dataPlaneGuard));

// #region Handling mpd and m4s token request || phải để này trên cùng để tăng ưu tiên xử lý request duôi *.mpd hoặc *.m4s
app.use(cors()).get(
  '/dash-token/:token*.mpd',
  (req, res, next) => {
    console.log('Request URL:', req.originalUrl + ' -> ');
    next();
  },
  (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  },
  videoController.MPDTokenHandler
);
app.use(cors()).get(
  '/dash-token/:token/:segment*.m4s',
  (req, res, next) => {
    console.log('Request URL:', req.originalUrl + ' -> ');
    next();
  },
  (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
  },
  videoController.M4STokenHandler
);
// #endregion

// #region Handling extra requests, such as subtitle requests

//v1
// app.get('/videos/v1/*.vtt', videoController.VTTHandler);
// app.get('/videos/v1/*.ass', videoController.ASSHandler);
// app.get('/videos/v1/*.srt', videoController.SRTHandler);
// app.get('/videos/v1/*.mp4', videoController.MP4MPDHandler);
// app.get('/videos/v1/*.mpd', videoController.MPDHandlerVer1);
// app.get('/videos/v1/*.m4s', videoController.M4SHandlerVer1);
// app.get('/videos/v1/*.png', videoController.PNGHandler);
// //

// //v2
// app.get('/videos/v2/*.vtt', videoController.VTTHandler);
// app.get('/videos/v2/*.ass', videoController.ASSHandler);
// app.get('/videos/v2/*.srt', videoController.SRTHandler);
// app.get('/videos/v2/*.mp4', videoController.MP4MPDHandler);
// app.get('/videos/v2/*.mpd', videoController.MPDHandler);
// app.get('/videos/v2/*.m4s', videoController.M4SHandler);
// app.get('/videos/v2/*.png', videoController.PNGHandler);
// //

app.get('/*.vtt', videoController.VTTHandler);
app.get('/*.ass', videoController.ASSHandler);
app.get('/*.srt', videoController.SRTHandler);
app.get('/*.mp4', videoController.MP4MPDHandler);
app.get('/*.mpd', videoController.MPDHandler);
app.get('/*.m4s', videoController.M4SHandler);
app.get('/*.png', videoController.PNGHandler);

// app.get('/*.m3u8', videoController.M3u8Handler);
// app.get('/*.ts', videoController.TsHandler);

// #endregion

//app.use('/', defaultRoute);

app.use('/api/test', testRoute);
app.use('/api/default', defaultRouter);

// Trace CHỈ trên control plane. Central gửi X-Request-Id kèm mọi lệnh ở đây, và
// FE gửi kèm từng chunk upload; `operationLog` sẽ tự gắn id đó vào mọi dòng log.
//
// Cố ý KHÔNG mount toàn cục: `/api/auth` (nginx gọi mỗi segment) và các handler
// *.mpd/*.m4s ở trên nằm trên data path, chạy hàng nghìn lần mỗi phiên xem —
// xem ghi chú hiệu năng trong `services/authService.js`.
const controlPlaneRoutes = [
  '/api/v1/upload',
  '/api/v1/replicate',
  '/api/v1/delete',
  '/api/v1/check',
  '/api/v2/uploads',
  '/api/v2/replications',
  '/api/v2/playback',
];
app.use(controlPlaneRoutes, requestTrace);

// Đếm route v1 nào CÒN được gọi và ai gọi — cơ sở dữ liệu để quyết định xoá,
// thay vì đoán. Xem `middleware/legacyProbe.js` (và lưu ý Central cố tình hạ
// cấp xuống v1 khi gặp Sub cũ, nên "lâu không thấy gọi" chưa đủ để xoá).
// Cố ý KHÔNG gắn lên `/api/v2/*` và data plane.
const legacyRoutes = [
  '/api/v1/upload',
  '/api/v1/replicate',
  '/api/v1/delete',
  '/api/v1/check',
  '/api/v1/video',
  '/api/v1/streaming',
  // [THÊM Phase 3] `/api/test` bị bỏ sót ở Phase 0. Đây là bề mặt legacy LỚN
  // NHẤT còn mở: `controllers/testController.js` (22 KB) có route upload file,
  // chạy FFmpeg tuỳ ý và stream file theo tên do client đưa vào — không kiểm
  // tra gì. Không đếm được thì không có cơ sở để đóng nó.
  '/api/test',
];
app.use(legacyRoutes, legacyProbe);

app.use('/api/v1/video', videoRoute);
app.use('/api/v1/upload', uploadRoute);
app.use('/api/v1/replicate', replicateRoute);
app.use('/api/v1/delete', deleteRoute);
app.use('/api/v1/streaming', streamingRoute);
app.use('/api/v1/check', checkRoute);
app.use('/api/v2/uploads', uploadV2Route);

// Xác thực node-to-node CHỈ trên các route mà người gọi giữ được bí mật.
// `/api/v2/uploads/chunks` CỐ TÌNH không có ở đây: người gọi nó là trình duyệt,
// và trình duyệt không giữ được khoá — đường đó dùng token phiên upload do
// Central ký sẵn, kiểm trong `middleware/uploadContract.js`.
app.use(['/api/v2/replications', '/api/v2/playback'], nodeAuthGuard);

app.use('/api/v2/replications', replicationV2Route);
// Công tắc chặn phát: có hiệu lực ngay ở request segment kế tiếp vì nginx hỏi
// Node cho MỖI file qua `auth_request`. Xem controllers/playbackBlockController.js.
app.use('/api/v2/playback', playbackV2Route);

app.all('*', (req, res, next) => {
  next(new AppError('Cant find ' + req.originalUrl + ' on the server', 404));
});
app.use(globalErrorHandler);

//#region autoHeartbeat
// khởi động — KHÔNG await, để nó chạy nền
//
// [FIXED 2026-08-16] Điều kiện cũ là `NODE_ENV === 'development'` — NGƯỢC với ý
// định. `config.env` của node deploy đặt `NODE_ENV=deployment`, nên đúng những
// node cần báo cáo tình trạng lại là những node KHÔNG BAO GIỜ gửi heartbeat;
// Central chỉ thấy chúng qua probe thụ động và xếp vào `suspect`
// (xem `Stream-Central-Server/backend/contracts/heartbeat-v2.md`).
// Nay mặc định BẬT ở mọi môi trường, tắt tường minh bằng `HEARTBEAT_ENABLED=off`.
if (config.get().heartbeat.enabled) {
  heartbeatAPI.heartbeatLoop();
}
//#endregion

module.exports = app;
