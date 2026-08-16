# Upload and Replication Contract v2

> [IMPLEMENTED 2026-07-19] Canonical contract cho Stream-Central-Server và Stream-Sub-Server.

## 1. Ownership

- Central là control plane và là nơi duy nhất đọc/ghi MongoDB cho Video, Info và Server.
- Sub là data plane: nhận chunk, ghép file, encode, lưu trữ và truyền file node-to-node.
- FE không tự tạo tên lưu trữ. Central phát `storageKey`; Sub chỉ dùng metadata đã validate.
- Route/presenter v1 được giữ trong thời gian migration. V2 dùng canonical envelope `{ ok, data }` hoặc `{ ok: false, error }`.

## 2. Upload session: FE → Central

FE gửi `originalFileName`, `extension`, `contentType`, `filesize`, `chunkSize`, `title` và `infoId` nếu có tới route phân bổ upload của Central. Central tạo Video/placement theo luồng hiện tại và trả thêm:

```json
{
  "upload": {
    "contractVersion": "stream-upload-v2",
    "uploadId": "uuid",
    "storageKey": "central-generated-hex",
    "extension": "mp4",
    "fileSize": 73400320,
    "chunkSize": 31457280,
    "chunkCount": 3,
    "target": {
      "url": "http://sub:9100/api/v2/uploads/chunks",
      "method": "POST",
      "field": "multipartFileChunk"
    },
    "headers": {
      "X-Upload-Contract": "stream-upload-v2",
      "X-Upload-Id": "uuid",
      "X-Storage-Key": "central-generated-hex",
      "X-Chunk-Count": "3",
      "X-Media-Extension": "mp4",
      "X-Media-Type": "DASH",
      "X-Video-Id": "central-video-id"
    }
  }
}
```

`X-Info-Id` chỉ xuất hiện khi có `infoId`. `originalFileName` chỉ phục vụ hiển thị/audit, không làm filesystem path.

## 3. Upload chunk: FE → Sub

- Endpoint: `POST /api/v2/uploads/chunks`.
- Multipart field: `multipartFileChunk`.
- FE dùng headers Central cấp và chỉ thêm `X-Chunk-Index` zero-based.
- Sub tự suy ra `<uploadId>.part.<index>`; không tin multipart filename hay `X-Chunk-Name`.
- `chunkSize` do Central giới hạn tối đa 30 MiB để khớp receiver.

Chưa đủ chunk — HTTP 202:

```json
{"ok":true,"data":{"contractVersion":"stream-upload-v2","uploadId":"uuid","storageKey":"hex","chunkIndex":0,"receivedCount":1,"chunkCount":3,"complete":false}}
```

Đủ chunk và đã nhận encode — HTTP 202:

```json
{"ok":true,"data":{"contractVersion":"stream-upload-v2","uploadId":"uuid","storageKey":"hex","complete":true,"alreadyComplete":false,"media":{"videoId":"id","infoId":null,"type":"DASH"},"job":{"type":"dash-encode","state":"accepted"}}}
```

Sub ghép bằng buffer cố định, tạo marker accepted và không chạy encode lần hai khi retry chunk cuối. `202 Accepted` chưa có nghĩa FFmpeg đã hoàn tất; durable job completion/reconcile vẫn là backlog.

## 4. Replication: Central → source Sub → destination Sub

Central query DB rồi gửi source Sub:

```json
{
  "contractVersion": "stream-replication-v2",
  "jobId": "replicate-...",
  "video": {"id":"video-id","storageKey":"hex","type":"DASH"},
  "destination": {"id":"server-id","URL":"host","port":":9100","receiveUrl":"http://host:9100/api/v2/replications/receive-file"}
}
```

- Source endpoint: `POST /api/v2/replications/send-folder`.
- Destination endpoint: `POST /api/v2/replications/receive-file`.
- Multipart field: `replicationFile`.
- Headers: `X-Replication-Contract`, `X-Job-Id`, `X-Storage-Key`, `X-File-Name`, `X-Video-Id`.
- Source chỉ đọc `videos/<storageKey>` và không query DB.

Destination trả HTTP 201 cho mỗi file:

```json
{"ok":true,"data":{"contractVersion":"stream-replication-v2","jobId":"replicate-...","storageKey":"hex","fileName":"init.mpd","received":true}}
```

Source chỉ trả HTTP 200 khi mọi file được xác nhận:

```json
{"ok":true,"data":{"jobId":"replicate-...","storageKey":"hex","filesSent":12,"files":[{"fileName":"init.mpd","status":201}]}}
```

Central kiểm tra `jobId`, `storageKey`, `filesSent > 0` trước khi cập nhật placement/replica. Luồng hiện tại vẫn giữ HTTP mở tối đa 120 giây; checksum, Range/resume, atomic finalize và durable reconciliation chưa hoàn tất.

## 5. Version skew và rollout

- Central mới thử v2 trước; khi Sub cũ trả 404/405/426, connector fallback `/api/v1/replicate/send-folder-v2` với cả command mới và `videoId/serverId` cũ.
- Sub mới không query DB. Body ID-only trả HTTP 426 `REPLICATION_CONNECTOR_UPGRADE_REQUIRED`.
- Thứ tự rollout an toàn: **Central mới → Sub mới → FE mới**.
- Old FE tiếp tục dùng v1; Central mới bridge Sub cũ trong giai đoạn lệch phiên bản.

## 5b. Trace `X-Request-Id` (2026-08-15)

Một thao tác upload/replicate đi qua nhiều tiến trình. `X-Request-Id` là sợi chỉ
nối log của chúng lại; thiếu nó thì mỗi bên chỉ thấy một mảnh rời.

| Chặng | Ai gắn header | Ghi chú |
|---|---|---|
| FE → Central | `APIs/core/apiConnector.js` | Sinh id nếu chưa có; Central echo lại qua `X-Request-Id` |
| FE → Sub (chunk) | `Utils.processVideoUploadToDashV2` | Lấy `traceId` từ upload session Central cấp — chunk **không** đi qua Central |
| Central → Sub | `clients/nodeClient.js`, và interceptor `clients/httpTracing.js` cho đường legacy | Đọc từ `AsyncLocalStorage`, không chuyền `req` xuống service |
| Sub nguồn → Sub đích | `services/replicationService.js` | Header lấy từ `utils/requestContext` của Sub |

Quy ước:

- Định dạng hợp lệ: `^[A-Za-z0-9._:-]{1,128}$`. Giá trị không khớp bị **thay** chứ
  không echo lại — id chứa xuống dòng có thể giả mạo một dòng log JSON.
- Không có id hợp lệ thì bên nhận tự sinh; thao tác vẫn phải truy vết được nội bộ.
- Sub gắn id vào mọi dòng `operationLog` và vào `error.requestId` của envelope v2.

> **[SUPERSEDED 2026-08-16]** Câu trên **đã sai trên thực tế** từ lúc viết cho tới 2026-08-16.
>
> **[UPDATED 2026-08-16]** `AsyncLocalStorage` bám theo async context của nơi **tạo ra** tài
> nguyên async, không theo thứ tự middleware. `req` được Node tạo **trước** khi `requestTrace`
> mở context; multer đọc body bằng stream event trên chính `req` đó, nên `next()` mà nó gọi chạy
> trong context gốc của HTTP server. Đo được:
>
> ```
> before multer: trace-123
> after  multer: null
> ```
>
> Hệ quả: **hai route quan trọng nhất mất trace** — `upload.chunk.accepted` và
> `replication.file.received`, đúng hai chỗ dữ liệu thật được ghi xuống đĩa. Và vì
> `encodeJobService` chụp `requestId` để gắn vào callback gửi Central hàng chục phút sau, sợi
> trace đứt từ FE tới tận lúc encode xong.
>
> Đã sửa bằng `requestTrace.resume` — middleware đặt **ngay sau** multer, đọc lại id từ response
> header (giá trị đã validate) và mở lại context. No-op khi context còn nguyên. Có test hồi quy
> (`tests/phase1.test.js`), đã xác minh test fail khi gỡ bản vá.
- Trace **chỉ** áp cho control plane. `/api/auth/verify` (nginx gọi mỗi segment)
  và các handler `*.mpd`/`*.m4s` nằm ngoài, có chủ đích: chúng chạy hàng nghìn
  lần mỗi phiên xem và một request segment không thuộc thao tác control nào.

## 6. Validation, logging và failure modes

- Identity/filename phải là token ASCII an toàn; path traversal bị chặn.
- Log dùng `uploadId` hoặc `jobId`, không log binary/toàn bộ headers.
- Mọi dòng log control plane của Sub có `requestId`; ngoài phạm vi request thì
  field này được bỏ hẳn thay vì ghi `null`.
- Upload retry được bảo vệ bằng marker; replication retry/resume cấp file chưa hoàn chỉnh.
- Shared connector token/mTLS, encode callback, checksum và inventory reconciliation là hardening tiếp theo.
- Model/config Mongoose legacy có thể còn trên đĩa, nhưng entrypoint/controller/route/service active của Sub không mở hoặc import DB.

## 7. [UPDATED 2026-08-16] `stream-encode-v1` — callback kết quả encode

Bịt khoảng trống đã ghi ở mục 6: trước đây `202 Accepted` là tín hiệu **cuối cùng** Central nhận
được về một lần upload; FFmpeg xong hay chết thì không bên nào biết.

**Sub → Central**, sau khi job kết thúc (thành công hoặc thất bại):

```
POST {CENTRAL_API}{ENCODE_CALLBACK_PATH}      mặc định /api/v2/nodes/jobs/result
X-Node-Id: <nodeId>
X-Request-Id: <id của phiên upload, từ nhiều giờ trước>
```

```json
{
  "contractVersion": "stream-encode-v1",
  "nodeId": "legacy:sub-1",
  "jobId": "encode-1786859819050-<storageKey>",
  "uploadId": "…", "storageKey": "…",
  "state": "ready",
  "media": {"videoId":"…","infoId":null,"type":"DASH",
            "mediaDir":"videos/<storageKey>","manifest":"init.mpd",
            "files":42,"durationSec":1432.5},
  "encode": {"profile":7,"startedAt":"…","finishedAt":"…","encodeSec":812},
  "error": null
}
```

`state` là `ready` hoặc `failed`. Khi `failed`, `error` mang `{code, message, stderrTail}` với
`code` ∈ `ENCODE_FAILED` · `ENCODE_TIMEOUT` · `ENCODE_START_FAILED` · `ENCODE_INTERRUPTED`.

Ba tính chất Central phải dựa vào được:

1. **Idempotent theo `jobId`** — Sub retry 5 lần (5s → 80s), Central phải chịu được lệnh trùng.
2. **Chỉ retry lỗi transport và 5xx.** Một 404 nghĩa là endpoint chưa tồn tại; Sub không gửi lại,
   nhưng ghi `deliveredToCentral: false` vào `.job.json`.
3. **Bền qua restart.** Trạng thái nằm ở `<stagingRoot>/.<storageKey>.job.json`, ghi atomic
   (tmp + rename). Lúc boot, `encodeJobService.reconcile()` đánh `failed` cho job còn kẹt ở
   `running` và gửi lại những job chưa giao được.

Central chưa có endpoint thì đặt `ENCODE_CALLBACK=off`; job vẫn chạy và vẫn ghi trạng thái. Tra
thủ công: `GET /api/v2/uploads/jobs/:storageKey`.

## 8. [UPDATED 2026-08-16] Ranh giới data plane — Node không phục vụ media

Sub trả **410 Gone** cho mọi request `.m4s`/`.mpd`/`.vtt`/`.png` tới Node. Đường phát duy nhất là
nginx `:9150`.

Lý do là điều kiện cần cho token auth có ý nghĩa: chừng nào Node còn trả được segment, vẫn tồn
tại một đường lấy dữ liệu **không đi qua `auth_request`** — tức không qua token check và không
qua danh sách chặn. Van xả `MEDIA_SERVING=on`. Đếm vi phạm: `GET /api/default/data-plane`.

Kèm theo, Sub có **công tắc chặn phát** dùng được bất cứ lúc nào:

| | |
|---|---|
| `POST /api/v2/playback/blocks` | `{type, value, reason, ttlSeconds}`, `type` ∈ `session` · `storageKey` · `ip` |
| `DELETE /api/v2/playback/blocks/:id` | gỡ |
| `GET /api/v2/playback/probe?uri=…` | thử trước khi chặn thật |

Hai tính chất quan trọng: block **chặn thật kể cả khi `AUTH_MODE=off`** (nó là can thiệp vận
hành, không phải chính sách chung), và **sống qua `pm2 restart`** (khác `globals/blacklist` cũ
chỉ nằm trong RAM). Hiệu lực ở request segment kế tiếp — trễ đúng bằng buffer của player, cộng
TTL `proxy_cache` nếu có bật cache auth ở nginx.

Phạm vi: block chỉ áp dụng cho **node ghi nó**. Chặn toàn cụm là việc của Central.

## Changelog

- **2026-08-16** — Thêm mục 7 (`stream-encode-v1`) và mục 8 (ranh giới data plane + công tắc chặn
  phát). Đính chính mục 5b: trace `X-Request-Id` **mất qua multer** do AsyncLocalStorage, nên hai
  route multipart quan trọng nhất chưa từng có `requestId` trong log; đã vá bằng
  `requestTrace.resume` và có test hồi quy.

- **2026-08-15** — Thêm mục 5b: trace `X-Request-Id` xuyên FE → Central → Sub nguồn → Sub đích;
  quy ước validate/thay thế id, Sub gắn id vào `operationLog` và envelope lỗi v2, và ranh giới
  control plane / data plane của trace. Không đổi contract upload/replication đang có.
- **2026-07-19** — Ghi nhận implementation upload/replication v2, DB ownership, deterministic filename, acknowledgement, version fallback và rollout order.
