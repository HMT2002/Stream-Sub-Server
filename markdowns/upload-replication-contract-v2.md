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

## 6. Validation, logging và failure modes

- Identity/filename phải là token ASCII an toàn; path traversal bị chặn.
- Log dùng `uploadId` hoặc `jobId`, không log binary/toàn bộ headers.
- Upload retry được bảo vệ bằng marker; replication retry/resume cấp file chưa hoàn chỉnh.
- Shared connector token/mTLS, encode callback, checksum và inventory reconciliation là hardening tiếp theo.
- Model/config Mongoose legacy có thể còn trên đĩa, nhưng entrypoint/controller/route/service active của Sub không mở hoặc import DB.

## Changelog

- **2026-07-19** — Ghi nhận implementation upload/replication v2, DB ownership, deterministic filename, acknowledgement, version fallback và rollout order.
