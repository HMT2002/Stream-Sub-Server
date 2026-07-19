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

const deleteRoute = require('./routes/deleteRoute');
const checkRoute = require('./routes/checkRoute');
const testRoute = require('./routes/testRoute');
const defaultRouter = require('./routes/defaultRoute');
const streamingRoute = require('./routes/streamingRoute');
const uploadV2Route = require('./routes/v2/uploadRoute');
const replicationV2Route = require('./routes/v2/replicationRoute');

// const client_posts = JSON.parse(fs.readFileSync('./json-resources/client_posts.json'));

//MIDDLEWARE
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
} else {
}
console.log(process.env.NODE_ENV);
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

app.use('/api/v1/video', videoRoute);
app.use('/api/v1/upload', uploadRoute);
app.use('/api/v1/replicate', replicateRoute);
app.use('/api/v1/delete', deleteRoute);
app.use('/api/v1/streaming', streamingRoute);
app.use('/api/v1/check', checkRoute);
app.use('/api/v2/uploads', uploadV2Route);
app.use('/api/v2/replications', replicationV2Route);

app.all('*', (req, res, next) => {
  next(new AppError('Cant find ' + req.originalUrl + ' on the server', 404));
});
app.use(globalErrorHandler);

//#region autoHeartbeat
// khởi động — KHÔNG await, để nó chạy nền
if (process.env.NODE_ENV === 'development') {
  heartbeatAPI.heartbeatLoop();
}
//#endregion

module.exports = app;
