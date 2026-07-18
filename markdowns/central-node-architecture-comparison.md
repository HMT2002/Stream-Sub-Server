# Central–Node Architecture: Distributed vs Co-located Comparison

**Created:** June 2026
**Project:** Stream-Central-Server
**Topic:** So sánh mô hình deployment phân tán (HTTP + heartbeat) vs co-located (Redis/BullMQ chung), và các cải thiện giữ nguyên ràng buộc
**Related files:** `PROJECT_SUMMARY.md`, `NGINX_FFmpeg_DASH_Streaming.md`, `node-central-backlog-and-decisions.md` (backlog/TODO + nhật ký quyết định + pseudo-code thực thi)

---

## 1. Bối cảnh & ràng buộc thiết kế (đã chốt qua thảo luận)

- Node deploy **độc lập trên cloud bất kỳ** (AWS/Azure/GCP), có địa chỉ HTTP public.
- Node **tối giản**: chỉ Node.js + FFmpeg (+ NGINX), **không DB, không Redis, không BullMQ**.
- Central là control-plane: xử lý info, móc nối frontend → node. **Central có thể chết tạm thời** — stream đang chạy không được gãy.
- Encode chạy **tại node** (tránh central thành bottleneck CPU), quản bằng `p-queue` in-process.
- Source of truth: **MongoDB** (topology: nodes, video→nodes). ~~**Redis (central)**: liveness cache với TTL.~~
  > [SUPERSEDED 2026-06-20] **Bỏ Redis khỏi dự án** (kể cả ở central). Lý do + cơ chế thay thế: xem **§8**.
- Liveness: **node push heartbeat (HTTP POST ~10s)** → ~~central ghi Redis key `EX 30` → key tự hết hạn~~ → **central ghi `lastHeartbeatAt` vào MongoDB; node coi là chết khi `now - lastHeartbeatAt > ngưỡng`** (TTL index hoặc quét định kỳ). Không polling O(N). *(UPDATED 2026-06-20 — xem §8)*
- Heartbeat chở: `nodeId, diskFree, encodeSlots, encodeActive, videosChecksum` (lệch checksum mới gửi full list).
- Replicate/delete theo pattern **reconcile**: desired state (Mongo) vs actual state (heartbeat), retry idempotent.
- Data-plane: **NGINX serve segment** + `auth_request` gọi Node local để xác thực token / revocation set (tắt stream = chặn segment kế tiếp, trễ 1–2 segment là giới hạn by-design của HLS/DASH).
- Token auth ≠ DRM: hệ thống dùng signed-URL/token-authenticated access, không phải DRM (không mã hoá content, không license server).

## 2. Hai mô hình so sánh

**Mô hình A — Distributed:** node độc lập đa cloud, giao tiếp HTTP heartbeat + lệnh HTTP; Redis/Mongo chỉ ở central; encode tại node (`p-queue`).

**Mô hình B — Co-located:** node cùng server/network với central, kết nối thẳng Redis; node là **BullMQ worker** thật, central đẩy job vào queue, node pull.

## 3. Bảng so sánh Pros/Cons

| Tiêu chí | A — Distributed | B — Co-located (Redis/BullMQ chung) |
|---|---|---|
| Job semantics (retry, ack, stalled) | Tự xây qua reconcile loop — chi phí lớn nhất của A | BullMQ cho sẵn: retry+backoff, priority, stalled re-queue, events, bull-board |
| Liveness | Tự xây heartbeat + Redis TTL | Worker-detection có sẵn trong BullMQ |
| Độ trễ điều khiển | Internet liên cloud (trăm ms, rớt được, cần idempotency) | LAN (~ms) |
| Consistency | Eventual (trễ ≤ 1 chu kỳ heartbeat) | Gần tức thời (atomic trong Redis) |
| Cài đặt node | Tối giản: Node.js + FFmpeg + config URL central | Nặng: Redis client, BullMQ, credential, schema phải khớp version |
| Deploy độc lập đa cloud | **Có — ràng buộc gốc** | **Không** (expose Redis public là cấm kỵ; thực tế chỉ chạy cùng VPC) |
| Scale băng thông egress | Tăng theo số node, đặt node gần user được | Chung một network egress — trần cứng |
| Blast radius | Node chết = mất 1 node; central chết = stream vẫn sống | Server/Redis chết = chết cả cụm |
| Coupling | HTTP contract rõ ràng, version được | Redis schema = API ngầm, nâng cấp phải đồng bộ |
| Tài nguyên | Encode không tranh CPU với central | Encode + serve + orchestrate cùng máy |
| Observability | Khó hơn, phải gom qua heartbeat | Một chỗ, bull-board nhìn hết |
| Chi phí ẩn | Egress liên cloud khi replicate | Không có egress liên cloud |

**Kết luận:** B thắng về *cơ chế job*, A thắng về *topology*. Cơ chế xây lại được; topology thì không. → Giữ A, kéo điểm mạnh cơ chế của B vào.

## 4. Cải thiện cho mô hình A (giữ nguyên ràng buộc)

### 4.1 ~~BullMQ trong central — worker là dispatcher, không phải node~~

> [SUPERSEDED 2026-06-20] **Đã bỏ phương án BullMQ-trong-central.** BullMQ kéo theo Redis làm
> backing store → mâu thuẫn với quyết định bỏ Redis (§8). Thay bằng **job-state trong MongoDB**
> (collection `VideoStatus`: `encoding → transfering → ready`) + reconcile loop thủ công ở central.
> Mất "miễn phí" (retry/backoff/bull-board) nhưng đổi lại **zero dependency hạ tầng chia sẻ** —
> đúng ràng buộc node đa vendor. Nội dung cũ giữ nguyên bên dưới để tham chiếu.

- ~~BullMQ + worker process đều nằm **trong central**. Worker xử lý job = gọi HTTP xuống node + chờ xác nhận (callback/heartbeat).~~
- ~~Node vẫn không biết Redis tồn tại.~~
- ~~Được miễn phí: retry exponential backoff, job state machine, concurrency điều phối, **bull-board làm job dashboard**.~~
- Định nghĩa "job done" = video xuất hiện trong heartbeat actual của node. *(vẫn đúng — nay đối chiếu với `VideoStatus` trong Mongo)*
- Pattern: "queue ở orchestrator, execution ở agent" — *(vẫn đúng về tư tưởng; chỉ đổi store từ Redis/BullMQ → MongoDB)*.

### 4.2 bootId + seq trong heartbeat — phát hiện node restart âm thầm
- Vấn đề: node restart giữa job → heartbeat vẫn đập nhưng job/revocation set/encode map (in-memory) đã mất.
- Fix: heartbeat kèm `bootId` (random lúc process start) + `seq` tăng dần.
- Central thấy `bootId` đổi → (a) re-push revocation list, (b) đánh dấu job đang assign là stalled → BullMQ retry.

### 4.3 Replication: pull thay vì push, qua NGINX
- Central ra lệnh cho node **đích**: "fetch video X từ `http://nodeA:8080/videos/X/`".
- Node đích kéo segment qua NGINX static của nguồn: nhanh (sendfile), **resume bằng HTTP Range** (quan trọng liên cloud), idempotent tự nhiên.
- Data đi thẳng A→B, central chỉ ra lệnh (không trung chuyển byte).

### 4.4 Capability handshake
- Register/heartbeat kèm `{ version, features: [...] }` → central chỉ gửi lệnh node hiểu → rolling upgrade an toàn đa cloud.

### 4.5 Observability qua heartbeat
- Heartbeat đã chở metric → central expose endpoint tổng hợp (Prometheus-format sau này). Node không cài thêm agent.

### 4.6 Bảo mật để sẵn chỗ (chưa bật giai đoạn test)
- Header `X-Signature: HMAC(body, secret)` hai chiều cho heartbeat/lệnh. Không thêm dependency, đặt chỗ trong schema trước để khỏi đổi contract sau.

## 5. Tổng kết

`A + BullMQ-trong-central + bootId/lease + pull-replication` ≈ 80% điểm mạnh cơ chế của B, giữ 100% ràng buộc của A.

20% không lấy được (độ trễ LAN, consistency tức thời) là **trade-off by design** của phân tán đa cloud — tương tự HLS/DASH chấp nhận trễ segment để đổi lấy scale qua HTTP.

## 6. Tên gọi chính thức & tham khảo thực tế

### 6.1 Tên gọi của mô hình A (tổ hợp pattern chuẩn ngành)
- **Control plane / data plane separation** — gốc từ SDN, phổ cập bởi Kubernetes/Istio.
- **Hub-and-spoke / agent-based architecture** — agent chỉ cần outbound về hub (Datadog agent, GitLab Runner, GitHub Actions runner).
- **Lease** — heartbeat + TTL key tự hết hạn. Kubernetes dùng đúng cơ chế này (kubelet cập nhật Lease object; node coi là chết khi lease hết hạn).
- **Reconciliation loop / controller pattern** — desired state (DB) vs actual state (heartbeat), level-triggered. Trái tim của Kubernetes controllers.
- Gọi gọn: **"agent-based control plane with declarative reconciliation"** (kiến trúc Kubernetes/Borg/Nomad).

### 6.2 Mảng sử dụng thực tế
- **Mô hình B** thống trị background-job trong một app/VPC: Celery, Sidekiq, BullMQ (BullMQ sinh ra cho bài toán B, không phải bài toán liên cloud).
- **Mô hình A** thống trị hạ tầng phân tán địa lý: Kubernetes/Nomad/Borg, CI runners, IoT fleet, monitoring agents, **CDN & OTT delivery**.
- **OTT thực tế dùng cả hai**: encode farm thường B-trong-một-region (worker cùng VPC kéo job từ queue — AWS Elemental dạng này); delivery luôn là A (origin/edge phân tán + control plane riêng). Stream-Central-Server gộp encode vào node nên áp A cho cả hai — hợp ràng buộc (CPU riêng mỗi node).

### 6.3 Tham chiếu thực tế sát nhất: Netflix Open Connect
- **OCA (Open Connect Appliance)** = storage/serving node phân tán trong ISP toàn cầu ≈ node đa cloud của dự án.
- **Control plane trên AWS** ≈ central: quyết content placement + steering client tới OCA.
- **Content fill** do control plane chỉ đạo (off-peak) ≈ reconcile desired/actual placement.
- **Client lấy URL từ control plane rồi stream trực tiếp từ OCA — control plane không nằm trên đường đi video trong phiên xem** ≈ đúng triết lý "central tạm thời không cần thiết sau khi có info".
- OCA cũng dùng NGINX serve static — xác nhận quyết định NGINX data-plane.

### 6.4 Nguồn tham khảo
- Netflix Open Connect: https://openconnect.netflix.com + netflixtechblog.com (các bài về Open Connect / content steering)
- Kubernetes Architecture (heartbeat/Lease, nodes, controllers): https://kubernetes.io/docs/concepts/architecture/
- Google Borg paper: "Large-scale cluster management at Google with Borg" (EuroSys 2015)
- HashiCorp Nomad architecture (server–client agent, gọn hơn K8s): https://developer.hashicorp.com/nomad/docs/concepts/architecture
- NGINX auth_request module: https://nginx.org/en/docs/http/ngx_http_auth_request_module.html

## 7. TODO / cần kiểm chứng khi implement

- [x] ~~Đối chiếu API BullMQ worker + bull-board...~~ → **huỷ: bỏ BullMQ (xem §8).**
- [ ] Kiểm chứng cú pháp NGINX `auth_request` trên bản Windows đang dùng (nginx.org/en/docs/http/ngx_http_auth_request_module.html).
- [ ] Đo overhead heartbeat 10s với checksum khi node giữ >1000 video.
- [x] ~~Quyết định Redis cùng máy central hay tách riêng...~~ → **huỷ: bỏ Redis (xem §8).**
- [ ] Xác nhận `fluent-ffmpeg` progress: lấy duration bằng ffprobe trước, tự tính % (không tin `percent` mặc định).
- [ ] Thiết kế TTL/quét cho liveness trong MongoDB (TTL index trên `lastHeartbeatAt` vs cron quét) — thay cho Redis `EX`.

---

## 8. [UPDATED 2026-06-20] Quyết định chốt: BỎ Redis & BullMQ khỏi dự án

### 8.1 Quyết định
**Không dùng Redis, không dùng BullMQ** ở bất kỳ tầng nào (kể cả central). Hạ tầng chia sẻ duy
nhất là **MongoDB**. Mỗi node chỉ cần **Node.js + FFmpeg (+ NGINX)** — không client Redis, không worker queue.

### 8.2 Lý do (soi qua 3 lăng kính)
- **Network:** node deploy **độc lập trên server/ISP/vendor khác nhau** (AWS, Azure, GCP, VPS lẻ).
  Redis/BullMQ thiết kế cho **một VPC/LAN** — expose Redis ra public là cấm kỵ bảo mật, và độ trễ
  liên-cloud phá vỡ giả định atomic/low-latency của BullMQ. → Không khả thi cho topology đa vendor.
- **Software:** bỏ 2 dependency hạ tầng = node cài đặt tối giản, không lo version Redis/schema BullMQ
  lệch giữa các cloud; rolling upgrade dễ hơn. Trade-off: tự xây retry/reconcile (chấp nhận được).
- **Broadcast/Delivery:** khớp mẫu **Netflix Open Connect** (§6.3) — control plane không nằm trên
  đường đi của byte; OCA node chỉ cần serve. Không node CDN nào phụ thuộc Redis dùng chung.

### 8.3 Cái gì thay thế (đối chiếu code thực tế)
| Vai trò Redis/BullMQ trước đây | Thay bằng | Đã có trong code? |
|---|---|---|
| Liveness cache (Redis `EX`) | `lastHeartbeatAt` trong MongoDB + ngưỡng hết hạn (TTL index/quét) | Heartbeat: cần bổ sung |
| Job queue/state (BullMQ) | Collection **`VideoStatus`** (`encoding→transfering→ready`) + reconcile loop ở central. **Đường ghi: chỉ central ghi, node feed qua HTTP — xem §8.6** | ✅ `VideoStatus` đã có |
| Concurrency limit ở node | **`p-queue`** in-process mỗi node | Đề xuất (in-process) |
| Job dashboard (bull-board) | Tự build view đọc từ `VideoStatus` / heartbeat aggregate | Có `/server/dashboard` |
| Session revocation (từng nghĩ Redis) | **In-memory blacklist** mỗi node (`globals/blacklist.js`) | ✅ đã có (mất khi restart — xem `bootId` §4.2) |

> Lưu ý: `redisAPI.js` trong cả hai repo hiện **export `{}` rỗng / chưa dùng** → việc bỏ Redis
> **không phá code đang chạy**, chỉ là chốt chính thức không phát triển theo hướng đó.

### 8.4 Mô hình điều khiển đã chốt (central orchestration)
1. **Central = control plane thuần.** Nhận request frontend, chọn node phù hợp (speed/dung lượng
   qua `storageStrategiesAPI`/`redirectAPI`), **móc nối frontend ↔ node**, ghi topology vào Mongo.
2. **Upload + Encode chạy TẠI node** được chọn (FFmpeg local, `p-queue`), central không trung chuyển byte.
3. **Replicate giữa các node:** central **ra lệnh**, dữ liệu đi **thẳng node↔node** qua REST
   (`/api/v1/replicate/*`) + HTTP Range resume — central không nằm trên đường truyền byte.
4. **Delete:** central gửi lệnh tới **node được chọn**, node tự thực thi xoá (`/api/v1/delete[/folder]`).
5. **Playback độc lập sau handoff:** một khi central đã trả URL + token và móc frontend ↔ node,
   **client stream thẳng từ node — central có thể chết tạm thời mà phiên xem không gãy** (token-gated,
   validate tại node). Đây là điểm "central tạm thời không cần thiết" — trùng triết lý Open Connect (§6.3).

### 8.5 Hệ quả còn lại / cần làm
- Mất tiện ích "miễn phí" của BullMQ (retry/backoff/priority/stalled, bull-board) → **tự xây reconcile
  idempotent** + dùng `bootId`/`seq` (§4.2) để phát hiện node restart âm thầm.
- Liveness/job-state nay **eventual consistency qua Mongo** (trễ ≤ 1 chu kỳ heartbeat) — chấp nhận
  được, đúng bản chất phân tán đa cloud (§5).

> Nguồn/tham chiếu: Netflix Open Connect (§6.3, §6.4); pattern reconcile/lease Kubernetes (§6.1);
> code thực tế `VideoStatus`, `replicateController`, `deleteController`, `globals/blacklist.js`
> (xem `PROJECT_SUMMARY_CENTRAL.md` §7, `PROJECT_SUMMARY_SUB.md` §4–§10).

---

## 8.6 [UPDATED 2026-06-20] Cơ chế node báo trạng thái encode về central (KHÔNG chạm DB)

> Trả lời mắt xích còn thiếu của §8.3: `VideoStatus` đã có, nhưng **node đẩy trạng thái vào nó bằng
> cách nào** mà không lệ thuộc DB? Bối cảnh: từng "tạm ngưng" `VideoStatus` vì sợ node lệ thuộc DB —
> đó là **gộp nhầm 2 thứ**: `VideoStatus` sống ở **central** (vốn không phải của node); cái cần bỏ là
> **đường ghi node↔Mongo trực tiếp**, không phải bỏ `VideoStatus`.

### 8.6.1 Nguyên tắc
- **Giữ `VideoStatus`**; **chỉ central ghi MongoDB**. Node **không bao giờ mở kết nối Mongo**
  (lý do y hệt bỏ Redis §8.2: không expose store public, không rải credential/driver lên node đa vendor).
- Node **báo cáo bằng HTTP request outbound (node → central)**; central là DB-gateway duy nhất.
- Tham chiếu chuẩn: **kubelet** — agent trên node **không ghi etcd**, chỉ report status qua **API server**;
  chỉ API server ghi etcd. Map: node ↔ kubelet · central ↔ API server · MongoDB ↔ etcd.

### 8.6.2 Tại sao node→central PUSH, không phải central→node POLL (3 lăng kính)
- **Network:** node nằm sau NAT/firewall của ISP/VPS bất kỳ → **outbound luôn đi được, inbound thì không
  chắc**. Node đã POST heartbeat outbound → tái dùng đúng chiều. Central-poll-node vừa lãng phí request,
  vừa gãy sau NAT, vừa trễ. Status là sự kiện **node biết trước tiên** → node đẩy đi.
- **Software:** data-tier isolation — chỉ central nói chuyện DB; node chỉ biết 1 HTTP contract.
- **Delivery:** khớp Open Connect (§6.3) — control plane không trên đường byte; node chỉ serve + báo về.

### 8.6.3 Hai kênh bổ trợ (đừng chỉ chọn 1)
| | (A) Snapshot trong heartbeat | (B) Event POST khi đổi trạng thái |
|---|---|---|
| Kiểu | **Level-triggered** (đủ trạng thái hiện tại) | Edge-triggered (1 sự kiện) |
| Vai trò | **Source of truth / lưới an toàn (BẮT BUỘC)** | Giảm trễ (TÙY CHỌN) |
| Mất gói | Tự lành ở chu kỳ heartbeat kế | Bỏ qua — (A) vá lại |
| Idempotent | Tự nhiên (full state, không delta) | Cần guard ở central |

- **(A)** Heartbeat (~10s) chở `jobs:[{jobId, videoId, state, progress, updatedAt}]` (full snapshot). Central
  reconcile vào `VideoStatus`. Mất 1 gói → tự lành; central restart → heartbeat kế dựng lại đúng state.
- **(B)** Khi `→transfering/→ready/failed`: node bắn ngay `POST {central}/api/v1/nodes/jobs/{jobId}/status`
  kèm `X-Signature: HMAC` (§4.6). **Chỉ là tối ưu độ trễ** (ms thay vì ≤10s); best-effort, không retry vô hạn,
  logic không được phụ thuộc nó.

### 8.6.4 Correlation ("node lần ngược request central") — bằng jobId, không reverse-trace
1. **Central phát `jobId` (+ `videoStatusId` = `_id` doc `VideoStatus` vừa tạo ở `encoding`) lúc dispatch**, kèm `callbackUrl`.
2. **Node ack `202 Accepted` NGAY, không giữ request** (encode dài vài phút; giữ request = timeout/central restart giết nó).
   Node lưu `jobId` vào metadata task `p-queue`.
3. **Node report bằng request MỚI** đính kèm `jobId` đó → central tra ra đúng doc để update.
   → Đây là *async request-reply with correlation id* (giống webhook callback), **không** giữ kết nối gốc.

### 8.6.5 Hai chốt an toàn ở central
- **Monotonic state + chống stale:** chỉ tiến `encoding→transfering→ready`, không lùi; dùng `seq`/`bootId`/
  `updatedAt` loại report trễ/out-of-order (nhất là (A) đua (B)). `bootId` đổi giữa job → stalled, requeue (§4.2).
- **Xác thực node:** `X-Signature: HMAC` 2 chiều (§4.6) — không cho caller bất kỳ ghi `VideoStatus`.

### 8.6.6 Độ bền local của node mà không cần DB
- Nguồn sự thật local = **`p-queue` in-process + filesystem** (không phải hạ tầng chia sẻ → hợp lệ).
  Node restart (bootId đổi) → quét output (`init.mpd` + đủ `.m4s`?) suy ra state → **report lại** qua heartbeat.
  Tối đa thêm **1 file JSON local** `jobId↔videoId↔state` nếu cần bền qua restart giữa chừng — vẫn thuần local.
- Node **chết hẳn** → central xử lý qua **heartbeat staleness/lease** (§1): job kẹt `encoding` mà
  `now - lastHeartbeatAt > ngưỡng` → reconcile đánh `failed`/requeue node khác.

> **Cấm:** ❌ central-poll-node hỏi trạng thái · ❌ node ghi Mongo trực tiếp · ❌ giữ request gốc central→node chờ encode xong.
>
> Nguồn: Kubernetes kubelet/API server (https://kubernetes.io/docs/concepts/architecture/nodes/),
> controller level/edge-triggered (https://kubernetes.io/docs/concepts/architecture/controller/),
> Async Request-Reply + Correlation Identifier (https://learn.microsoft.com/azure/architecture/patterns/async-request-reply),
> Netflix Open Connect (§6.3). Các block JSON/endpoint chỉ là **ĐỀ XUẤT — chưa kiểm chứng** (rule SKILL §6).

---

## 8.7 [UPDATED 2026-06-20] Heartbeat API chi tiết + chọn cơ chế theo THỜI LƯỢNG thao tác

> Mở rộng §8.6: thiết kế cụ thể heartbeat; phản biện socket vs poll-10s; quyết định giữ sync hay
> async cho **delete / replicate / encode** dựa trên thời lượng thật đo được.

### 8.7.1 Luận điểm gốc — không có "một cơ chế cho tất cả"
Ba thao tác lệch nhau ~3 bậc độ lớn → cơ chế phải chọn theo **thời lượng so với 2 ngưỡng**:
(a) timeout connection trên đường đi, (b) độ trễ chấp nhận nếu async (= chu kỳ heartbeat).

| Thao tác | Đo được | Bậc thời gian |
|---|---|---|
| Delete | <1s @0.5–1 CPU | ~giây |
| Replicate | local <1s; cross-vendor vid 4′ ~30s+ | giây → phút |
| Encode | 1 CPU ~10′ cho vid 4′ (≈0.4× realtime; NVENC nhanh hơn) | phút → chục phút |

Mô hình tư duy (K8s): **dispatch = mệnh lệnh (sync/202), SỰ THẬT = khai báo (heartbeat reconcile).**
HTTP response chỉ là biên nhận đã-nhận-lệnh; trạng thái cuối luôn hội tụ qua heartbeat.

### 8.7.2 Heartbeat chở 3 nhóm dữ liệu (full snapshot, KHÔNG delta)
1. **health** (cpuLoad, memFree, diskFree, encodeSlots/Active, netOut)
2. **jobs[]** (jobId, kind, videoId, state, progress, updatedAt) — encode & replicate đang chạy
3. **inventory** (checksum; gửi full `videos[]` chỉ khi checksum đổi)

```jsonc
// ĐỀ XUẤT (chưa kiểm chứng — rule SKILL §6)
POST {CENTRAL_URL}/api/v1/nodes/heartbeat          // mỗi ~10s + jitter ±1–2s
Headers: X-Node-Id, X-Boot-Id (§4.2), X-Seq, X-Signature: HMAC-SHA256(body, NODE_SECRET) (§4.6)
Body: { ts, health:{...}, jobs:[{jobId,kind,videoId,state,progress,updatedAt}],
        inventory:{ checksum, videos: null } }     // videos chỉ điền khi checksum đổi
200:  { ackSeq, wantFullInventory:false, commands:[...] }   // commands tùy chọn — xem 8.7.5
```

**Hai tầng (học K8s/KEP-589):** liveness+jobs (đổi liên tục) mỗi 10s; inventory full list chỉ khi
checksum lệch. K8s: kubelet renew Lease **10s** nhưng full NodeStatus **5 phút** để giảm ghi etcd.
Bandwidth: ~1–5 KB/10s/node ≈ bỏ qua; 100 node ≈ 10 req/s. **Rải jitter** chống thundering herd.

### 8.7.3 Socket vs HTTP-poll-10s — phản biện thẳng
- "Socket ngắt khi central sập" **không** phải lý do loại socket: Socket.IO **tự reconnect**
  (pingInterval 25s, pingTimeout 20s → phát hiện chết ~45s; reconnection mặc định bật).
- **Lý do thật HTTP-poll thắng cho kênh báo cáo trạng thái:**
  1. **Stateless > stateful** — POST tự mang đủ state; central restart → POST kế chạy ngay, không reconnect/replay.
     Socket bắt central giữ session map (socket↔node), mất sạch khi restart.
  2. **Level-triggered tự lành** — POST=full snapshot, mất gói tự sửa. Socket event=delta edge-triggered,
     mất 1 event = lệch vĩnh viễn (trừ khi vẫn snapshot định kỳ → socket thành thừa cho mục đích này).
  3. **Né hỏng kiểu connection bền** (idle timeout proxy/LB, NAT mapping hết hạn, half-open).
- **Giá phải trả của poll (không giấu):** sàn trễ = chu kỳ (≤10s; revocation cần nhanh hơn → đi
  central→node push riêng, đã có blacklist §8.3); request nền lãng phí khi rảnh (N lớn cần jitter); không real-time thật.
- **Đính chính luận điểm NAT (turn trước):** node **bắt buộc có ingress public** (nginx serve segment +
  nhận lệnh) → central **với tới được** node → NAT **không** phải lý do chính. Lý do node→central push (không
  phải central poll) đúng hơn là: (i) trạng thái là kiến thức node sinh ra (push-khi-biết > poll mò);
  (ii) phân tán tải (mỗi node tự báo, central chỉ nhận) — đây là lý do K8s là kubelet-push, không apiserver-poll.
- **Tổng hợp:** **HTTP heartbeat = kênh authoritative bắt buộc.** Socket.IO chỉ làm **gia tốc độ trễ cho
  dữ liệu KHÔNG-authoritative** (vd % encode real-time cho frontend); **không bao giờ là kênh duy nhất**
  mang state quan trọng — rớt thì heartbeat vẫn hội tụ. (Khớp Datadog agent, Prometheus, K8s: đều periodic HTTP, không socket bền.)

### 8.7.4 "long polling" — làm rõ từ
- Long polling = client *cố ý* giữ request mở chờ sự kiện. Replicate/delete sync hiện tại **không** phải
  long polling — chỉ là request chậm vì việc chậm. Heartbeat 10s **cũng không** (đó là short-poll/push định kỳ).
- Khoảng cách liên vendor **không gây** long polling; vấn đề thật = **giữ connection sync mở suốt thao tác
  chậm → proxy/gateway cắt vì vượt idle timeout → central tưởng fail dù node xong → lệch state.** Thuốc chữa
  = **async (202 + heartbeat)**, không giữ connection nào → **miễn nhiễm khoảng cách.**
- Timeout cần nhớ: **API Gateway 29s (cứng)** → replicate 30s chắc chắn bị cắt; **ALB 60s**;
  proxy/egress thường 30–60s; **NAT GW idle TCP 350s**.

### 8.7.5 Quyết định từng thao tác
| Thao tác | Dispatch | Nguồn sự thật | Lý do |
|---|---|---|---|
| **Delete** (<1s) | **GIỮ Sync 200** | inventory heartbeat | nhanh, ổn, central còn sống; mất response → heartbeat tự vá |
| **Replicate** (30s→phút) | **CHUYỂN 202 + async** | inventory(node đích)+jobs heartbeat | né timeout 29–60s, central restart không mất kết quả; pull+Range resume §4.3 idempotent; miễn nhiễm khoảng cách |
| **Encode** (phút→chục phút) | **BẮT BUỘC 202 + async** | jobs(progress)+inventory heartbeat | quá dài cho sync; central chắc chắn restart đâu đó; biến thiên mạnh theo node |

- **Delete giữ sync** nhưng sự thật vẫn là inventory: sau xoá, checksum đổi → central reconcile.
- **Replicate/Encode**: node trả `202 {jobId}` ngay, báo tiến độ qua `jobs[]`, xong thì inventory cập nhật.
  Tùy chọn event POST (§8.6.3-B) để giảm trễ dưới 10s.
- **Command central→node:** node có ingress public → **direct POST** lệnh (đang dùng, ổn). Dự phòng: cho lệnh
  "đi nhờ" `commands[]` trong response heartbeat (trễ ≤10s, không hợp lệnh gấp). Nghiêng giữ direct POST chính.

### 8.7.5b [CHỐT 2026-06-20] Phạm vi giai đoạn này (đơn giản hoá có chủ đích)
- **Tạm gác Socket.IO + bỏ live progress encode** — chỉ là UX, không phải correctness; defer.
- **Bẫy cần tránh:** *một completion-POST đơn độc KHÔNG được là đường báo duy nhất* — nếu central restart/
  rớt request đúng lúc encode xong → central **kẹt `encoding` vĩnh viễn**. Quy tắc: completion luôn phải có backstop.
- **Encode/Replicate (chốt):** **heartbeat làm nền (bắt buộc, tự lành, trễ ≤10s)** + **completion-POST chỉ là
  gia tốc tùy chọn** (rớt cũng không sao vì heartbeat vá). KHÔNG phải "chọn 1 trong 2"; nếu chỉ muốn 1 thứ → chọn heartbeat.
  - Phương án thay thế nếu CHƯA build heartbeat: one-shot POST **+ central reconcile timeout** (job `encoding`
    quá ngưỡng → central hỏi lại node / đánh stale). Bắt buộc có timeout, không được POST đơn độc.
- **Delete (chốt):** giữ **sync 1 request**, nhưng **idempotent** (xoá cái đã-xoá = success) → central retry an toàn khi response rớt.
- **Progress encode (để dành):** khi làm, KHÔNG tin `percent` của fluent-ffmpeg; lấy `duration` bằng ffprobe +
  chạy FFmpeg cờ **`-progress`** (`out_time_ms/frame/fps/speed`) tự tính `%` (TODO §7).

### 8.7.6 Deploy node phải set thông tin central — chuẩn mực, không phải gánh nặng
Node cần `CENTRAL_URL` + `NODE_SECRET` (+ `NODE_ID` hoặc tự register). Đây là pattern **hub-and-spoke**
(§6.1): agent biết hub, hub không cần biết trước agent. Giống Datadog agent (api_key+site), GitLab/GitHub
runner (URL+token), kubelet (apiserver addr+bootstrap token), Nomad client (server addr). Lợi: central
không cần discovery; node tự outbound register → khớp cả node ở vendor lạ.

### 8.7.7 Số liệu tham chiếu
- K8s: node-status-update 10s · Lease renew 10s · mark NotReady 40s · full NodeStatus 5′ (KEP-589).
- Prometheus: scrape_interval 15s · scrape_timeout 10s.
- Socket.IO: pingInterval 25s · pingTimeout 20s · reconnection on.
- Timeout đường truyền: API Gateway 29s (cứng) · ALB 60s · NAT GW idle TCP 350s.

> Nguồn: K8s node heartbeats/Lease KEP-589 (https://kubernetes.io/docs/concepts/architecture/nodes/#heartbeats);
> controller level/edge (https://kubernetes.io/docs/concepts/architecture/controller/);
> Prometheus scrape_config (https://prometheus.io/docs/prometheus/latest/configuration/configuration/#scrape_config);
> Socket.IO options (https://socket.io/docs/v4/server-options/); AWS API GW 29s / ALB 60s
> (https://docs.aws.amazon.com/apigateway/latest/developerguide/limits.html);
> Async Request-Reply (https://learn.microsoft.com/azure/architecture/patterns/async-request-reply).
> Các block JSON/endpoint chỉ là **ĐỀ XUẤT — chưa kiểm chứng** (rule SKILL §6).

---

## Changelog
- **2026-06-20** — Thêm **§8.7.5b** (chốt phạm vi giai đoạn): tạm gác socket + bỏ live progress; cảnh báo
  bẫy completion-POST đơn độc gây kẹt `encoding` → encode/replicate dùng **heartbeat nền + POST gia tốc tùy
  chọn** (hoặc one-shot POST + reconcile timeout nếu chưa có heartbeat); delete giữ sync 1 request nhưng
  idempotent + retry; progress encode dùng ffprobe duration + cờ `-progress` (không tin fluent-ffmpeg `percent`).
- **2026-06-20** — Thêm **§8.7** (heartbeat API chi tiết 3 nhóm dữ liệu + 2 tầng kiểu K8s; phản biện
  socket vs poll-10s với lý do stateless/level-triggered, tự đính chính luận điểm NAT vì node có ingress
  public; làm rõ "long polling"; ma trận giữ-sync/chuyển-async cho delete/replicate/encode theo thời lượng
  + timeout proxy 29–60s; deploy cần CENTRAL_URL/NODE_SECRET kiểu hub-and-spoke; số liệu K8s/Prometheus/
  Socket.IO/AWS). Giữ nguyên toàn bộ nội dung cũ.
- **2026-06-20** — Thêm **§8.6** (cơ chế node báo trạng thái encode về central không chạm DB): giữ
  `VideoStatus` nhưng chỉ central ghi, node feed qua HTTP outbound; 2 kênh (heartbeat snapshot
  level-triggered = lưới an toàn + event POST edge-triggered = giảm trễ); correlation bằng `jobId`
  (ack 202 + report out-of-band, không reverse-trace); monotonic state + HMAC; độ bền local qua
  p-queue/filesystem. Cập nhật bảng §8.3 (dòng `VideoStatus` trỏ §8.6). Đối chiếu kubelet/API server,
  controller level/edge, async request-reply. Giữ nguyên toàn bộ nội dung cũ.
- **2026-06-20** — Chốt **bỏ Redis & BullMQ khỏi dự án** (node đa vendor không chia sẻ được hạ
  tầng LAN-bound). Thêm **§8** (lý do 3 lăng kính + bảng thay thế bằng MongoDB/`VideoStatus`/`p-queue` +
  mô hình central orchestration + playback độc lập sau handoff). Đánh dấu `[SUPERSEDED]` ở §1 (Redis
  liveness → `lastHeartbeatAt` Mongo) và §4.1 (BullMQ-trong-central → job-state Mongo). Cập nhật TODO §7.
  Giữ nguyên toàn bộ nội dung cũ.
