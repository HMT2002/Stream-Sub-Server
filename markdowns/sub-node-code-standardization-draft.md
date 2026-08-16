# Chuẩn hoá Sub Node — bản phác thảo (DRAFT 2026-08-16)

> **Trạng thái: Phase 0 ĐÃ IMPLEMENT (2026-08-16), Phase 1–3 vẫn là đề xuất.**
> Xem mục 12 để biết chính xác cái gì đã vào code và cái gì chưa.
> Phần AS-IS (mục 1) mô tả hiện trạng **trước** Phase 0 — giữ nguyên làm mốc so sánh,
> các mục đã sửa được đánh dấu `[ĐÃ SỬA Phase 0]`.
>
> **Phạm vi:** đường nhận file (upload chunk), đường truyền file node-to-node (replication),
> đường encode (FFmpeg → DASH), đường phục vụ file (nginx `:9150` + handler Node), và cách
> Central ↔ Sub nói chuyện với nhau.
>
> **Đọc kèm:** [`upload-replication-contract-v2.md`](upload-replication-contract-v2.md) (contract
> đang chạy — tài liệu này **mở rộng**, không thay thế), [`ott-playback-token-auth.md`](ott-playback-token-auth.md)
> (auth data plane), [`encode_explain.md`](encode_explain.md) (lệnh FFmpeg),
> [`nginx-config-operations-guide.md`](nginx-config-operations-guide.md) (config nginx).

---

## 0. TL;DR — 8 quyết định của bản chuẩn hoá

| # | Quyết định | Vì sao |
|---|---|---|
| 1 | **Một tên cho một khái niệm**, có bảng thuật ngữ bắt buộc | Cùng một thứ đang mang 5 tên: `filename` / `videoname` / `folder` / `originalname` / `storageKey` |
| 2 | **Bỏ hậu tố phiên bản khỏi tên hàm/tên file**; phiên bản chỉ sống ở route path | `encodeIntoDashVer2/3/4`, `streamingVer3`, `nginx_subVer3.conf` — không đọc README thì không biết cái nào đang chạy |
| 3 | **Một envelope duy nhất** `{ok,data}` / `{ok:false,error}` cho toàn bộ control plane | Hiện có ≥5 hình dạng response khác nhau ở v1 |
| 4 | **Một logger duy nhất**, JSON, có level; cấm log per-request trên data plane | Đang tồn tại song song `console.log` tự do, `EnhaceConsoleLogType` màu mè, và `operationLog` JSON |
| 5 | **Một module đường dẫn** (`storage/paths`), mọi path đi qua `assertInside()` | Đang có 4 khái niệm "thư mục videos" khác nhau, 2 trong số đó phụ thuộc CWD |
| 6 | **Tách encode thành 3 phần**: builder thuần (string in/out) · runner (spawn) · queue (giới hạn concurrency) | `encodeAPI.js` 1525 dòng, 5 hàm encode gần trùng, không có giới hạn số FFmpeg chạy song song |
| 7 | **Sub báo ngược kết quả encode cho Central** (callback có retry, idempotent theo `jobId`) | Hiện `202 Accepted` là tín hiệu cuối cùng Central nhận được — không ai biết FFmpeg xong hay chết |
| 8 | **Đánh dấu legacy bằng dữ liệu, không bằng cảm tính**: mỗi route v1 có counter `legacy.route.hit` | Xoá code cũ chỉ an toàn khi đo được là không còn ai gọi |

---

## 1. AS-IS — hiện trạng đo được

Phần này là **sự thật theo source code** tại commit đang checkout, không phải TARGET.
Mỗi khẳng định kèm `file:line` để verify lại.

### 1.1 Ba thế hệ code cùng sống trong một process

| Thế hệ | Đường vào | Trạng thái thật |
|---|---|---|
| v1 (2025) | `/api/v1/upload`, `/api/v1/replicate`, `/api/v1/check`, `/api/v1/delete` | Còn mount, Central mới đã fallback sang nó khi Sub cũ trả 404/405/426 |
| v1.5 data plane Node | `/*.mpd`, `/*.m4s`, `/dash-token/:token*.mpd` | Còn mount ([`app.js:139-145`](../app.js)) nhưng **nginx `:9150` mới là đường phục vụ thật** |
| v2 (2026-07) | `/api/v2/uploads/chunks`, `/api/v2/replications/*` | Đường chính, có contract + test |
| auth (2026-08) | `/api/auth/verify` | Mới nhất, **chất lượng cao nhất repo** — dùng làm khuôn mẫu cho phần còn lại |

`services/authService.js` là mẫu tốt nhất đang có và nên là hình mẫu của bản chuẩn hoá:
service nhận **object thuần** trả **object thuần**, không đụng `req`/`res`, test được bằng
`node --test` mà không dựng HTTP server, và mỗi ràng buộc hiệu năng đều có comment giải thích
*vì sao*. Bản chuẩn hoá này chủ yếu là **nhân rộng khuôn đó** ra upload/replication/encode.

### 1.2 Đặt tên — bằng chứng cụ thể

**Hàm export, 3 quy ước trong cùng một layer:**

```
videoController.MPDTokenHandler          PascalCase       controllers/videoController.js:1179
defaultController.CheckIfThisServerIsFckingAlive          controllers/defaultController.js:73
uploadV2Controller.receiveChunk          camelCase        controllers/uploadV2Controller.js:8
authController.AuthRequest + authController.protect       ← cả hai trong CÙNG một file
```

**Lỗi chính tả đã đông cứng thành API:**

| Tên đang dùng | Đúng phải là | Nơi khai |
|---|---|---|
| `GenerrateRandomString` | `generateRandomString` | `modules/helperAPI.js:4` **và** `modules/encodeAPI.js:20` — trùng lặp 2 bản |
| `EnhaceConsoleLogType` | `enhanceConsoleLogType` | `modules/helperAPI.js:30` |
| `myMultilPartFile` | `multipartFile` | `modules/multerAPI.js:116` — đây là **tên field multipart**, sửa là vỡ client cũ |
| `concaterServer` | `concatenateChunks` | `modules/encodeAPI.js:1502` |

**Một alias trỏ vào chính nó** — `modules/multerAPI.js:213-214` export cả
`uploadMultipartFileChunkV2` lẫn `uploadContractChunk` cho cùng một object. Route v2 dùng tên
thứ hai, không ai dùng tên thứ nhất.

**Hậu tố phiên bản làm tên:** `encodeIntoDash` / `Ver2` / `Ver3` / `Ver4` / `_test` (5 hàm gần
trùng nhau, chỉ `Ver4` được v2 gọi); file config `streaming`, `streamingVer2`, `streamingVer3`,
`nginx_sub.conf`, `nginx_subVer3.conf`, `site-enabled-streaming` — 6 file, không đuôi, phải đọc
README mới biết cặp nào đang deploy.

### 1.3 Bảng thuật ngữ đang loạn

Cùng **một** khái niệm, các tên đang được dùng:

| Khái niệm | Các tên đang tồn tại |
|---|---|
| Tên lưu trữ của media do Central phát | `storageKey`, `filename`, `videoname`, `folder`, `originalname`, `chunkname` |
| Thư mục chứa output DASH | `outputFolder`, `videoFolder`, `videoPath`, `dir`, `folderPath` |
| Thư mục gốc chứa mọi media | `videosRoot`, `videoStoragePath`, `videoStorageRoot`, `videoChunkStoragePath`, chuỗi `'videos/'`, và `'./' + req.url` |
| File gốc trước khi encode | `filePath`, `originalname`, `videoPath`, `sourceFile` |
| Chỉ số chunk | `chunkIndex`, `index`, và header `index` |

`videoChunkStoragePath` và `videoStoragePath` ở `modules/multerAPI.js:7-8` là **hai hằng số có
giá trị y hệt nhau** (`'videos/'`).

### 1.4 Logging — ba hệ thống song song

| Kiểu | Ví dụ | Ở đâu | Vấn đề |
|---|---|---|---|
| `console.log` tự do | `console.log('m4s is here')` | `videoController.js:344` | Không parse được, chạy **mỗi segment** |
| ANSI màu | `helperAPI.EnhaceConsoleLogType(e,'ERR')` | `streamingController.js:19` | Màu ANSI vào file log = rác escape sequence |
| JSON có cấu trúc | `operationLog.write('upload.chunk.accepted',{...})` | `utils/operationLog.js` | ✅ Đúng hướng, nhưng **chỉ 8 call site**, chỉ trên đường v2 |

Thiếu hẳn: **level** (không tắt được debug), **duration** (không đo được thao tác nào chậm),
**outcome của encode** (`operationLog` chỉ ghi lúc *bắt đầu* encode thất bại, không ghi lúc kết
thúc). `morgan` chỉ bật khi `NODE_ENV === 'development'` (`app.js:35`) trong khi `config.env` đặt
`NODE_ENV=deployment` → production không có access log ở tầng Node.

`encodeAPI.js:1256-1262` log **mỗi** data event của stdout/stderr FFmpeg bằng `console.log` —
một lần encode phim dài sinh hàng nghìn dòng.

### 1.5 Response — ≥5 hình dạng, và mã trạng thái dùng sai

| Hình dạng | Ví dụ |
|---|---|
| `{ok,data}` ✅ | `controllers/uploadV2Controller.js:17` |
| `{message,path,url,port}` | `controllers/uploadController.js:41` — `url`/`port` là **biến chưa khai báo** trong scope đó (`ReferenceError` khi nhánh này chạy) |
| `{status:500,message,path}` | `controllers/videoController.js:98` |
| `{status:200,data:'Streaming stopped!'}` | `controllers/streamingController.js:30` |
| `{existed,path,fileList}` | `controllers/checkController.js:19` |
| `res.end()` — 200, body rỗng | `controllers/videoController.js:339`, `:355` |

**Mã trạng thái sai nghĩa (theo RFC 9110):**

- File phụ đề không tồn tại → **500** (`videoController.js:98`, `:119`, `:140`). 500 nghĩa là
  "server hỏng", client sẽ retry vô ích. Đúng phải là 404.
- `.mpd`/`.m4s` không tồn tại → `res.end()` = **200 + body rỗng** (`videoController.js:339`,
  `:355`). dash.js không phân biệt được "hết segment" với "server mất file" — nó nhận 200 rồi
  cố parse buffer rỗng.
- `GET /api/v1/check/file/:filename` trả **201 Created** cho một thao tác chỉ đọc
  (`checkController.js:16`, `:21`). 201 nghĩa là "đã tạo tài nguyên mới".

### 1.6 Đường dẫn — 4 khái niệm gốc khác nhau, 2 phụ thuộc CWD

```js
path.resolve(__dirname, '..', 'videos')   // services/uploadSessionService.js:4  — an toàn
path.resolve(__dirname, '..', 'videos')   // services/replicationService.js:8
'videos/'                                 // modules/multerAPI.js:7              — theo CWD
'videos/' + filename                      // controllers/deleteController.js:12  — theo CWD
'./' + req.url                            // controllers/videoController.js:90   — theo CWD + input người dùng
root /home/ubuntu/Stream-Sub-Server;      // streamingVer3 (nginx)               — tuyệt đối
```

Hệ quả: chạy `node server.js` từ thư mục khác thì một nửa repo tìm file ở chỗ khác nửa còn lại.
`pm2 start` với `cwd` khác cũng vậy.

Riêng `'./' + req.url`: `app.js:77` gọi `req.url = decodeURIComponent(req.url)` **trước** router,
nên `%2e%2e` biến thành `..` rồi mới tới handler — handler nối thẳng vào chuỗi đường dẫn, không
có `assertInside`. Trên thực tế nginx normalize `..` trước khi `proxy_pass` và cổng `9100` không
mở firewall ([`vm-server-setup-guide.md`](vm-server-setup-guide.md) §4.3), nên **chưa** thành lỗ
hổng khai thác được từ internet. Nhưng tính an toàn ở đây đang do *hạ tầng bên ngoài* bảo đảm,
không phải do code — đó là thứ bản chuẩn hoá phải sửa.

### 1.7 Central ↔ Sub — cái đã có và cái còn thiếu

**Đã có và tốt** (giữ nguyên, đây là nền của bản chuẩn hoá):

- Identity đi bằng header, filename do Sub tự suy ra — client không đặt được tên file
  (`middleware/uploadContract.js:23`).
- Replication xác nhận từng file, source chỉ trả 200 khi mọi file được ack
  (`services/replicationService.js:41`).
- `X-Request-Id` xuyên FE → Central → Sub nguồn → Sub đích, có validate và thay thế id bẩn
  (`middleware/requestTrace.js:22`).
- Sub từ chối body ID-only bằng **426 Upgrade Required** — Central cũ biết đường fallback
  (`controllers/replicationV2Controller.js:8`).

**Còn thiếu:**

| Khoảng trống | Hệ quả |
|---|---|
| **Không có xác thực giữa Central và Sub** | Bất kỳ ai tới được `:80` đều `POST /api/v2/uploads/chunks` được. Contract v2 §6 đã ghi nhận là "hardening tiếp theo" |
| **Không có callback khi encode xong** | `202 Accepted` là tín hiệu cuối cùng. `encodeIntoDashVer4(destination, originalname, statusID)` nhận `statusID` nhưng caller v2 **không truyền** (`uploadV2Controller.js:24`), và toàn bộ code cập nhật trạng thái đã bị comment (`encodeAPI.js:1295-1300`) |
| **Heartbeat là kênh thứ ba, không theo contract nào** | `POST api/v1/heartbeat/receive` với body `{payload,ts,status}` — không `contractVersion`, không `requestId`, không envelope |
| **Heartbeat không chạy ở production** | `app.js:189`: `if (process.env.NODE_ENV === 'development') heartbeatAPI.heartbeatLoop();` — mà `config.env` đặt `NODE_ENV=deployment`. Điều kiện **ngược**: chạy khi dev, tắt khi deploy |
| **Hai hình dạng heartbeat khác nhau** | Loop gửi `buildPayload(info)` (`heartbeatAPI.js:98`), còn `GET /heartbeat` gửi thẳng `heartbeatInfo` (`defaultController.js:97`) — Central nhận hai schema khác nhau từ cùng một node |
| **URL Central hardcode** | `defaultController.js:41`, `:69`: `res.redirect(308,'http://localhost:9000/redirect/recall?...')` dù `config.env` đã có `CENTRAL_API` |

### 1.8 Encode — 1525 dòng, không hàng đợi, không tín hiệu kết thúc

- 5 hàm encode gần trùng (`encodeIntoDash`, `Ver2`, `Ver3`, `Ver4`, `_test`), chỉ `Ver4` được
  đường v2 gọi.
- `encodeCommand()` (`encodeAPI.js:47`) **đã là hàm thuần** string-in/string-out — tài sản tốt,
  chỉ cần tách ra khỏi file 1525 dòng là test được ngay.
- **Không giới hạn concurrency.** Hai upload kết thúc cùng lúc = hai FFmpeg NVENC song song trên
  một node. Quyết định kiến trúc của dự án là dùng `p-queue`
  ([`central-node-architecture-comparison.md`](central-node-architecture-comparison.md)) — Sub
  chưa implement.
- **Fire-and-forget**: `void encodeAPI.encodeIntoDashVer4(...).catch(...)`
  (`uploadV2Controller.js:23`). Node restart giữa chừng = job biến mất, không ai biết.
- `fs.unlinkSync(filePath, function (err) {...})` (`encodeAPI.js:1275`) — `unlinkSync` **không
  nhận callback**; callback bị bỏ qua im lặng. Vô hại nhưng cho thấy đoạn này chưa từng được
  đọc lại.
- `const ffmpegPath = '..\\ffmpeg.exe'` (`encodeAPI.js:9`) — đường dẫn Windows tương đối,
  hardcode, dòng `require('@ffmpeg-installer/ffmpeg')` bị comment ngay trên. Lệnh encode thật đi
  qua `spawn(commandString, [], {shell:true})` gọi `ffmpeg` trong `PATH` nên không dính, nhưng
  `fluentFfmpeg.ffprobe()` (`encodeAPI.js:1237`) chạy qua fluent-ffmpeg. `TODO: cần xác minh
  trên VM Linux` — fluent-ffmpeg dùng `setFfprobePath` riêng nên **có thể** ffprobe vẫn lấy từ
  `PATH`; cần chạy thử và xem `videoDuration` có ra 0 không.
- File tạm nằm lẫn trong thư mục được phục vụ: `.part.N` và `.<uploadId>.accepted.json` ghi thẳng
  vào `videos/` (`uploadSessionService.js:5,7`) — cùng thư mục nginx `:9150` đang serve.

### 1.9 Test

3 file (`contracts`, `auth`, `requestTrace`), `node:test` thuần, không framework — nền tốt.
Nhưng `package.json:7` liệt kê **tên từng file**; thêm file test mới mà quên sửa dòng đó thì nó
không bao giờ chạy, và CI vẫn xanh.

---

## 2. Bảng thuật ngữ bắt buộc (glossary)

Đây là artifact quan trọng nhất của tài liệu. Mọi code mới **phải** dùng cột 2; mọi tên ở cột 3
chỉ được tồn tại trong code legacy.

| Khái niệm | Tên chuẩn | Không dùng nữa |
|---|---|---|
| Tên lưu trữ do Central phát | `storageKey` | `filename`, `videoname`, `folder`, `originalname` |
| Thư mục gốc chứa media | `mediaRoot` | `videosRoot`, `videoStoragePath`, `videoStorageRoot` |
| Thư mục output DASH của 1 video | `mediaDir` | `outputFolder`, `videoFolder`, `dir` |
| File nguồn trước encode | `sourceFile` | `filePath`, `videoPath` |
| Thư mục chứa file tạm | `stagingRoot` | (chưa có — hiện dùng chung `videos/`) |
| Phiên upload | `uploadId` | `uploadid` |
| Chỉ số / tổng số chunk | `chunkIndex` / `chunkCount` | `index`, `chunknames` |
| Mảnh chunk trên đĩa | `chunkPart` | `chunkname` |
| Lệnh replication | `jobId` | `statusId` |
| Id trace xuyên tiến trình | `requestId` | — |
| Định danh node | `nodeId` | `serverIndex`, `SERVERINDEX` |
| Loại media | `mediaType` (`'DASH'`) | `type` |

Quy ước tên **hàm**: `camelCase`, **động từ đứng trước**, không hậu tố phiên bản.
`receiveChunk`, `sendFolder`, `buildDashCommand`, `runDashEncode`, `verifyPlaybackToken`.

Quy ước tên **file**: `camelCase.js` giữ nguyên (đúng convention Express đang dùng); **bỏ số
phiên bản khỏi tên file** — phiên bản nằm ở route path (`/api/v2/...`) và ở `contractVersion`.

Quy ước **event log**: `<domain>.<object>.<outcome>` — `upload.chunk.accepted`,
`encode.job.failed`, `replication.folder.sent`. Đây đã là style của `operationLog` sẵn có, chỉ
cần viết thành luật.

---

## 3. Kiến trúc TARGET — tách tầng

```
platform/          # hạ tầng, không biết gì về nghiệp vụ
  log.js           #   logger JSON có level        (thay utils/operationLog.js)
  config.js        #   đọc & validate env MỘT LẦN lúc boot
  errors.js        #   AppError + catalogue mã lỗi
  requestContext.js#   (giữ nguyên — đang tốt)

storage/
  paths.js         # mediaRoot/mediaDir/sourceFile/chunkPart + assertInside()
  layout.js        # quy ước thư mục: đâu là staging, đâu là nội dung được serve

media/
  dashCommand.js   # HÀM THUẦN: (profile, sourceFile, mediaDir) -> string. Test được 100%
  probe.js         # ffprobe -> {durationSec, width, height}
  encodeRunner.js  # spawn + timing + thu stderr có giới hạn + kết quả {ok,code,stderrTail}
  encodeQueue.js   # p-queue, ENCODE_CONCURRENCY (mặc định 1)

services/          # nghiệp vụ thuần: nhận object thuần, trả object thuần
  uploadSessionService.js      (giữ, đổi sang storage/paths)
  replicationService.js        (giữ, đổi sang storage/paths + envelope)
  encodeJobService.js          MỚI — vòng đời job + callback về Central
  heartbeatService.js          (từ modules/heartbeatAPI.js)
  authService.js               (giữ nguyên — đã đạt chuẩn)

http/
  middleware/      # requestTrace, uploadContract, replicationContract, nodeAuth (MỚI)
  presenters/      # ok()/fail() — nơi DUY NHẤT biết hình dạng envelope
  controllers/     # mỏng: đọc contract -> gọi service -> presenter. Không fs, không axios
  routes/

clients/
  centralClient.js # MỚI — nơi DUY NHẤT gọi ngược Central (callback, heartbeat)

legacy/            # v1 nguyên trạng, chỉ vá lỗi, không thêm tính năng
```

**Luật ranh giới** (kiểm được bằng lint rule):

1. `controllers/` **không** được `require('fs')`, `require('axios')`, `require('child_process')`.
2. `services/` **không** được nhận `req`/`res`. Vào bằng object thuần, ra bằng object thuần.
   (Đây chính là điều làm `authService` test được — nhân rộng ra.)
3. Chỉ `presenters/` biết hình dạng `{ok,data}`. Controller gọi `ok(res, data)`, không tự
   `res.json`.
4. Chỉ `storage/paths.js` được ghép đường dẫn filesystem.
5. Chỉ `clients/centralClient.js` được gọi ra Central.

---

## 4. Chuẩn giao tiếp Central ↔ Sub

### 4.1 Envelope — áp cho mọi endpoint control plane

```jsonc
// thành công
{ "ok": true,  "data": { /* ... */ } }
// thất bại
{ "ok": false, "error": { "code": "UPLOAD_CHUNK_INVALID", "message": "...",
                          "requestId": "a1b2c3d4", "details": { } } }
```

`code` là hằng SCREAMING_SNAKE **ổn định** — Central rẽ nhánh theo `code`, không theo `message`.
`message` dành cho người đọc log và **được phép đổi**. Catalogue đề xuất:

| `code` | HTTP | Nghĩa | Central nên làm gì |
|---|---|---|---|
| `CONTRACT_VERSION_REQUIRED` | 400 | Thiếu/sai `contractVersion` | Sửa connector |
| `IDENTITY_INVALID` | 400 | `uploadId`/`jobId`/`storageKey` không phải token ASCII an toàn | Không retry |
| `CHUNK_RANGE_INVALID` | 400 | `chunkIndex >= chunkCount` | Không retry |
| `NODE_AUTH_FAILED` | 401 | Sai/thiếu chữ ký node | Không retry |
| `MEDIA_NOT_FOUND` | 404 | `videos/<storageKey>` không tồn tại ở source | Kiểm tra placement trong DB |
| `DESTINATION_REJECTED` | 502 | Sub đích không ack đúng file | Retry job, có thể đổi đích |
| `REPLICATION_CONNECTOR_UPGRADE_REQUIRED` | 426 | Body ID-only kiểu cũ | Fallback v1 (đã implement) |
| `ENCODE_START_FAILED` | 500 | Không spawn được FFmpeg | Cảnh báo vận hành |

**Data plane không dùng envelope.** `/api/auth/verify` chỉ trả status + header
(`ngx_http_auth_request_module` vứt body của subrequest), và `*.m4s`/`*.mpd` trả **bytes**.
Đây là ngoại lệ có chủ đích, phải ghi rõ để không ai "chuẩn hoá" nhầm vào đó.

### 4.2 Mã trạng thái — luật cứng

| Tình huống | Mã | Hiện đang trả |
|---|---|---|
| Nhận chunk, chưa đủ | 202 | 202 ✅ |
| Nhận chunk cuối, đã nhận job encode | 202 | 202 ✅ |
| Nhận xong 1 file replication | 201 | 201 ✅ |
| Đọc trạng thái (check/stats) | 200 | **201** ❌ (`checkController.js`) |
| Không tìm thấy file | 404 | **500** ❌ (phụ đề) / **200 rỗng** ❌ (`.m4s`) |
| Contract sai phiên bản | 426 | 426 ✅ |

Nguyên tắc: **404 nghĩa là "không có", 5xx nghĩa là "tôi hỏng"**. Trả 5xx cho một file không tồn
tại khiến player retry và khiến alert vận hành kêu sai chỗ.

### 4.3 Header chuẩn

| Header | Bắt buộc ở | Ghi chú |
|---|---|---|
| `X-Request-Id` | mọi control plane | Đã implement. Format `^[A-Za-z0-9._:-]{1,128}$`, id bẩn bị **thay** chứ không echo |
| `X-Upload-Contract` / `X-Replication-Contract` | endpoint tương ứng | Đã implement |
| `X-Node-Id` | **MỚI** — mọi request Central→Sub và Sub→Sub | Biết node nào gọi mà không phải suy từ IP |
| `X-Node-Auth` | **MỚI** | Xem 4.4 |

### 4.4 Xác thực Central ↔ Sub (ĐỀ XUẤT, chưa kiểm chứng)

Vấn đề: `POST /api/v2/uploads/chunks` hiện **không xác thực gì**. Ai tới được `:80` cũng ghi
được file vào node.

Đề xuất **HMAC shared-secret** thay vì mTLS cho giai đoạn này: mTLS đúng hơn về mặt bảo mật
nhưng kéo theo quản lý CA + xoay vòng cert trên nhiều VM ở nhiều cloud — chi phí vận hành lớn
hơn nhiều so với mức rủi ro hiện tại (hệ thống nội bộ, node không public 9100).

```
X-Node-Id:   sub-oracle-01
X-Node-Ts:   1755302400          # epoch giây
X-Node-Auth: v1=<hex hmac-sha256>

hmac = HMAC_SHA256(NODE_SHARED_SECRET,
                   method + '\n' + path + '\n' + contractVersion + '\n' +
                   (uploadId | jobId) + '\n' + nodeTs)
```

- Cửa sổ chống replay: `|now - X-Node-Ts| <= 300s`. Lệch giờ giữa VM khác zone là nguyên nhân
  false-reject phổ biến nhất — cùng lý do `authService` đã có `AUTH_CLOCK_SKEW`.
- **Không ký body**: body là file hàng chục MB, băm lại là nhân đôi I/O. Ký metadata đủ chặn
  "người lạ tự tạo job"; chống sửa nội dung là việc của checksum (mục 6, backlog).
- Rollout **bắt buộc 3 mức** giống `AUTH_MODE`: `off` → `log` → `enforce`. Bật thẳng `enforce`
  trên hệ đang chạy là tự cắt liên lạc với mọi Central chưa cập nhật.

### 4.5 Callback kết quả encode (MỚI — khoảng trống lớn nhất)

Hiện tại chuỗi đứt ngay sau `202`:

```
FE → Sub: chunk cuối
Sub → FE: 202 {job:{type:'dash-encode',state:'accepted'}}
Sub: spawn ffmpeg ... (30 phút)
Sub: xong / chết
Central: ¯\_(ツ)_/¯
```

Đề xuất Sub chủ động báo ngược:

```
POST {CENTRAL_API}/api/v1/nodes/:nodeId/jobs/:jobId/result
X-Request-Id: <requestId của phiên upload>      ← nối lại được với log lúc nhận chunk
X-Node-Id / X-Node-Ts / X-Node-Auth

{ "contractVersion": "stream-encode-v1",
  "jobId": "...", "storageKey": "...", "uploadId": "...",
  "state": "ready",                    // ready | failed
  "media": { "mediaDir": "videos/<storageKey>", "files": 42,
             "durationSec": 1432.5, "manifest": "init.mpd" },
  "encode": { "profile": 7, "startedAt": "...", "finishedAt": "...", "encodeSec": 812 },
  "error": null }
```

Ba tính chất bắt buộc:

1. **Idempotent theo `jobId`** — Sub retry, Central phải chịu được lệnh trùng.
2. **Retry có backoff và có giới hạn** (đề xuất 5 lần, 5s → 80s). Central restart đúng lúc
   encode xong là chuyện bình thường.
3. **Bền qua restart**: ghi `videos/<storageKey>/.job.json` **trước** khi gọi callback. Sub khởi
   động lại thì quét các `.job.json` chưa `acked` và gửi lại. Không có bước này thì callback chỉ
   là "cố gắng hết sức" — vẫn mất job khi node reboot.

`stream-encode-v1` là **contract mới**, không đụng `stream-upload-v2`/`stream-replication-v2`
đang chạy → triển khai được độc lập.

### 4.6 Heartbeat theo cùng một chuẩn

```jsonc
{ "contractVersion": "stream-heartbeat-v2",
  "nodeId": "sub-oracle-01",
  "sentAt": "2026-08-16T03:00:00.000Z",
  "state": "alive",
  "capacity": { "cpuCount": 4, "freeMemBytes": 1234567, "encodeQueueDepth": 2 },
  "inventory": { "hash": "…", "count": 87, "items": [ /* chỉ gửi khi hash đổi */ ] } }
```

Hai sửa lỗi đi kèm, độc lập với việc đổi schema:

1. `app.js:189` — điều kiện đang **ngược**. Heartbeat phải chạy ở deployment, tuỳ chọn tắt bằng
   `HEARTBEAT_ENABLED=off`, chứ không gắn vào `NODE_ENV === 'development'`.
2. `GET /heartbeat` (`defaultController.js:97`) phải dùng **cùng** `buildPayload` với vòng lặp,
   nếu không Central nhận hai schema khác nhau từ cùng một node.

`inventory.items` chỉ gửi khi `hash` đổi: `heartbeatAPI` đã tính `videosInfoHash` sẵn
(`heartbeatAPI.js:60`) nhưng vẫn gửi toàn bộ danh sách mỗi 10 giây. Node có vài nghìn video thì
đây là payload lớn lặp vô ích.

---

## 5. Chuẩn logging

### 5.1 Một logger, có level

```js
// platform/log.js  (ĐỀ XUẤT — chưa implement)
log.debug(event, fields)   // chi tiết dev; TẮT mặc định
log.info (event, fields)   // mốc nghiệp vụ — thay operationLog.write
log.warn (event, fields)   // bất thường nhưng đã xử lý được
log.error(event, fields)   // thao tác thất bại
```

- Ra **JSON một dòng**, giữ nguyên hình dạng `operationLog` hiện có (`timestamp`, `scope`,
  `requestId`, `event`, …) để dashboard/parser sẵn có không vỡ.
- `requestId` tự lấy từ `AsyncLocalStorage`, **không phải tham số** — đây là thiết kế đúng đã có
  ở `utils/operationLog.js`, giữ nguyên.
- `LOG_LEVEL` trong `config.env`, mặc định `info`.
- `utils/operationLog.js` trở thành shim `module.exports = { write: log.info }` → **0 call site
  phải sửa** trong bước đầu.

### 5.2 Luật cứng cho data plane

Một phiên xem 2 tiếng, segment 4 giây = **~1800 request/người xem**. Nhân với số người xem đồng
thời. Vì vậy trên `/api/auth/verify` và các handler `*.m4s`/`*.mpd`:

- **Cấm** log per-request ở nhánh thành công.
- Chỉ được **đếm** (mẫu hình `authController.stats` đang làm — đúng, giữ).
- Nhánh từ chối được log, nhưng phải qua rate-limit (một token hỏng sẽ retry liên tục).

Luật này đã được viết thành comment ở `middleware/requestTrace.js` và `services/authService.js`;
bản chuẩn hoá nâng nó thành **luật của repo**, không phải ghi chú của một file.

### 5.3 Trường bắt buộc / cấm

**Bắt buộc** ở mọi dòng nghiệp vụ: `event`, `requestId` (nếu trong request scope),
`durationMs` (với thao tác có thời lượng), và **outcome** — hiện `operationLog` chỉ ghi lúc bắt
đầu encode thất bại, không có dòng nào lúc encode kết thúc.

**Cấm**: log toàn bộ `req.headers` (chứa token), log binary/buffer, log giá trị token/secret.
Đề xuất một helper `redact(headers)` giữ allowlist, để việc "log headers khi debug" không thành
rò rỉ token.

**FFmpeg stderr**: không log mỗi data event (`encodeAPI.js:1256-1262`). Giữ **vòng đệm N dòng
cuối** (đề xuất 50) và chỉ xuất ra khi `close` trả code ≠ 0 — lúc đó là thứ duy nhất cần đọc.

---

## 6. Chuẩn đường dẫn & bố cục thư mục

```js
// storage/paths.js  (ĐỀ XUẤT)
mediaRoot()                  // MEDIA_ROOT env, mặc định path.resolve(__dirname,'..','videos')
mediaDir(storageKey)         // <mediaRoot>/<storageKey>
sourceFile(storageKey, ext)  // <stagingRoot>/<storageKey>.<ext>
chunkPart(uploadId, index)   // <stagingRoot>/<uploadId>.part.<index>
uploadMarker(uploadId)       // <stagingRoot>/<uploadId>.accepted.json
assertInside(root, resolved) // ném IDENTITY_INVALID nếu thoát ra ngoài root
```

Mọi hàm chạy `assertInside` **bên trong**, không dựa vào caller nhớ gọi. Đây là điểm khác biệt
so với hiện tại: `safeStorageKey` tồn tại ở `replicationService.js:9` nhưng
`uploadSessionService.js` **không** gọi nó — nó tin `middleware/uploadContract` đã validate. Đúng
trên thực tế, nhưng bảo đảm nằm ở *file khác*; ai gọi service trực tiếp (test, script vận hành,
code tương lai) là mất bảo đảm đó.

**Tách staging khỏi thư mục được phục vụ** (đề xuất):

```
videos/<storageKey>/…     ← nginx :9150 serve. CHỈ chứa nội dung phát được.
var/incoming/…            ← .part.N, .accepted.json, .job.json
```

Lý do: `videos/` đang là `root` của nginx. File `.part.N` dở dang và marker JSON nằm trong đó là
bề mặt không cần thiết, và làm mọi thao tác liệt kê/dọn dẹp phải lọc thủ công.
**Ràng buộc:** `root` trong `streamingVer3` và URL contract `…:9150/videos/<storageKey>/init.mpd`
**không được đổi** — chỉ chỗ chứa file tạm đổi.

---

## 7. Chuẩn encode

### 7.1 Tách 3 phần

| Module | Trách nhiệm | Test |
|---|---|---|
| `media/dashCommand.js` | `(profile, sourceFile, mediaDir) → string`. Không fs, không spawn | Unit test thuần — so chuỗi lệnh, kiểm quote |
| `media/encodeRunner.js` | spawn, đo thời gian, thu stderr có giới hạn, trả `{ok, exitCode, stderrTail, encodeSec}` | Test bằng lệnh giả (`node -e`) |
| `media/encodeQueue.js` | `p-queue`, `ENCODE_CONCURRENCY` mặc định 1 | Test thứ tự + giới hạn |

`encodeCommand()` hiện tại **đã thuần** — bước tách này gần như là di chuyển file, rủi ro thấp,
giá trị cao (mở khoá test cho phần dễ sai nhất).

### 7.2 Vòng đời job

```
accepted → queued → running → ready | failed
    ↓         ↓        ↓          ↓
  .job.json ghi lại mỗi lần đổi trạng thái (atomic: ghi .tmp rồi rename)
```

`.job.json` là thứ cho phép **reconcile sau restart** — quét thư mục lúc boot, job nào ở
`running` mà không có process thì đánh `failed` và báo Central. Không có nó, contract v2 §6 mãi
còn dòng "durable job completion/reconcile vẫn là backlog".

### 7.3 An toàn lệnh shell

`spawn(commandString, [], {shell: true})` chạy **cả chuỗi qua shell**. Hiện an toàn vì
`storageKey` đã bị regex `^[a-zA-Z0-9._-]+$` chặn ở middleware, và `quotePath` từ chối dấu `"`.
Nhưng: bảo đảm nằm ở *module khác*, và `quotePath` chỉ chặn `"` chứ không chặn `` ` ``, `$`, `;`
— nó dựa hoàn toàn vào việc đầu vào đã sạch từ trước.

Hai lựa chọn:

- **(a) Giữ shell** (cần cho chuỗi `&&`/`||` của thumbnail — xem
  [`encode_explain.md`](encode_explain.md)) nhưng thêm `assertSafePathToken()` **ngay trong**
  `dashCommand.js`, để tính an toàn là tính chất *cục bộ* của module.
- **(b) Bỏ shell**: tách thành 3 lần spawn (`thumbnail.png`, `thumb.webp`, DASH) với mảng
  argv, tự xử lý luật "bản nhỏ được phép thất bại" bằng JavaScript thay vì bằng `||` của shell.

Đề xuất **(a) trước, (b) sau** — (b) đúng hơn nhưng phải viết lại logic chuỗi lệnh đã được kiểm
chứng trên cả `cmd.exe` lẫn `/bin/sh`.

---

## 8. Chính sách legacy — đánh dấu bằng dữ liệu

### 8.1 Cách đánh dấu

```js
/**
 * @deprecated 2026-08-16 — thay bằng `services/uploadSessionService.acceptChunk`.
 * Lý do: nhận tên file từ client (`req.headers.chunkname`), không có kiểm tra path.
 * Xoá khi: counter `legacy.route.hit{route:"/api/v1/upload"}` = 0 trong 30 ngày.
 */
```

Ba phần **bắt buộc**: thay bằng gì · vì sao bỏ · **điều kiện xoá**. Không có điều kiện xoá thì
`@deprecated` chỉ là lời than phiền, code sẽ nằm đó vĩnh viễn.

### 8.2 Counter — để việc xoá dựa trên đo đạc

Một middleware gắn lên toàn bộ route v1:

```js
// http/middleware/legacyProbe.js (ĐỀ XUẤT)
log.warn('legacy.route.hit', { route: req.baseUrl, method: req.method,
                               caller: req.get('X-Node-Id') || req.ip });
```

Sau 30 ngày, `grep` log là biết chính xác route nào Central còn gọi và ai gọi. Đây là cách duy
nhất xoá code cũ mà không phải đoán — và nó đặc biệt cần ở đây vì contract v2 §5 nói rõ Central
mới **cố tình** fallback về `/api/v1/replicate/send-folder-v2` khi gặp Sub cũ.

### 8.3 Danh sách ứng viên legacy (đề xuất, cần Central xác nhận)

| Thành phần | Lý do | Rào cản |
|---|---|---|
| `controllers/rtmpType1/2/2_5/3Controller.js` (~66 KB) | RTMP không nằm trong kiến trúc hiện tại; `server.js` chỉ chạy node-media-server khi `VER === undefined`, mà `config.env` đặt `VER=1.6` → **không bao giờ chạy** | Không có. Ứng viên xoá sạch nhất |
| `videoController` `*.mpd`/`*.m4s`/`*.vtt` handler | nginx `:9150` mới là đường phục vụ thật | Phải xác nhận không client cũ nào còn gọi Node `:9100` trực tiếp |
| `/dash-token/:token*` | Trùng chức năng với `auth_request` + token ở query | FE cũ có thể còn dùng |
| `encodeIntoDash`, `Ver2`, `Ver3`, `_test` | Chỉ `Ver4` được gọi | Không có |
| `models/` + `mongoose` trong `package.json` | Sub đã không DB từ 2026-07 (contract v2 §6) | Kiểm `require` còn sót |
| `helperAPI.GenerrateRandomString` **hoặc** `encodeAPI.GenerrateRandomString` | Hai bản y hệt | Chọn một, bản kia thành shim |

---

## 9. Lộ trình

### Phase 0 — nền, **không đổi hành vi** (rủi ro thấp nhất)

1. `platform/log.js`; `utils/operationLog.js` thành shim → 0 call site phải sửa.
2. `storage/paths.js` + `assertInside`; `uploadSessionService`/`replicationService`/`multerAPI`
   trỏ vào nó.
3. `platform/config.js` — validate env lúc boot, **chết sớm** nếu thiếu `JWT_SECRET`. Hiện
   `authService` đọc `process.env` mỗi lần verify (`authService.js:63`, `:183`) — chạy mỗi
   segment.
4. Tag `@deprecated` + `legacyProbe` counter.
5. `package.json` test script → `node --test tests/` (bỏ danh sách tay).
6. Bảng thuật ngữ (mục 2) vào `CLAUDE.md`/`SKILL.sub-node.md`.

**Sửa lỗi rời, độc lập, làm được ngay:** điều kiện heartbeat ngược (`app.js:189`), `url`/`port`
chưa khai báo (`uploadController.js:41`), 500→404 cho phụ đề, `localhost:9000` hardcode
(`defaultController.js:41,69`), hai schema heartbeat.

### Phase 1 — đường mới song song với đường cũ

7. `http/presenters/` + catalogue mã lỗi; áp cho **toàn bộ** `/api/v2`.
8. Tách `media/` thành 3 module + queue giới hạn concurrency.
9. `encodeJobService` + `.job.json` + callback `stream-encode-v1`.
10. `clients/centralClient.js` — gộp heartbeat + callback vào một chỗ, một chính sách retry.

### Phase 2 — siết

11. `nodeAuth` HMAC, rollout `off → log → enforce` (mượn nguyên mô hình `AUTH_MODE`).
12. `heartbeat-v2` + inventory theo hash.
13. Data plane Node → sau cờ `LEGACY_NODE_SERVING=off`, mặc định tắt.

### Phase 3 — dọn

14. Đọc counter. Route nào 0 hit trong 30 ngày thì chuyển vào `legacy/`.
15. Xoá RTMP controller, các bản `encodeIntoDash*` thừa, `mongoose`.

Mỗi phase **ship độc lập được**. Thứ tự rollout toàn hệ vẫn theo contract v2 §5:
**Central mới → Sub mới → FE mới**.

---

## 10. Rủi ro

| Rủi ro | Vì sao nguy hiểm | Giảm thiểu |
|---|---|---|
| Đổi `root`/URL nginx | `nginx -t` vẫn PASS khi `root` sai → 404 toàn bộ, im lặng | Không đụng `root` và URL `/videos/<key>/init.mpd` trong toàn bộ lộ trình |
| Đổi path `/api/auth/verify` | Hardcode trong `streamingVer3`; sai path → Node 404 → nginx dịch thành 500 → `error_page` fail-open → auth mất tác dụng **im lặng** | Khoá path này; đã có cảnh báo ở `routes/authRoute.js:8` |
| Đổi tên field multipart (`multipartFileChunk`, `replicationFile`) | FE và Central hardcode | Không đổi. Tên xấu (`myMultilPartFile`) chỉ nằm ở v1, để nguyên trong `legacy/` |
| Bật `nodeAuth` thẳng `enforce` | Cắt liên lạc với Central chưa cập nhật | Bắt buộc qua `log` và đọc counter, như `AUTH_MODE` |
| Tách file hàng loạt | Diff lớn, review không nổi, dễ lẫn lỗi hành vi vào lẫn đổi tên | Phase 0 **cấm** đổi hành vi; mỗi PR làm một việc |
| Xoá route v1 sớm | Central mới cố tình fallback v1 khi gặp Sub cũ (contract v2 §5) | Chỉ xoá khi counter = 0 trong 30 ngày |

---

## 11. Câu hỏi cần chốt trước khi implement

1. **Callback encode** — Central có sẵn endpoint nhận chưa, hay Sub phải chờ? Đây là thứ chặn
   Phase 1 mục 9.
2. **`nodeId`** — lấy từ đâu? Hiện chỉ có `SERVERINDEX` (số) trong `config.env`; Central định
   danh node bằng `_id` của Mongo. Cần một id ổn định hai bên cùng hiểu.
3. **Data plane Node** còn client nào gọi thẳng `:9100` cho `*.m4s` không? Nếu không, mục 13
   làm được ngay ở Phase 1.
4. **`ENCODE_CONCURRENCY`** — node Oracle free tier chịu được mấy FFmpeg song song? Cần đo trước
   khi chọn mặc định (đề xuất tạm 1).
5. **`stagingRoot`** — tách file tạm ra khỏi `videos/` có ảnh hưởng script vận hành/backup nào
   đang giả định mọi thứ nằm trong `videos/` không?

---

## 12. [UPDATED 2026-08-16] Phase 0 — đã implement

Bổ sung sau khi đọc `Stream-Central-Server/backend`. Điều quan trọng nhất phát hiện được:
**Central đã có sẵn khuôn cần khớp**, nên Phase 0 là *đồng bộ về* khuôn đó chứ không phải phát
minh khuôn mới.

| Central đã có | Sub Phase 0 |
|---|---|
| `utils/logger.js` — `child(scope)`, JSON `{time,level,requestId,scope,message,meta}` | `platform/log.js` — **cùng tên field**, thêm `event` |
| `utils/appError.js` — `AppError(message, statusCode, apiCode)` | `utils/appError.js` — thêm tham số `apiCode` |
| `controllers/errorController.js` — `getDefaultApiCode(status)` | `controllers/errorController.js` — **cùng bảng mã** |
| `clients/nodeClient.js` — `validateStatus: () => true`, status là dữ liệu chứ không phải exception | `services/replicationService.js` — áp cùng nguyên tắc |
| `utils/requestContext.js` — AsyncLocalStorage | đã có sẵn từ 2026-08-15 |

### 12.1 File mới

| File | Vai trò |
|---|---|
| `platform/log.js` | Logger duy nhất: level, redaction, JSON/pretty, `child(scope)`, `event(name, fields)` |
| `platform/config.js` | Đọc + validate env một lần; `inspect()` liệt kê biến thiếu kèm hậu quả |
| `storage/paths.js` | Nơi duy nhất ghép path; `assertToken` + `assertInside` chạy **bên trong** mỗi hàm |
| `middleware/legacyProbe.js` | Đếm route v1 còn được gọi + ai gọi → cơ sở để xoá code cũ |
| `tests/platform.test.js` | 14 test cho ba module trên |

### 12.2 Đã sửa (lỗi thật, có bằng chứng)

| Lỗi | Trước | Sau |
|---|---|---|
| Heartbeat không chạy ở production | `if (NODE_ENV === 'development')` — điều kiện **ngược** | `config.heartbeat.enabled`, mặc định bật, tắt bằng `HEARTBEAT_ENABLED=off` |
| Hai schema heartbeat từ một node | Loop gửi `buildPayload(info)`, `GET /heartbeat` gửi `info` | Cả hai dùng `buildPayload` |
| `ReferenceError` khi upload trùng tên | `uploadController` dùng `url`/`port` chưa khai báo → 500 | Bỏ hai field không tồn tại |
| Phụ đề không tồn tại → 500 | `res.status(500)` ở ASS/SRT/VTT | **404**, và ba bản sao gộp thành một hàm |
| URL Central hardcode | `http://localhost:9000/redirect/recall` | `config.centralApi` |
| `JITTER` là chuỗi | `10000 - "10"` chạy nhờ ép kiểu ngầm | `config` trả số |
| `readdir` gọi hai lần | `gatherVideosInfo` vứt kết quả lần đầu | gọi một lần; `ENOENT` → danh sách rỗng thay vì hỏng cả nhịp |
| Biến toàn cục rò rỉ | `return (heartbeatInfo = {...})` — chưa khai báo | trả thẳng object |
| `Number('')` = 0 | `config.num()` coi biến thiếu là 0 | trả `fallback`; `ENCODE_TYPE` thiếu bị `inspect()` bắt |

> **[SUPERSEDED 2026-08-16b]** Bản đầu của tài liệu này viết: *"`ENCODE_TYPE` sai → switch không
> khớp case nào → lệnh encode RỖNG"*.
>
> **[UPDATED 2026-08-16b]** Sai. Đọc lại `dashCommand.js` khi tách file: `case 8` **dùng chung
> nhánh `default:`**, nên `ENCODE_TYPE` lạ hoặc `NaN` rơi vào **case 8 — libx264, encode bằng
> CPU**, không phải chuỗi rỗng. Hậu quả thật nhẹ hơn nhưng khó thấy hơn: node có GPU sẽ encode
> bằng CPU chậm gấp nhiều lần so với ý định (case 7 = NVENC), không lỗi, không log. `ENCODE_TYPE`
> vẫn nằm trong danh sách biến bắt buộc vì lý do đó.
| Test mới không chạy | `package.json` liệt kê từng file | `node --test "tests/*.test.js"` |
| Regex token có 3 bản sao | uploadContract, replicationContract, replicationService | dùng chung `storage/paths.SAFE_TOKEN` |
| Mọi lỗi 400 về Central đều `BAD_REQUEST` | `err.code` không bao giờ được đặt | `apiCode` thật: `CONTRACT_VERSION_REQUIRED`, `CHUNK_RANGE_INVALID`, `IDENTITY_INVALID`, `MEDIA_NOT_FOUND`, `DESTINATION_REJECTED`… |

Kiểm chứng bằng HTTP thật (`app.listen` + `http.request`, không mock):

```
POST /api/v2/uploads/chunks  (thiếu header contract)
  400 {"ok":false,"error":{"code":"CONTRACT_VERSION_REQUIRED",...,"requestId":"3b837653"}}
POST /api/v2/uploads/chunks  (chunkIndex 9 / chunkCount 2)
  400 {"ok":false,"error":{"code":"CHUNK_RANGE_INVALID",...}}
POST /api/v2/uploads/chunks  (storageKey "../../etc")
  400 {"ok":false,"error":{"code":"IDENTITY_INVALID",...}}
```

### 12.3 Thay đổi quan sát được — chỉ MỘT

Định dạng dòng log JSON: field nghiệp vụ chuyển từ trải phẳng ở gốc vào `meta`, và
`timestamp` → `time`, thêm `level`/`message`.

```jsonc
// trước
{"timestamp":"…","scope":"media-contract-v2","requestId":"log-me","event":"upload.chunk.accepted","uploadId":"u1","chunkIndex":0}
// sau
{"time":"…","level":"info","requestId":"log-me","scope":"media-contract-v2","event":"upload.chunk.accepted","message":"upload.chunk.accepted","meta":{"uploadId":"u1","chunkIndex":0}}
```

Đây là thay đổi **có chủ đích**: khớp `Stream-Central-Server/backend/utils/logger.js` để hai
repo query chung một lượt theo `requestId`, và tách `meta` để field nghiệp vụ không đụng tên
field khung. Đã kiểm: không có consumer nào parse định dạng cũ (chuỗi `media-contract-v2` chỉ
xuất hiện đúng ở `utils/operationLog.js`). Test `requestTrace.test.js` được cập nhật theo.

`utils/operationLog.js` giữ nguyên API `write(event, fields)` nên **không call site nào phải sửa**.

### 12.4 Cố ý CHƯA làm ở Phase 0

| Việc | Vì sao hoãn |
|---|---|
| Tách `stagingRoot` khỏi `videos/` | Đổi ngay là mất chunk của phiên upload đang dở. `STAGING_ROOT` đã sẵn sàng, bật khi dọn xong `videos/*.part.*` |
| `config.assertRequired()` gây thoát tiến trình | Node đang chạy với `config.env` cũ không được chết vì lần deploy này. Hiện chỉ log `error`; `CONFIG_STRICT=on` để chọn fail-fast |
| `authService` đọc env mỗi segment | File chất lượng cao nhất repo; đổi nó phải đi kèm đo hiệu năng, để Phase 1 |
| 206 → 200 cho phụ đề | 206 không kèm `Content-Range` là sai chuẩn, nhưng đổi là đổi hành vi với player đang chạy |
| Envelope cho route v1 | Central vẫn fallback v1; đổi hình dạng response v1 là rủi ro không cần thiết |
| Tách `media/`, queue encode, callback `stream-encode-v1` | Phase 1 |

### 12.5 Cách đọc kết quả

```bash
curl -s localhost:9100/api/default/legacy-usage
```

```bash
pm2 logs server --raw | grep '"event":"legacy.route.hit"'
```

## 13. [UPDATED 2026-08-16b] Phase 1 — đã implement

### 13.1 File mới

| File | Vai trò |
|---|---|
| `platform/errors.js` | Catalogue mã lỗi — nơi duy nhất sinh mã mới |
| `presenters/v2Presenter.js` | Nơi duy nhất biết hình dạng envelope (theo `backend/presenters/` của Central) |
| `media/dashCommand.js` | Hàm dựng lệnh FFmpeg, tách **nguyên văn** khỏi `encodeAPI.js` bằng script |
| `media/encodeRunner.js` | spawn + timeout + vòng đệm 50 dòng stderr cuối |
| `media/encodeQueue.js` | Giới hạn concurrency (~40 dòng, thay `p-queue` vốn ESM-only) |
| `media/probe.js` | ffprobe có await và có timeout |
| `clients/centralClient.js` | Cửa duy nhất gọi ngược Central; status là dữ liệu, không phải exception |
| `services/encodeJobService.js` | Vòng đời job + `.job.json` + callback + `reconcile()` lúc boot |
| `services/playbackBlockService.js` | Công tắc chặn phát, bền qua restart |
| `controllers/playbackBlockController.js` + `routes/v2/playbackRoute.js` | API quản trị chặn |
| `middleware/dataPlaneGuard.js` | Node từ chối phục vụ media |
| `tests/phase1.test.js` | 18 test |

### 13.2 Ba lỗi thật phát hiện khi implement

**(1) `requestId` mất qua multer — nghiêm trọng nhất.**
`AsyncLocalStorage` bám theo async context của nơi **tạo ra** tài nguyên, không theo thứ tự
middleware. `req` do Node tạo trước khi `requestTrace` mở context; multer đọc body bằng stream
event trên chính `req` đó. Đo được `before multer: trace-123` / `after multer: null`. Nghĩa là
`upload.chunk.accepted` và `replication.file.received` — hai mốc quan trọng nhất — **chưa từng**
có `requestId` kể từ khi tính năng trace ra đời 2026-08-15, dù contract §5b khẳng định ngược lại.
Đã vá bằng `requestTrace.resume`, có test hồi quy, **đã xác minh test fail khi gỡ bản vá**.

**(2) Khẳng định "`ENCODE_TYPE` sai → lệnh rỗng" của bản draft đầu là sai.** `case 8` dùng chung
`default:` — xem `[SUPERSEDED]` ở mục 12.2.

**(3) `heartbeatLoop` giữ tiến trình sống mãi.** Timer chờ giữa hai nhịp không `unref()`, nên
`node --test` treo sau khi test xong và bất kỳ script nào lỡ require `app.js` cũng treo. Đã
`unref()`.

### 13.3 Thay đổi hành vi (khác Phase 0 — lần này có, và có chủ đích)

| Thay đổi | Trước | Sau |
|---|---|---|
| Node phục vụ media | serve `.m4s`/`.mpd`/`.vtt`/`.png` | **410 Gone**; van xả `MEDIA_SERVING=on` |
| Encode | fire-and-forget, không giới hạn | hàng đợi `ENCODE_CONCURRENCY` (mặc định 1) |
| Kết thúc encode | không ai biết | `.job.json` + callback `stream-encode-v1` |
| Xoá file nguồn | vô điều kiện trong `close` | **chỉ khi thành công** → chạy lại được |
| Chặn phát | RAM, mất khi restart, chỉ khi `AUTH_MODE=enforce` | bền qua restart, **chặn thật ở mọi mode** |
| `stop-streaming` v1 | chỉ ghi RAM | ghi cả block list bền vững |
| nginx access log | tắt / để ở phần tuỳ chọn | **bật sẵn**, có `auth=`/`sess=`/`rid=`, `buffer=64k flush=5s` |

### 13.4 Vì sao "chặn được bất cứ lúc nào" cần cả ba mảnh

Ba thứ này chỉ có nghĩa khi đi cùng nhau:

1. **Node không phục vụ media** → chỉ còn đúng một đường vào, và đường đó qua nginx.
2. **nginx `auth_request` hỏi Node mỗi file** → Node là bên quyết định, theo thời gian thực.
3. **Block list độc lập `AUTH_MODE`, bền qua restart** → lệnh chặn có hiệu lực ngay và không bốc
   hơi sau lần deploy kế tiếp.

Thiếu (1) thì (2) và (3) chỉ là trang trí: vẫn còn cửa Node. Thiếu (3) thì phải bật `enforce`
cho toàn hệ thống chỉ để chặn một phiên. Thiếu log ở nginx thì không có cách nào kiểm chứng lệnh
chặn đã có hiệu lực chưa.

### 13.5 Còn lại cho Phase 2

`nodeAuth` HMAC · `heartbeat-v2` + inventory theo hash · tách `stagingRoot` khỏi `videos/` ·
`authService` đọc env mỗi segment · bỏ `shell: true` khỏi encode · 206 → 200 cho phụ đề ·
`config.assertRequired()` thoát tiến trình.

## 14. [UPDATED 2026-08-16c] Phase 2 — đã implement

### 14.1 Xác thực node-to-node — và vì sao phải có HAI loại chữ ký

Đây là điểm thiết kế dễ làm sai nhất của cả Phase 2.

| Ai gọi | Giữ được bí mật? | Cơ chế |
|---|---|---|
| Central → Sub, Sub → Sub | Có | Ký **từng request** + timestamp chống phát lại |
| **FE → Sub (chunk upload)** | **Không — là trình duyệt** | Central **ký sẵn** danh tính phiên upload, FE chuyển tiếp như token mờ |

Nhánh thứ hai bắt buộc phải tồn tại vì contract v2 §3: **chunk đi thẳng từ FE tới Sub, không qua
Central**. Sub không thể hỏi lại Central cho từng chunk, mà cũng không thể bắt trình duyệt giữ
khoá — nhét khoá vào JS là công khai khoá.

Chữ ký upload session ràng buộc `uploadId`, `storageKey`, `extension`, **`chunkCount`**, `videoId`
và hạn dùng. `chunkCount` nằm trong đó là có chủ đích: sửa được nó là **điều khiển được thời điểm
Sub coi là "đủ chunk"**, tức ép Sub ghép file dở dang rồi đem đi encode.

Hai bản `nodeAuth` (Sub `platform/`, Central `backend/utils/`) là **bản sao có chủ đích**, kèm
test đối chiếu (`tests/nodeAuth.test.js`) chạy cả hai chiều: Central ký → Sub verify, và Sub ký →
Central verify. Không có test đó, lệch một dấu `\n` trong chuỗi canonical sẽ cho triệu chứng duy
nhất là "401 hết" trên production.

Không ký body: body là file hàng chục MiB, băm lại là nhân đôi I/O trên đúng đường nóng nhất.

Rollout `off → log → enforce`, đọc `GET /api/default/node-auth` tới khi `wouldDeny = 0`.

### 14.2 Heartbeat v2

Central đã có `/api/v2/heartbeat/receive` và toàn bộ logic liveness nhiều mức từ trước; chỉ thiếu
việc Sub gửi đúng hình dạng. Payload cũ khiến `nodeId` bị **suy ra** thành
`legacy:<baseURL>:<serverIndex>` và — theo chính `contracts/heartbeat-v2.md` — node chạy tốt vẫn
**ở lại `suspect` mãi mãi**.

Ba thứ mới, đều là field Central đã hỗ trợ nhưng chưa ai gửi:

- **`inventory` theo hash** — `videos` chỉ đi kèm khi checksum đổi. Bản cũ tính hash rồi vẫn gửi
  cả danh sách mỗi 10 giây. `storeAPI.recordHeartbeat` giữ `previous.videosInfo` khi thiếu mảng,
  nên bỏ đi là an toàn và còn làm `inventoryChanged` chính xác hơn.
- **`bootId` + `sequence`** — phân biệt ba tình huống mà "heartbeat vẫn về" nhìn giống hệt nhau:
  bootId đổi liên tục = crash-loop; sequence nhảy cóc = heartbeat rớt; bootId cũ + sequence tăng =
  node khoẻ.
- **`health.encodeQueue`** — độ sâu hàng đợi. Một node có 8 job đang chờ không nên nhận thêm
  upload, dù nó vẫn `alive`.

Có fallback v1 khi Central trả 404/405, và **chỉ hạ cấp khi Central thật sự trả lời** — lỗi
transport đem đi thử v1 chỉ hỏng thêm một lần và làm mờ nguyên nhân gốc.

### 14.3 Tách `stagingRoot` khỏi thư mục nginx serve

`videos/` là `root` của nginx `:9150`. `.part.N`, `.accepted.json`, `.job.json` nằm trong đó là bề
mặt không cần thiết, và mọi thao tác liệt kê/backup phải lọc tay. Nay ở `var/incoming/`.

`migrateLegacyStaging()` chạy lúc boot, **trước `reconcile()`**. Không có nó, lần deploy này sẽ
làm mọi phiên upload đang dở dang mất sạch chunk đã nhận: Sub tìm `.part.N` ở chỗ mới, không thấy,
coi như chưa nhận gì — FE gửi nốt chunk cuối rồi nhận 202 "chưa đủ" mãi mãi. Migration chỉ đụng
ba mẫu tên đã biết, có nhánh copy dự phòng cho `EXDEV` (hai thư mục khác filesystem), và không bao
giờ throw.

### 14.4 Hai mục nhỏ

- **`authService` thôi đọc `process.env` mỗi segment.** Trong Node, đọc `process.env` là một lời
  gọi xuống môi trường tiến trình chứ không phải đọc object thường; cộng ba phép biến đổi chuỗi,
  nhân ~1800 lần mỗi phiên xem. Nay cache theo giá trị thô — an toàn vì `AUTH_MODE` được đổi bằng
  `pm2 restart --update-env`, tức tiến trình mới.
- **`CONFIG_STRICT` mặc định `on`.** Phase 0 chỉ ghi log vì node đang chạy có thể mang `config.env`
  cũ. Sau hai vòng deploy, nhánh "chạy tiếp với cấu hình sai" chỉ còn là cách để lỗi nằm im tới
  lúc có người dùng thật.

### 14.5 Endpoint mới ở Central

`POST /api/v2/nodes/jobs/result` (contract `stream-encode-v1`) — trả lời câu hỏi còn treo từ
Phase 1. Idempotent theo `jobId`, ghi `VideoStatus.status`/`videoDuration`/`encodeDuration` và
`Video.status`, log `ENCODE DONE`/`ENCODE FAILED` kèm `encodeRatio`.

**`applied: false` vẫn trả 200.** Ví dụ video bị xoá trong lúc node encode 30 phút: việc giao tin
đã thành công, dữ liệu chỉ là không dùng được. Trả 5xx sẽ khiến Sub retry vô hạn cho một thứ không
bao giờ đúng lên được.

Đây cũng là việc **khôi phục**, không phải tính năng mới: code Sub đời đầu tự ghi thẳng ba field
đó vào MongoDB, và khi Sub bị gỡ khỏi DB (2026-07) đoạn ấy bị comment lại mà **không có gì thay
thế**.

### 14.6 Còn lại

Bỏ `shell: true` khỏi encode · 206 → 200 cho phụ đề · envelope cho route v1 · Phase 3 (đọc counter
rồi dọn `legacy/`).

## 15. [UPDATED 2026-08-16d] Phase 3 — đã implement

### 15.1 Điều phải nói trước: counter CHƯA có dữ liệu

Điều kiện xoá mà chính tài liệu này đặt ra (mục 8.2) là **`legacy.route.hit` = 0 trong 30 ngày**.
Counter mới được thêm ngày 2026-08-16 cùng Phase 0. **Không có 30 ngày dữ liệu nào.**

Vì vậy Phase 3 **không** xoá route nào dựa trên counter. Mọi thứ được gỡ đều dựa trên **bằng
chứng tĩnh** — `grep` cho ra 0 lời gọi `require` — là loại bằng chứng mạnh hơn và có ngay.

### 15.2 Đã gỡ, kèm bằng chứng

| Thành phần | Bằng chứng |
|---|---|
| 4 × `rtmpType*Controller.js` (**67 KB**) | `grep -rn "rtmpType"` ngoài chính chúng: 0 kết quả |
| `models/mongo/*` (6 file) | chỉ `notificationFactory` require, mà nó cũng không ai require |
| `utils/notificationFactory.js`, `modules/redisAPI.js`, `config/database/db_index.js` | 0 kết quả |
| **15 dependency** trong `package.json` | 0 lời gọi `require` trong toàn cây nguồn, kể cả `legacy/` |

Trong đó `mongoose` + `bcryptjs` chỉ còn `legacy/` dùng — gỡ chúng khỏi `dependencies` là nói
đúng sự thật: **node đang chạy không cần DB driver**, đúng như contract v2 §1 tuyên bố từ 2026-07
nhưng cây nguồn vẫn nói ngược lại suốt từ đó. Và `stream-sub-server: "file:"` là gói **tự phụ
thuộc chính nó**.

Tất cả `git mv` vào `legacy/` chứ không xoá — xem [`legacy/README.md`](../legacy/README.md).

### 15.3 Bỏ `shell: true` — và cách kiểm chứng

`spawn(cmd, [], { shell: true })` đưa cả chuỗi cho cmd.exe/sh diễn giải. An toàn hiện tại dựa vào
việc `storageKey` đã bị regex lọc ở middleware — một bảo đảm nằm ở **tầng khác**.

**Vấn đề**: viết lại 650 dòng cờ FFmpeg thành mảng argv là chép tay hàng trăm tham số đã được
kiểm chứng trên dữ liệu thật. Rủi ro cao, lợi ích bằng không.

**Cách làm**: giữ nguyên builder làm nguồn sự thật duy nhất, thêm `tokenize()` tách chuỗi thành
argv theo đúng luật shell sẽ dùng. Tokenizer này **đủ** chứ không phải shell thu nhỏ nửa vời, vì
chuỗi do chính `buildParts()` sinh ra và chỉ dùng một cơ chế quoting là nháy kép — không nháy
đơn, không escape, không glob, không biến môi trường.

Trường hợp tinh tế nhất, cũng là lý do cách này đúng:

```
init_"$"RepresentationID"$".m4s   ->   init_$RepresentationID$.m4s
```

Nháy giữa token là để shell không nuốt `$`; bỏ nháy khi tokenize cho ra đúng chuỗi FFmpeg cần.

**Kiểm chứng bằng encode thật**, không phải bằng lập luận — clip 12 giây, cùng `ENCODE_TYPE=7`:

```
ca hai OK        : true
so file          : 19 vs 19
danh sach giong  : true
manifest giong   : true
segment 0 bytes  : 162029 vs 162029
```

Byte-identical. Đây là đổi **cách gọi**, không đổi kết quả.

Lợi ích phụ đáng kể: `runPlan()` biết **bước nào** hỏng (`thumbnail.png` / `thumb.webp` / `dash`)
và ghi vào `.job.json`. Bản shell gộp cả ba vào một exit code, nên một node thiếu libwebp trông y
hệt một node encode hỏng. Luật "bước tuỳ chọn được phép thất bại" nay viết bằng JavaScript thay vì
dựa vào việc `echo` luôn trả 0 và vào việc cmd.exe với /bin/sh hiểu `||` giống nhau.

### 15.4 206 → 200 cho phụ đề

Phase 1 giữ 206 vì "đổi là đổi hành vi với player đang chạy". Lập luận đó **đã hết hiệu lực**: từ
Phase 1, `dataPlaneGuard` trả 410 cho cả `*.vtt`, nên không còn player nào đi qua ba handler này —
muốn tới được phải bật tường minh `MEDIA_SERVING=on`.

206 ở đây vốn sai: RFC 9110 §15.3.7 quy định 206 **bắt buộc** kèm `Content-Range` và chỉ dùng khi
client gửi `Range`. Không có cái nào — đây là phản hồi toàn bộ file.

### 15.5 Bề mặt legacy bị bỏ sót ở Phase 0

`/api/test` **không** nằm trong danh sách `legacyRoutes` của Phase 0. Đây lại là bề mặt lớn nhất
còn mở: `controllers/testController.js` (22 KB) có route upload file, chạy FFmpeg tuỳ ý và stream
file theo tên do client đưa vào — **không kiểm tra gì**. Đã thêm counter.

### 15.6 Đính chính

> **[SUPERSEDED]** Mục 8.3 viết *"`encodeIntoDash`, `Ver2`, `Ver3`, `_test` — chỉ `Ver4` được gọi"*.
>
> **[UPDATED 2026-08-16d]** Đúng với đường v2, **sai** với đường v1:
> `encodeIntoDash` được `replicateController.js:393` gọi, `encodeIntoDash_test` được
> `uploadController.js:103` gọi. Chỉ `Ver2` và `Ver3` là thật sự không ai gọi, nhưng chúng nằm
> cùng file với hai hàm còn sống nên chưa tách ra được.

### 15.7 Còn lại

Envelope cho route v1 · đóng `/api/test` · gỡ `replicateController`/`testController` sau khi đọc
đủ 30 ngày counter · gỡ `hls-server`/`node-media-server` (còn `require` ở `server.js` sau cờ
`VER === undefined`).

## References

- RFC 9110 — HTTP Semantics (mã trạng thái 404 vs 5xx, 201 vs 200): https://www.rfc-editor.org/rfc/rfc9110.html
- nginx `ngx_http_auth_request_module`: https://nginx.org/en/docs/http/ngx_http_auth_request_module.html
- Node.js `child_process.spawn` — ghi chú bảo mật khi `shell: true`: https://nodejs.org/api/child_process.html#child_processspawncommand-args-options
- Node.js `AsyncLocalStorage`: https://nodejs.org/api/async_context.html
- FFmpeg DASH muxer: https://ffmpeg.org/ffmpeg-formats.html#dash-2
- `p-queue` (giới hạn concurrency, đã chốt trong kiến trúc dự án): https://github.com/sindresorhus/p-queue
- Tài liệu nội bộ: [`upload-replication-contract-v2.md`](upload-replication-contract-v2.md),
  [`ott-playback-token-auth.md`](ott-playback-token-auth.md),
  [`current-implementation-audit-2026-07.md`](current-implementation-audit-2026-07.md),
  [`central-node-architecture-comparison.md`](central-node-architecture-comparison.md),
  [`deployment-hidden-bugs-and-pitfalls.md`](deployment-hidden-bugs-and-pitfalls.md),
  [`encode_explain.md`](encode_explain.md)

*(Truy cập 2026-08-16.)*

---

## Changelog

- **2026-08-16e** — Implement **Phase 3** (mục 15): gỡ 67 KB RTMP controller + toàn bộ model Mongo
  + 15 dependency (tất cả theo bằng chứng `grep` = 0 require, KHÔNG theo counter — counter chưa có
  30 ngày dữ liệu); bỏ `shell: true` khỏi encode bằng cách tokenize chuỗi của builder đã kiểm
  chứng, **verify bằng encode thật cho output byte-identical**; 206 → 200 cho phụ đề; thêm counter
  cho `/api/test` (bề mặt legacy bị bỏ sót ở Phase 0). Đính chính khẳng định sai ở mục 8.3 về
  `encodeIntoDash`. 72/72 test.

- **2026-08-16d** — Implement **Phase 2** (mục 14): xác thực node-to-node bằng HMAC với HAI loại
  chữ ký (per-request cho node, upload-session token cho FE) và test đối chiếu hai repo;
  `stream-heartbeat-v2` với inventory theo hash, `bootId`/`sequence`, độ sâu hàng đợi encode, có
  fallback v1; tách `stagingRoot` khỏi thư mục nginx serve kèm migration lúc boot; `authService`
  thôi đọc `process.env` mỗi segment; `CONFIG_STRICT` mặc định `on`. Bên Central: implement
  `POST /api/v2/nodes/jobs/result` (`stream-encode-v1`) — trả lời câu hỏi còn treo từ Phase 1.
  69/69 test Sub + 129/129 test Central.

- **2026-08-16c** — Implement **Phase 1** (mục 13): presenter + catalogue mã lỗi; tách `media/`
  thành dashCommand/runner/queue/probe; `encodeJobService` với `.job.json`, hàng đợi và callback
  `stream-encode-v1`; `centralClient`; **Node ngừng phục vụ media (410)**; **công tắc chặn phát**
  bền qua restart và độc lập `AUTH_MODE`; nginx access log bật sẵn có `auth=`/`sess=`/`rid=`.
  Phát hiện và vá 3 lỗi thật, trong đó `requestId` mất qua multer là lỗi làm sai một khẳng định
  đã ghi trong contract v2 §5b. 56/56 test xanh.

- **2026-08-16b** — Implement **Phase 0** (mục 12). Thêm `platform/log.js`, `platform/config.js`,
  `storage/paths.js`, `middleware/legacyProbe.js`, `tests/platform.test.js`; `utils/operationLog.js`
  thành shim; `AppError` nhận `apiCode` và `errorController` dùng đúng bảng mã của Central; sửa 12
  lỗi rời (heartbeat gate ngược, hai schema heartbeat, `ReferenceError`, 500→404 phụ đề, URL
  Central hardcode, `JITTER` chuỗi, `readdir` hai lần, biến toàn cục rò rỉ, `Number('')`, test
  script bỏ sót file, regex token 3 bản sao, mã lỗi về Central luôn generic). 38/38 test xanh.
  Bổ sung đối chiếu với `Stream-Central-Server/backend` — Central đã có sẵn `logger`/`appError`/
  `presenters`/`nodeClient`, nên Phase 0 là ĐỒNG BỘ VỀ khuôn đó, không phát minh khuôn mới.

- **2026-08-16** — Tạo bản phác thảo. Kiểm kê AS-IS theo source code (đặt tên, logging, envelope,
  đường dẫn, encode, giao tiếp Central↔Sub) kèm `file:line`; đề xuất bảng thuật ngữ bắt buộc,
  kiến trúc tách tầng, chuẩn envelope + catalogue mã lỗi, chuẩn logging có level và luật cấm log
  trên data plane, chuẩn đường dẫn có `assertInside`, tách encode thành builder/runner/queue,
  contract mới `stream-encode-v1` (callback kết quả encode) và `stream-heartbeat-v2`, xác thực
  HMAC giữa node, chính sách legacy dựa trên counter, lộ trình 4 phase và bảng rủi ro.
  **Chưa implement — không sửa code.**
