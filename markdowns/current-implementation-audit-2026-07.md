# Stream-Central / Stream-Sub — Current Implementation Audit

> [UPDATED 2026-07-19] Tài liệu này là ảnh chụp **AS-IS theo code**, dùng để phân biệt
> implementation hiện tại với kiến trúc **TARGET** đã chốt trong
> `central-node-architecture-comparison.md` và `node-central-backlog-and-decisions.md`.
>
> Không suy trạng thái triển khai từ tên file, comment, tài liệu cũ hoặc dependency còn sót.
> Một tính năng chỉ được coi là implemented khi entrypoint/route đang dùng thật sự gọi tới nó.

## 1. Phạm vi và snapshot

| Repo | Branch / commit được đọc | Ghi chú |
|---|---|---|
| Stream-Central-Server | `tue-alpha` / `bae83c5` (2026-07-12) | Có working-tree thay đổi ở redirect/player; audit tính cả phần đang hiện diện trong working tree ngày 2026-07-19. |
| Stream-Sub-Server | `alpha` / `0427d60` (2026-07-17) | Commit mới nhất chỉnh encode path theo OS; `scripts` đang modified nhưng không dùng để kết luận kiến trúc. |
| Stream-Documents | `main` / `3abdf63` (2026-07-11) | Là kho tài liệu chuẩn để hợp nhất kiến thức; một số file đang có thay đổi của người dùng và được giữ nguyên. |

Phương pháp: static inspection của `package.json`, entrypoint, route, controller, model,
module và nginx config. **Không chạy server, test, FFmpeg, nginx hoặc deploy.** Vì vậy các mục
“chạy được ngoài thực tế” vẫn cần integration test riêng.

## 2. Kết luận nhanh: AS-IS khác TARGET ở đâu

| Chủ đề | AS-IS trong code 2026-07-19 | TARGET đã chốt | Trạng thái |
|---|---|---|---|
| Redis / BullMQ | Không có dependency Redis/BullMQ đang hoạt động. Central `redisAPI.js` rỗng; sub có module Redis lỗi/thừa nhưng không được import và package không cài `redis`. | Không Redis, không BullMQ. | **Đạt về runtime**, còn dead code ở sub. |
| MongoDB ở central | Central dùng Mongoose và gọi `mongoose.connect()` khi boot. URI đang chọn là local `STREAMING_DB`; Atlas path bị comment. | MongoDB là persistent source of truth duy nhất. | **Có Mongo**, nhưng cấu hình chưa đúng mô tả “Atlas” trong docs cũ. |
| MongoDB ở sub | Cả `server.js` và `server_pro.js` vẫn gọi `dbVideoSharing.connect()`; `mongoose` vẫn là dependency; route replicate V2 đọc `Video`/`Server` trực tiếp. | Sub-node không có DB và không chạm MongoDB. | **Chưa lược bỏ khỏi code**. Đây là gap lớn nhất giữa design và implementation. |
| `p-queue` | Không có trong package/import của sub. FFmpeg được `spawn()` trực tiếp. | Queue local in-process, giới hạn concurrency theo node/GPU. | **Chưa implemented**. |
| Heartbeat | Sub có recursive loop ~10s + jitter và timeout 5s, nhưng chỉ auto-start khi `NODE_ENV === 'development'`. Payload mới gồm inventory DASH; central lưu vào `Map` in-memory. | Production heartbeat authoritative; central stamp `receivedAt`, persist/reconcile qua MongoDB; có health/jobs/inventory. | **Prototype một phần**, chưa production/persistent/job-aware. |
| Encode job | Upload ghép file rồi gọi `encodeIntoDashVer4()` không `await`; API trả 201 sớm, nhưng không có `jobId`, queue, persistent state hay callback completion. | `202 Accepted` + `jobId` + state machine + heartbeat/reconcile. | **Async kiểu fire-and-forget**, chưa phải job protocol đáng tin cậy. |
| Replication | Source node loop tuần tự từng file và chờ từng HTTP response; central V2 chờ request với timeout 15s rồi cập nhật placement/count. Sub V2 còn lookup MongoDB. | Node↔node, ack 202 nhanh, checksum/range/resume/idempotency, state tại central. | **Node↔node đã có**, orchestration/reliability chưa đạt. |
| Delete | Sub trả success cả khi file/folder không tồn tại, nhưng dùng sync FS và response 201. Central vẫn sửa MongoDB placement kể cả request node thất bại. | Idempotent sync command; chỉ commit state theo kết quả/reconcile; retry an toàn. | **Idempotent bề mặt**, nhưng transaction/order và reconcile chưa an toàn. |
| Segment data path | Frontend nhận URL direct/nginx; DASH segment có thể đi thẳng node/nginx. | Central chỉ control plane, không nằm trên media byte path. | **Đạt ở luồng DASH mới**, còn nhiều legacy handler/proxy tại central/sub. |
| nginx static delivery | Sub có `streamingVer2`/`nginx.conf` port 9150 dùng `sendfile`; frontend ưu tiên `subservernginxurl`. | nginx serve manifest/segment, Node chỉ auth/control nhẹ. | **Có config + URL path**, nhưng config auth hiện chưa hoàn chỉnh và fail-open. |
| Universal player | `DashVideoPlayer` được tái dùng ở PlayerHub và VideoPageVer6, có dash.js + SubtitlesOctopus; nhiều `VideoPageVer1..6`, HLS/DASH/demo vẫn còn. | Một universal player component/adapters. | **Đang hội tụ**, chưa hoàn tất. |

## 3. Central backend — implementation hiện tại

### 3.1 Boot, database và ownership của state

- `backend/server.js` luôn gọi `dbVideoSharing.connect()` trước khi listen.
- `backend/config/database/db_index.js` hiện connect tới Mongo local
  `mongodb://127.0.0.1:27017/STREAMING_DB`; code Atlas chỉ là comment.
- `backend/package.json` có Mongoose 7 và **không có** Redis/BullMQ.
- `Video`, `Server`, `VideoStatus` vẫn là các model authoritative cho metadata/placement
  trong phần lớn dashboard, redirect, replicate và delete.
- Heartbeat không ghi các model này. `heartbeatController` upsert snapshot vào singleton
  `Map` của `modules/storeAPI.js`; restart central sẽ mất toàn bộ heartbeat state.

**Kết quả:** câu “MongoDB là source of truth duy nhất” mới đúng với metadata cũ, chưa đúng với
liveness/inventory runtime. `Map` là cache volatile và hiện chưa có hydrate/reconcile từ Mongo.

### 3.2 Playback handoff

Luồng DASH mới thực tế:

1. Frontend gọi `/redirect/dash-token/:videoname` với header nhận JSON.
2. Central query `Video`, lấy danh sách `Server` có video, sau đó chọn phần tử `index = 0`.
3. Central trả cả:
   - `subserverurl`: Node route `/dash-token/<JWT>.mpd`;
   - `subservernginxurl`: URL nginx `/videos/<videoname>/init.mpd`;
   - `subtitle_path`: subtitle từ Node.
4. PlayerHub ưu tiên nginx URL, fallback direct Node URL.

Điểm đúng by-design: sau handoff, manifest/segment không cần đi xuyên central. Điểm chưa đạt:
server selection trong route này vẫn là “server đầu tiên”, token TTL còn 90 ngày và nginx URL
đang đi qua nhánh fail-open nên chưa thể gọi là access control production.

### 3.3 Replicate và delete

- Replicate V2: central POST tới source node `/api/v1/replicate/send-folder-v2`, chờ tối đa
  15 giây. Source node đọc `videoId/serverId` từ MongoDB riêng của sub, rồi gửi từng file trực
  tiếp tới destination node. Đây là data path node↔node, nhưng còn phụ thuộc DB ở node.
- Sau call, central thêm placement và tăng `numberOfReplicant`; không có `jobId`, checksum,
  resume hoặc reconciliation để chứng minh destination đã đủ bộ file.
- Delete: central gọi node trước, nhưng sau `catch` vẫn tiếp tục splice placement và giảm replica
  count trong Mongo. Nếu node unreachable, DB có thể nói “đã xóa” trong khi file vẫn tồn tại.

**Hệ quả:** control-plane metadata có thể drift khỏi inventory thật. Heartbeat inventory phải trở
thành backstop và central chỉ commit transition sau outcome hợp lệ hoặc reconcile.

### 3.4 Central chưa phải control-plane thuần

`backend/app.js` và controller vẫn chứa các đường legacy: subtitle handlers, proxy hook,
upload helpers, FFmpeg/video processing và integration cloud storage. Chúng có thể cần giữ để
backward compatibility, nhưng tài liệu phải gọi đúng là **hybrid legacy + control-plane đang
được tách dần**, không mô tả như central thuần đã hoàn tất.

## 4. Sub-node — implementation hiện tại

### 4.1 MongoDB chưa được bỏ khỏi code

Bằng chứng trực tiếp:

- `package.json` vẫn có `mongoose` 8.x.
- `server.js` và `server_pro.js` đều import `config/database/db_index` rồi gọi `connect()`.
- `db_index.js` connect bằng biến môi trường database.
- `replicateController.sendVideoForReplicationV2()` import và query `Video` + `Server`.
- Các model Mongo vẫn tồn tại; riêng `VideoStatus.js` đã bị comment toàn bộ, và update
  `VideoStatus` trong encode cũng bị comment.

Vì vậy câu đúng là: **quyết định kiến trúc đã bỏ MongoDB khỏi sub, nhưng migration code chưa
hoàn tất**. Không được ghi “sub không có DB” như implementation fact cho tới khi entrypoint,
dependency và route V2 được sửa.

### 4.2 Heartbeat prototype

Điểm đã làm đúng:

- recursive loop: gửi xong mới sleep, tránh request chồng như `setInterval`;
- interval cơ sở 10 giây, có jitter;
- axios timeout 5 giây;
- failure best-effort, vòng sau tự retry;
- inventory scan folder DASH và hash bằng `object-hash`.

Khoảng trống cần ghi rõ:

- auto loop chỉ chạy trong `development`; env deploy gần đây dùng giá trị khác nên production
  không tự heartbeat;
- identity dùng `CENTRAL_API + SERVERINDEX`, không phải stable node ID/public node URL;
- `serverStatus` đang rỗng; chưa có bootId/seq/capability/queue/disk/GPU/jobs;
- full directory scan + sync reads mỗi 10 giây có thể nặng khi inventory lớn;
- manual route `/heartbeat` gọi `sendHeartbeat(heartbeatInfo)` không bọc `{payload: ...}` như
  central receiver yêu cầu;
- central nhận heartbeat chỉ lưu `videosInfo`/hash trong RAM.

### 4.3 Encode

- `receiveVideoFile()` ghép chunk đồng bộ rồi gọi `encodeIntoDashVer4()` không await.
- `encodeIntoDashVer4()` chạy command qua `spawn(..., {shell: true})`, tự xóa source khi process
  đóng và chỉ log duration/error.
- Không có `p-queue`, concurrency cap, `jobId`, persistent job state hoặc completion report.
- `VideoStatus` update đã comment, nên tài liệu cũ nói `encoding → ready` tại sub là **superseded**.
- Commit 2026-07-17 bổ sung encode type 7 (H.264 NVENC) và 8/default (libx264), dùng ladder
  360p/720p/1080p với scale+pad+setsar để thống nhất aspect ratio. Đây là code mới hơn các bản
  tóm tắt tháng 6.

**Kết quả:** response upload trả sớm nhưng không có semantics của một durable async job. Node
restart có thể làm mất toàn bộ knowledge về process đang chạy/dở.

### 4.4 Replication và file serving

- Replicate folder chạy tuần tự, gửi từng file bằng multipart. Không thấy checksum, Range/resume,
  temp name + atomic rename hoặc manifest completeness check.
- Check tồn tại dựa vào path/folder; một folder dở dang có thể bị hiểu nhầm là replica hoàn chỉnh.
- `server.js` vẫn gắn `hls-server` và Express file handlers, nên Node còn nằm trên data path cũ.
- nginx V2 port 9150 có `sendfile`, MIME cho HLS/DASH/CMAF/subtitle và frontend đã ưu tiên URL này.
- nginx `auth_request /__auth` đang tham chiếu location bị comment; `error_page` chuyển mọi
  401/403/5xx sang `@serve`. Do đó đây là **fail-open có chủ đích cho test**, không phải auth thật.

## 5. Frontend/player — implementation hiện tại

- Route mới `/v2/player/:serverId/:videoId` dùng `PlayerHubPageVer1` và `DashVideoPlayer`.
- `DashVideoPlayer` dùng dash.js, SubtitlesOctopus/libass-WASM, QoE statistics và runtime URL
  panel. Working tree hiện thêm autoplay fallback muted và hiển thị nginx/direct URL.
- `VideoPageVer6` cũng tái dùng component này, nhưng code vẫn giữ nhiều VideoPage/HLS/DASH/demo
  và ArtPlayer chưa phải shell chung cho toàn bộ route.
- Các route admin v2 được wrap bởi `AdminLayoutVer2`; nhiều legacy route vẫn public/không guard
  ở frontend. Backend route cũng không có một lớp auth thống nhất trên toàn bộ server/redirect API.

**Kết luận:** universal-player là migration đang diễn ra, không phải trạng thái hoàn tất.

## 6. Các tuyên bố tài liệu phải dùng từ nay

### Có thể nói như fact hiện tại

- Runtime không dùng Redis/BullMQ.
- Central dùng MongoDB/Mongoose cho metadata chính.
- DASH playback mới có thể handoff để client fetch trực tiếp từ sub/nginx.
- Replication payload đi trực tiếp node↔node, không trung chuyển video byte qua central.
- Sub có heartbeat/inventory prototype và nginx static-delivery config.
- Sub có CPU H.264 và NVIDIA NVENC encode variants trong code.

### Chỉ được nói là target/backlog

- “Sub-node không có MongoDB.”
- “MongoDB central là source of truth cho heartbeat/job state.”
- “Sub dùng p-queue.”
- “Encode/replicate dùng 202 + jobId + reconciliation.”
- “Heartbeat production authoritative.”
- “Delete/replication đã idempotent và retry-safe.”
- “nginx auth_request đang bảo vệ segment.”
- “Central là control plane thuần.”
- “Frontend đã gộp xong universal player.”

## 7. Thứ tự migration khuyến nghị

1. **Cắt Mongo khỏi sub thật sự:** central gửi đủ source/destination/video path trong command;
   xóa DB boot call, Mongoose dependency và route lookup Mongo ở node.
2. **Đóng job contract:** central tạo `jobId`, node ack 202, local queue giới hạn concurrency,
   heartbeat report job snapshot, central validate transition và reconcile timeout/restart.
3. **Persist heartbeat tại central:** stable node ID, central `receivedAt`, Mongo upsert nhẹ;
   inventory chỉ update khi hash đổi; liveness query theo threshold.
4. **Làm replicate crash-safe:** temp path, checksum/size, resume/range, atomic finalize và
   inventory xác nhận trước khi tăng replica count.
5. **Sửa delete ordering:** chỉ đổi placement theo outcome; nếu response không chắc chắn thì
   mark pending và reconcile, không tự coi là thành công.
6. **Chốt nginx access policy:** implement `/__auth`, bỏ fail-open khi hardening, tách rõ
   playback token với admin/control auth.
7. **Tiếp tục player consolidation:** adapter HLS/DASH, giữ libass cho ASS, rồi retire route
   legacy khi contract mới đã phủ hết use case.

## 8. Evidence map

### Central

- [`backend/server.js`](../../Stream-Central-Server/backend/server.js)
- [`backend/config/database/db_index.js`](../../Stream-Central-Server/backend/config/database/db_index.js)
- [`backend/app.js`](../../Stream-Central-Server/backend/app.js)
- [`backend/controllers/heartbeatController.js`](../../Stream-Central-Server/backend/controllers/heartbeatController.js)
- [`backend/modules/storeAPI.js`](../../Stream-Central-Server/backend/modules/storeAPI.js)
- [`backend/controllers/redirectController.js`](../../Stream-Central-Server/backend/controllers/redirectController.js)
- [`backend/modules/redirectAPI.js`](../../Stream-Central-Server/backend/modules/redirectAPI.js)
- [`frontend/src/pages/AppRouter.js`](../../Stream-Central-Server/frontend/src/pages/AppRouter.js)
- [`frontend/src/pages/PlayerHubPageVer1.jsx`](../../Stream-Central-Server/frontend/src/pages/PlayerHubPageVer1.jsx)
- [`frontend/src/components/videoCmp/DashVideoPlayer.jsx`](../../Stream-Central-Server/frontend/src/components/videoCmp/DashVideoPlayer.jsx)

### Sub

- [`package.json`](../../Stream-Sub-Server/package.json)
- [`server.js`](../../Stream-Sub-Server/server.js)
- [`server_pro.js`](../../Stream-Sub-Server/server_pro.js)
- [`config/database/db_index.js`](../../Stream-Sub-Server/config/database/db_index.js)
- [`app.js`](../../Stream-Sub-Server/app.js)
- [`modules/heartbeatAPI.js`](../../Stream-Sub-Server/modules/heartbeatAPI.js)
- [`controllers/uploadController.js`](../../Stream-Sub-Server/controllers/uploadController.js)
- [`controllers/replicateController.js`](../../Stream-Sub-Server/controllers/replicateController.js)
- [`controllers/deleteController.js`](../../Stream-Sub-Server/controllers/deleteController.js)
- [`modules/encodeAPI.js`](../../Stream-Sub-Server/modules/encodeAPI.js)
- [`nginx.conf`](../../Stream-Sub-Server/nginx.conf)
- [`streamingVer2`](../../Stream-Sub-Server/streamingVer2)

## Changelog

- **2026-07-19** — Tạo audit sau khi đối chiếu static code của ba repo. Tách AS-IS/TARGET;
  xác nhận runtime không Redis/BullMQ; phát hiện MongoDB ở sub chưa được lược bỏ khỏi entrypoint,
  dependency và replicate V2; ghi trạng thái thật của heartbeat, p-queue, encode, replicate,
  delete, nginx và universal player. Không chạy code/test/deploy.
