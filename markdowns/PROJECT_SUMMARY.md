# Stream-Sub-Server — Project Summary

> Tài liệu này được tạo để export sang chat/session mới, mô tả toàn bộ project.

> [UPDATED 2026-07-19] Đọc mục 0 trước. Audit chi tiết và bằng chứng code:
> [current-implementation-audit-2026-07.md](current-implementation-audit-2026-07.md).

---

## 0A. UPDATED — upload/replication v2 và DB ownership (2026-07-19)

> **SUPERSEDED:** các đoạn bên dưới nói `server.js`/`server_pro.js` còn connect Mongo hoặc
> `send-folder-v2` còn query `Video`/`Server` mô tả snapshot trước thay đổi này.

- Runtime Sub hiện là data plane không DB: entrypoint không connect Mongo và controller active
  không import model. Dependency/model/config Mongoose cũ còn trên đĩa để cleanup riêng, tránh
  thay đổi route v1 ngoài phạm vi.
- `POST /api/v2/uploads/chunks` nhận upload session Central cấp, tự suy ra filename part, ghép
  theo thứ tự bằng buffer cố định và trả `202 Accepted`; không nhận `statusId`, không query DB.
- `POST /api/v2/replications/send-folder` nhận `jobId`, `storageKey` và destination metadata.
  Source gửi file tới `POST /api/v2/replications/receive-file`, kiểm tra ack từng file; Central
  chỉ cập nhật DB sau acknowledgement tổng hợp hợp lệ.
- Cả entrypoint dev và pro đều mount upload/replication v2; server timeout là 125s để khớp
  connector timeout 120s.
- Body ID-only từ Central cũ trả HTTP 426 rõ ràng thay vì query DB. Rollout an toàn là
  **Central mới → Sub mới → FE mới**; Central mới có fallback để bridge Sub cũ.
- Replication vẫn tuần tự; checksum, Range/resume, atomic finalize và durable callback là backlog.

Contract chi tiết: [upload-replication-contract-v2.md](upload-replication-contract-v2.md).

## 0. Trạng thái hiện hành theo code (2026-07-19)

Snapshot được đối chiếu: branch `alpha`, commit `0427d60` ngày 2026-07-17.

- Quyết định TARGET là sub-node nhẹ, **không MongoDB/Redis/BullMQ**, nhưng code hiện tại **chưa
  lược bỏ MongoDB hoàn toàn**: `server.js` và `server_pro.js` còn gọi `dbVideoSharing.connect()`,
  package còn `mongoose`, replicate V2 còn query `Video`/`Server` tại node.
- Runtime không có Redis/BullMQ hoạt động. `redisAPI.js` là dead/broken prototype và không được
  import; package cũng không có dependency `redis`/BullMQ.
- `p-queue` chưa có. Encode spawn trực tiếp, không giới hạn concurrency và không có durable job
  state.
- Heartbeat prototype dùng recursive loop, interval ~10s, jitter, timeout 5s và inventory hash;
  nhưng auto loop chỉ bật khi `NODE_ENV === 'development'`, central chỉ lưu snapshot in-memory,
  payload chưa có health/jobs/bootId/seq.
- Upload gọi encode fire-and-forget rồi trả 201; chưa có `202 + jobId`. Các update `VideoStatus`
  trong sub đã bị comment, nên flow cũ “encoding → ready tại sub” không còn đúng.
- Replication gửi trực tiếp node↔node, nhưng tuần tự từng file, chưa checksum/range/resume/atomic
  finalize. Replicate V2 vẫn phụ thuộc MongoDB tại source node.
- nginx port 9150 đã có static delivery bằng `sendfile` và frontend mới ưu tiên URL nginx. Tuy
  nhiên `/__auth` đang comment và 401/403/5xx đều fallback `@serve`: **fail-open để test**.
- Commit 2026-07-17 bổ sung encode type 7 (H.264 NVENC) và 8/default (libx264), ladder
  360p/720p/1080p có scale+pad+setsar; đây là thông tin mới hơn phần encode cũ bên dưới.

> [SUPERSEDED 2026-07-19] Các mục 1–12 bên dưới là snapshot cũ, giữ nguyên để tra lịch sử.
> Mọi câu “sub không/có DB”, “VideoStatus được update”, “heartbeat production”, “p-queue” phải
> đối chiếu mục 0 và audit trước khi dùng.

---

## 1. Tổng quan

**Stream-Sub-Server** là một **sub-node server** trong kiến trúc hệ thống streaming video phân tán. Mỗi sub-server có thể hoạt động độc lập hoặc được điều phối bởi một master server. Server phục vụ nội dung video theo chuẩn **HLS** và **MPEG-DASH**, có khả năng replicate nội dung sang các node khác, encode video bằng FFmpeg (hỗ trợ CPU và NVIDIA GPU), và nhận livestream qua RTMP.

**Branch hiện tại**: `alpha` | **Entry point**: `server.js` (dev), `server_pro.js` (pro/RTMP nâng cao)

---

## 2. Tech Stack

| Layer | Công nghệ |
|---|---|
| Runtime | Node.js |
| Web Framework | Express.js 4.x |
| Database | MongoDB (qua Mongoose 8.x) |
| Encode/Transcode | FFmpeg, fluent-ffmpeg, @ffmpeg-installer/ffmpeg |
| Streaming Protocol | HLS (hls-server), MPEG-DASH, RTMP (node-media-server) |
| Auth | JWT (jsonwebtoken), bcryptjs |
| File Upload | Multer |
| HTTP Client | Axios |
| Storage External | Firebase Storage, Google Drive API |
| Dev | Nodemon, ESLint, Prettier |
| Process Manager | PM2 (ecosystem.config.js) |
| Reverse Proxy | Nginx (nginx.conf có sẵn) |
| Logging | Morgan |

---

## 3. Cấu trúc thư mục

```
Stream-Sub-Server/
├── server.js               # Entry: khởi động HTTP + HLS server + NodeMediaServer (RTMP)
├── server_pro.js           # Entry pro: RTMP nâng cao + stream control API
├── app.js                  # Express app, đăng ký routes, middleware
├── config.env              # Biến môi trường (xem mục 6)
├── ecosystem.config.js     # PM2 config
├── nginx.conf              # Nginx reverse proxy config
├── ffmpeg.exe              # FFmpeg binary đính kèm (Windows)
│
├── config/
│   └── database/
│       └── db_index.js     # Kết nối MongoDB
│
├── controllers/            # Business logic
│   ├── videoController.js      # Streaming, upload, MPD/M4S/HLS handler
│   ├── uploadController.js     # Nhận file upload từ client (chunked)
│   ├── replicateController.js  # Gửi/nhận video giữa các node
│   ├── streamingController.js  # Quản lý session blacklist (stop/add)
│   ├── checkController.js      # Kiểm tra file/folder tồn tại
│   ├── deleteController.js     # Xóa file/folder
│   ├── defaultController.js    # Default + health check
│   ├── testController.js       # Test routes
│   ├── errorController.js      # Global error handler
│   ├── rtmpType1Controller.js  # RTMP config type 1
│   ├── rtmpType2Controller.js  # RTMP config type 2
│   ├── rtmpType2_5Controller.js
│   └── rtmpType3Controller.js
│
├── routes/
│   ├── videoRoute.js       # /api/v1/video
│   ├── uploadRoute.js      # /api/v1/upload
│   ├── replicateRoute.js   # /api/v1/replicate
│   ├── streamingRoute.js   # /api/v1/streaming
│   ├── checkRoute.js       # /api/v1/check
│   ├── deleteRoute.js      # /api/v1/delete
│   ├── defaultRoute.js     # /api/default
│   └── testRoute.js        # /api/test
│
├── models/mongo/
│   ├── Video.js            # Schema: video metadata
│   ├── VideoStatus.js      # Schema: trạng thái encode/transfer
│   ├── Server.js           # Schema: thông tin sub-server
│   ├── User.js             # Schema: user account
│   └── DASHSessionEnd.js   # Schema: DASH session tracking
│
├── modules/
│   ├── encodeAPI.js        # FFmpeg encode functions (HLS/DASH, nhiều phiên bản)
│   ├── helperAPI.js        # Utilities: random string, JWT generate/decode, console log
│   ├── multerAPI.js        # Multer upload configs (single, chunked, folder...)
│   ├── firebaseAPI.js      # Firebase Storage upload
│   └── redisAPI.js         # Redis (chưa dùng nhiều)
│
├── globals/
│   └── blacklist.js        # In-memory blacklist quản lý DASH session
│
├── constants/
│   └── constants.js        # Hằng số API paths, messages
│
├── utils/
│   ├── catchAsync.js       # Wrapper bắt lỗi async
│   ├── appError.js         # Custom AppError class
│   ├── apiFeatures.js      # MongoDB query helpers
│   └── notificationFactory.js
│
├── videos/                 # Thư mục lưu video files
│   └── convert/            # HLS converted files (.m3u8, .ts)
├── public/                 # Static files (client.html HLS player)
├── images/                 # Thumbnail storage
├── resources-storage/      # Upload temp storage
├── streaming/              # Streaming-related assets
└── scripts/                # Shell scripts
```

---

## 4. API Endpoints

### Health Check
| Method | Path | Mô tả |
|---|---|---|
| GET | `/is-this-alive` | Health check đơn giản |
| GET | `/api/v1/check/is-this-fucking-alive` | Health check với URL info |
| GET | `/api/v1/check/file/:filename` | Kiểm tra file tồn tại trong `videos/` |
| GET | `/api/v1/check/folder/:folder` | Kiểm tra folder tồn tại trong `videos/` |

### Video Streaming (tĩnh / file-based)
| Method | Path | Mô tả |
|---|---|---|
| GET | `/*.vtt` | Phục vụ subtitle WebVTT |
| GET | `/*.ass` | Phục vụ subtitle ASS |
| GET | `/*.srt` | Phục vụ subtitle SRT |
| GET | `/*.mp4` | MP4 video streaming (206 range request, hỗ trợ cả MPD player) |
| GET | `/*.mpd` | DASH manifest (Content-Type: application/dash+xml) |
| GET | `/*.m4s` | DASH segment (Content-Type: video/iso.segment) |

### Token-gated DASH Streaming
| Method | Path | Mô tả |
|---|---|---|
| GET | `/dash-token/:token*.mpd` | MPD manifest với JWT token xác thực, rewrite URL segments |
| GET | `/dash-token/:token/:segment*.m4s` | Phục vụ DASH segment sau khi xác thực JWT + header secret |

> **Cơ chế bảo vệ**: JWT token được decode để lấy `url` video + kiểm tra `sessionID` trong blacklist. Header `x-player-session` và `x-player-token` cũng được validate.

### Video API
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/v1/video/upload-video-drive` | Upload video lên Google Drive |
| POST | `/api/v1/video/upload-video-firebase` | Upload video lên Firebase Storage |
| GET | `/api/v1/video/video-stream-file/:filename` | Stream MP4 file (range request) |
| GET | `/api/v1/video/video-stream-hls/:filename` | Stream HLS (tự convert nếu chưa có) |
| GET | `/api/v1/video/video-proc/convert-stream/:filename` | Trigger convert MP4 → HLS |
| OPTIONS | `/api/v1/video/video-proc/OPTIONSVideoRequest/:filename` | Preflight + redirect HLS |
| GET | `/api/v1/video/template-hls/:filename` | Trả HTML player nhúng HLS |

### Upload API (nhận file từ client upload hoặc từ node khác)
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/v1/upload/` | Nhận chunk upload, check đủ → concat + encode DASH |
| POST | `/api/v1/upload/file` | Nhận individual file |
| POST | `/api/v1/upload/test_command` | Test encode command với videoname |

> Upload flow: Client gửi chunk → `checkFileOnReceiving` → `uploadMultipartFileChunk` (Multer) → `receiveVideoFile` (check đủ chunk → `concaterServer` + `encodeIntoDashVer4`)

### Replicate API (sync video giữa các sub-server)
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/v1/replicate/receive` | Nhận chunk từ node khác |
| POST | `/api/v1/replicate/send` | Gửi file đến node khác (30MB chunks) |
| POST | `/api/v1/replicate/concate` | Ghép chunks thành file |
| POST | `/api/v1/replicate/concate-hls` | Ghép + encode → HLS |
| POST | `/api/v1/replicate/concate-dash` | Ghép + encode → DASH |
| POST | `/api/v1/replicate/receive-folder` | Nhận file trong folder DASH |
| POST | `/api/v1/replicate/send-folder` | Gửi folder DASH (manual URL) |
| POST | `/api/v1/replicate/send-folder-v2` | Gửi folder DASH (lookup từ MongoDB) |
| POST | `/api/v1/replicate/receive-file` | Nhận individual file |
| POST | `/api/v1/replicate/send-file` | Gửi individual file |

### Streaming Session Control
| Method | Path | Mô tả |
|---|---|---|
| GET | `/api/v1/streaming/stop-streaming/:token` | Thêm session vào blacklist → chặn stream |
| GET | `/api/v1/streaming/add-streaming/:token` | Xóa session khỏi blacklist → resume |

### Delete API
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/v1/delete` | Xóa video file |
| POST | `/api/v1/delete/folder` | Xóa folder video |

### RTMP / Live Stream (server_pro.js)
| Method | Path | Mô tả |
|---|---|---|
| POST | `/api/stream/control` | Stop RTMP live stream (`{ action: "stop", streamPath: "..." }`) |

---

## 5. Database Models

### Video
```
videoname: String (required)
type: "HLS" | "DASH"
size: Number
numberOfRequest: Number
numberOfReplicant: Number (default 1)
avarageSpeed: Number
createdDate, lastUpdated: Date
title: String
```

### VideoStatus
```
server: ObjectId → Server
video: ObjectId → Video
status: "ready" | "encoding" | "transfering" | "uploading"
createDate, updateDate: Date
videoDuration: Number (giây)
encodeDuration: Number (giây)
```

### Server
```
port: String
URL: String (required)
avarageSpeed, numberOfRequest: Number
storage, occupy, occupyPercentage: Number
videos: [ObjectId → Video]
description: String
```

### User
```
username, account, email: String
password: String (bcrypt hashed)
role: "guest" | "user" | "content-creator" | "admin"
premium: "normal" | "premium" | "vip" | "admin"
points: Number
identifyNumber: String (5 chữ số random)
photo.link: String
cert_paper, living_city, phone, address: String
birthday: Date
passwordResetToken, passwordResetExpires
```

---

## 6. Biến môi trường (config.env)

```env
PORT=9000               # HTTP base port
SERVERINDEX=1           # Index của sub-server này
SERVERREP=100           # Bước nhảy port giữa các server
# → Port thực = PORT + SERVERINDEX * SERVERREP = 9100

RTMPPORT=1935           # Base RTMP port
# → RTMP thực = RTMPPORT + SERVERINDEX = 1936

NODE_ENV=development
DATABASE=mongodb://127.0.0.1:27017/STREAMING_DB
DATABASE_PASSWORD=...

JWT_SECRET=...
JWT_EXPIRES_IN=90d

ENCODE_TYPE=1           # Loại encode FFmpeg (0-3)
# 0: libx264 pipeline → DASH
# 1 (default): hevc_nvenc (NVIDIA GPU) pipeline → DASH
# 2: CUDA hevc_nvenc filter_complex → DASH
# 3: libx264 single-pass → DASH

FIREBASEAPIKEY=...      # Firebase config
EMAIL_ADDRESS/PASSWORD/HOST/PORT  # Email SMTP
CLIENT_ID/CLIENT_SECRET # Google OAuth2
ONEDRIVE_CLIENT_ID/SECRET
```

---

## 7. Encode Pipeline

File `modules/encodeAPI.js` chứa nhiều phiên bản encode:

| Hàm | Mô tả |
|---|---|
| `encodeIntoDash` | Cơ bản, fluent-ffmpeg, libx264/DASH |
| `encodeIntoDashVer2` | libx265, cập nhật VideoStatus |
| `encodeIntoDashVer3` | Hai bước: command1 (multi-quality mp4) → command2 (DASH) |
| `encodeIntoDashVer4` | **Hiện dùng**, spawn trực tiếp shell command, dùng `ENCODE_TYPE` env |
| `encodeIntoDash_test` | Test nhanh không cập nhật DB |
| `encodeIntoHls` | Encode → HLS m3u8 |
| `concaterServer` | Ghép chunks thành file |

**Multi-quality DASH output**: 4 representations
- 480p @ 300kbps
- 720p @ 700kbps
- 1080p @ 1300kbps
- Original @ 2500kbps

---

## 8. Session & Blacklist

- **Blacklist** lưu in-memory (không persist sau restart): `globals/blacklist.js`
- JWT token chứa `{ sessionID, url }` — `url` là đường dẫn thư mục video DASH
- Khi stream `*.m4s`, server kiểm tra:
  1. `checkJWTToken`: sessionID không nằm trong blacklist
  2. `checkHeaderSecret`: header `x-player-session` và `x-player-token` hợp lệ
  - **Cả hai** phải pass (AND logic, có thể đổi sang OR)
- MPD được rewrite động: inject token vào path của từng segment

---

## 9. Cấu hình Multi-Server

```
PORT = 9000, SERVERREP = 100
SERVERINDEX=0 → port 9000
SERVERINDEX=1 → port 9100
SERVERINDEX=2 → port 9200
...
```

Mỗi server tự biết index của mình, các node giao tiếp với nhau qua REST API replicate.
`CONSTANTS.SUB_SERVER_CHECK_API = '/api/v1/check'`
`CONSTANTS.SUB_SERVER_REPLICATE_API = '/api/v1/replicate'`

---

## 10. Luồng xử lý chính

### Upload video từ client → encode → stream
```
Client upload chunks
    → POST /api/v1/upload/ (checkFileOnReceiving → Multer → receiveVideoFile)
    → Đủ chunks: concaterServer() ghép file
    → encodeIntoDashVer4() spawn FFmpeg pipeline
    → FFmpeg output: videos/{videoname}/init.mpd + chunk_*.m4s
    → VideoStatus cập nhật: encoding → ready
    → Client request: GET /dash-token/{jwt}.mpd
    → Server rewrite MPD, inject token
    → Client request: GET /dash-token/{jwt}/{segment}.m4s
    → Server validate token → serve segment
```

### Replicate video sang node khác
```
POST /api/v1/replicate/send-folder-v2 { videoId, serverId }
    → Lookup Video + Server từ MongoDB
    → Check file tồn tại trên destination (GET /api/v1/check/file/{filename})
    → Nếu chưa có: loop qua từng file trong folder
    → POST /api/v1/replicate/receive-folder với FormData
    → Node nhận lưu vào videos/{folder}/
```

### Stop stream
```
GET /api/v1/streaming/stop-streaming/{jwt}
    → Decode JWT lấy sessionID
    → AddToBlacklist(sessionID)
    → Mọi request m4s sau đó fail validate → res.end()
```

---

## 11. Khởi động

```bash
# Development (HLS + RTMP cơ bản)
npm start          # nodemon server.js

# Production (RTMP nâng cao + stream control)
npm run start_pro  # nodemon server_pro.js

# PM2
pm2 start ecosystem.config.js
```

---

## 12. Lưu ý quan trọng

- **Blacklist in-memory**: mất khi server restart — nếu cần persist dùng **MongoDB** (KHÔNG Redis
  — đã bỏ Redis khỏi dự án, xem `central-node-architecture-comparison.md` §8). Phát hiện node
  restart âm thầm để re-push revocation: cơ chế `bootId`/`seq` trong heartbeat (§4.2 file đó).
- `config.env` chứa credentials thật — không commit vào git production
- `ENCODE_TYPE=1` dùng `hevc_nvenc` (NVIDIA GPU) — nếu không có GPU phải đổi sang `ENCODE_TYPE=0` hoặc `3`
- **UPDATED 2026-07-19:** server timeout là 125s để connector replication 120s có thể trả acknowledgement.
- Chunk upload size: 30MB mỗi chunk khi replicate
- `x-player-token` và `x-player-session` hiện hardcode `'abcdef123456'` / `'1234567890'` trong code — **cần thay bằng logic thật trước khi production**
- Database: mặc định dùng local MongoDB `mongodb://127.0.0.1:27017/STREAMING_DB`

---

## Changelog

- **2026-07-19** — Đồng bộ runtime Sub không DB, upload/replication v2, deterministic filename, version rollout và canonical acknowledgement.
- **2026-07-19** — Bổ sung mục 0 theo static code audit. Ghi rõ MongoDB mới là quyết định cần
  migration chứ chưa bị xóa khỏi code; xác nhận không Redis/BullMQ/p-queue runtime; cập nhật
  heartbeat, encode 7/8, replicate và nginx fail-open. Giữ nguyên snapshot cũ để reference.
