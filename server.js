const dotenv = require('dotenv');
var path = require('path');

dotenv.config({ path: './config.env' });

// ---------------------------------------------------------------------------
// Kiểm tra cấu hình NGAY SAU dotenv, TRƯỚC khi require app.
//
// Ba biến trong `platform/config.REQUIRED` mà thiếu thì node vẫn khởi động và
// vẫn nhận request, nhưng hỏng ở tận trong nghiệp vụ: `JWT_SECRET` thiếu ->
// verify token ném lỗi ở TỪNG segment; `ENCODE_TYPE` sai -> `encodeCommand()`
// không khớp case nào và sinh ra chuỗi lệnh ffmpeg RỖNG (encode "thành công"
// mà không có file nào). Đó là lúc tệ nhất để phát hiện: sau khi đã nhận file
// của người dùng.
//
// [UPDATED 2026-08-16 Phase 2] MẶC ĐỊNH ĐÃ ĐẢO: thiếu biến bắt buộc là THOÁT.
//
// Phase 0 chỉ ghi log vì các node đang chạy có thể mang `config.env` cũ, và
// không được phép chết vì một lần deploy. Sau hai vòng deploy, `config.env_`
// đã có đủ biến và nhánh "chạy tiếp với cấu hình sai" chỉ còn là cách để lỗi
// nằm im tới lúc có người dùng thật.
//
// `CONFIG_STRICT=off` giữ lại hành vi cũ cho tình huống khẩn cấp.
// ---------------------------------------------------------------------------
const config = require('./platform/config');
const log = require('./platform/log');

const configProblems = config.inspect();
if (configProblems.length) {
  log.error('config', 'cấu hình không hợp lệ trong config.env', { problems: configProblems });
  if (String(process.env.CONFIG_STRICT || 'on').toLowerCase() !== 'off') {
    log.error('config', 'thoát vì CONFIG_STRICT đang bật (đặt CONFIG_STRICT=off để chạy tiếp)');
    process.exit(1);
  }
}

const app = require('./app');
var httpAttach = require('http-attach'); // useful module for attaching middlewares

const hls = require('hls-server');
const fs = require('fs');
const os = require('os');
const readline = require('readline');

let total_mem = os.totalmem();
const Log_CPU = (isLogOsCPU) => {
  let free_mem = os.freemem();

  let free_percentage = (free_mem / total_mem) * 100;
  if (isLogOsCPU) {
    console.log(os.cpus());
  }
  // console.log(`Total memory = ${total_mem} Free memory = ${free_mem} Free memory percentage = ${free_percentage}`);
  // readline.clearLine(process.stdout, 0);
  // readline.cursorTo(process.stdout, 0);
  // process.stdout.write(
  //   `Total memory = ${total_mem} Free memory = ${free_mem} Free memory percentage = ${free_percentage} \r`
  // );
  // blessed_status(`Total memory = ${total_mem} Free memory = ${free_mem} Free memory percentage = ${free_percentage}`);
  // blessed_log(`Total memory = ${total_mem} Free memory = ${free_mem} Free memory percentage = ${free_percentage}`);
};

//console.log(process.env);
//START SERVER
// Công thức cổng (PORT + SERVERINDEX * SERVERREP) chuyển vào `platform/config`;
// giá trị ra không đổi, kể cả nhánh fallback 9100 khi thiếu env.
const port = config.get().port;
const server = app.listen(port, () => {
  log.info('server', 'listening', { port, nodeEnv: config.get().nodeEnv, authMode: config.get().auth.mode });

  setInterval(function () {
    Log_CPU(false);
  }, 1000);
});
server.timeout = 125000; // v2 replication waits up to 120s for destination acknowledgements

// ---------------------------------------------------------------------------
// Khởi động lại thì phải dọn dẹp sau chính mình.
//
// 1. Nạp danh sách chặn phát TỪ ĐĨA. Trước đây cơ chế thu hồi duy nhất là mảng
//    trong RAM (`globals/blacklist.js`) — `pm2 restart` là người bị chặn xem
//    tiếp được ngay, mà không ai nhận ra.
//
// 2. Đối chiếu job encode. Job còn ở `running` mà tiến trình đã chết thì đánh
//    `failed` và báo Central; job đã xong nhưng chưa giao được thì gửi lại.
//    Không có bước này, `.job.json` sẽ nói "đang chạy" vĩnh viễn.
//
// Cả hai đều KHÔNG được phép chặn node khởi động: chúng tự nuốt lỗi bên trong,
// và `.catch` ở đây là lưới cuối.
// ---------------------------------------------------------------------------
const playbackBlockService = require('./services/playbackBlockService');
const encodeJobService = require('./services/encodeJobService');
const storagePaths = require('./storage/paths');

// [THÊM Phase 2] Chuyển file tạm còn sót từ `videos/` sang `var/incoming/`.
// PHẢI chạy TRƯỚC `reconcile()`: reconcile quét `.job.json` trong stagingRoot,
// và job của lần chạy trước vẫn đang nằm ở chỗ cũ.
const migration = storagePaths.migrateLegacyStaging();
if (migration.moved || migration.failed) {
  log.info('storage', 'migrated legacy staging files', migration);
}

playbackBlockService.load();
encodeJobService
  .reconcile()
  .catch((error) => log.error('startup', 'encode reconcile failed', { message: error.message }));

if (process.env.VER === undefined) {
  new hls(server, {
    provider: {
      exists: (req, cb) => {
        req.url = decodeURIComponent(req.url);
        console.log('server js exists' + req.url);
        req.url = decodeURIComponent(req.url);
        const ext = req.url.split('.')[1];
        if (ext !== 'm3u8' && ext !== 'ts') {
          return cb(null, true);
        }
        fs.access(__dirname + req.url, fs.constants.F_OK, function (err) {
          if (err) {
            console.log(__dirname + req.url);
            console.log(err);
            return cb(null, false);
          }
          cb(null, true);
        });
      },
      getManifestStream: (req, cb) => {
        req.url = decodeURIComponent(req.url);
        console.log('server js getManifestStream ' + req.url);
        const stream = fs.createReadStream(__dirname + req.url);
        cb(null, stream);
      },
      getSegmentStream: (req, cb) => {
        req.url = decodeURIComponent(req.url);
        console.log('server js getSegmentStream ' + req.url);
        const stream = fs.createReadStream(__dirname + req.url);
        cb(null, stream);
      },
    },
  });

  const NodeMediaServer = require('node-media-server');

  const config = {
    rtmp: {
      port: Number(process.env.RTMPPORT) + Number(process.env.SERVERINDEX),
      chunk_size: 60000,
      gop_cache: true,
      ping: 30,
      ping_timeout: 60,
    },
    http: {
      port: Number(process.env.PORT) + Number(process.env.SERVERINDEX) * Number(process.env.SERVERREP) + 1,
      allow_origin: '*',
    },
  };

  var nms = new NodeMediaServer(config);
  nms.run();
}
