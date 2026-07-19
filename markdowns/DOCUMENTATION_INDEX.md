# Documentation Index and Sync Policy

> [UPDATED 2026-07-19] `Stream-Documents/markdowns` là bản canonical cho kiến thức dùng chung.
> Hai project code giữ bản copy của **nhóm tài liệu cần làm việc tại repo đó**, không mirror mù
> mọi bài nghiên cứu. Khi trùng tên, phải diff nội dung; timestamp copy không chứng minh phiên bản
> mới hơn.

## 1. Đọc trước khi phân tích code/kiến trúc

| Thứ tự | Tài liệu | Mục đích |
|---|---|---|
| 1 | `current-implementation-audit-2026-07.md` | Sự thật AS-IS theo code và khoảng cách với TARGET. |
| 2 | `PROJECT_SUMMARY_CENTRAL.md` hoặc `PROJECT_SUMMARY_SUB.md` | Inventory chi tiết từng repo; phần snapshot cũ được giữ lại. |
| 3 | `central-node-architecture-comparison.md` | Lý do/constraint của kiến trúc TARGET. |
| 4 | `node-central-backlog-and-decisions.md` | Quyết định, việc chưa làm và baseline implementation. |
| 5 | `codex-context-handoff-2026-07.md` | Context frontend/player/backend mới nhất của Central. |

Quy tắc: nếu summary/architecture nói một tính năng “đã có” nhưng audit và source code không
chứng minh, coi nó là **TARGET/backlog**, không phải implementation.

## 2. Nhóm tài liệu đồng bộ vào Stream-Central-Server

### Bắt buộc

- `current-implementation-audit-2026-07.md`
- `PROJECT_SUMMARY_CENTRAL.md` → project copy đặt tên `PROJECT_SUMMARY.md`
- `central-node-architecture-comparison.md`
- `node-central-backlog-and-decisions.md`
- `distributed-video-streaming-research-and-roadmap.md`
- `node-network-reachability-constraints.md`
- `deployment-hidden-bugs-and-pitfalls.md`
- `DOCUMENTATION_INDEX.md`
- `upload-replication-contract-v2.md`

### Theo domain đang có trong Central

- player/frontend: `VideoManagementUI.md`, `video-player-error-recovery.md`,
  `http-header-non-ascii-encoding.md`, `vlc-vs-ffmpeg-subtitle-tolerance-references.md`;
- media/FFmpeg: `cmaf-abr-stream-analysis-tools.md`, `dash-stream-realtime-monitoring.md`,
  `FFmpeg_DASH_Streaming_Knowledge_Base.md`, `ffmpeg_mpeg_dash_multibitrate.md`,
  `ffmpeg-hevc-dash-streaming-notes.md`, `ffmpeg-presets-reference.md`;
- delivery: `NGINX_FFmpeg DASH Streaming.md`, `nginx-config-operations-guide.md`,
  `nginx-streaming-mechanism-and-benchmarks.md`;
- nền tảng OTT: `ott-architecture-components.md`, `ott-streaming-history-and-market.md`,
  `video-streaming-knowledge-101.md`, `video-streaming-protocols-knowledge-base.md`,
  `RTP Streaming_Comprehensive_Technical_Guide.md`.

`codex-context-handoff-2026-07.md` hiện phát sinh ở Central và đã được copy ngược về canonical
repository; không ghi đè bản Central nếu working tree có update mới hơn mà chưa merge.

## 3. Nhóm tài liệu đồng bộ vào Stream-Sub-Server

### Bắt buộc

- `current-implementation-audit-2026-07.md`
- `PROJECT_SUMMARY_SUB.md` → project copy đặt tên `PROJECT_SUMMARY.md`
- `central-node-architecture-comparison.md`
- `node-central-backlog-and-decisions.md`
- `distributed-video-streaming-research-and-roadmap.md`
- `node-network-reachability-constraints.md`
- `deployment-hidden-bugs-and-pitfalls.md`
- `vm-server-setup-guide.md`
- `multi-cloud-free-tier-node-deployment.md`
- `oracle-storage-node-deploy-log.md`
- `DOCUMENTATION_INDEX.md`
- `upload-replication-contract-v2.md`

### Media/encode/nginx trực tiếp liên quan node

- `encode_explain.md`
- `init_compare_output.md`
- `init_compare_output_command.md`
- `FFmpeg_DASH_Streaming_Knowledge_Base.md`
- `ffmpeg_mpeg_dash_multibitrate.md`
- `ffmpeg-hevc-dash-streaming-notes.md`
- `ffmpeg-presets-reference.md`
- `cmaf-abr-stream-analysis-tools.md`
- `dash-stream-realtime-monitoring.md`
- `NGINX_FFmpeg DASH Streaming.md`
- `nginx-config-operations-guide.md`
- `nginx-streaming-mechanism-and-benchmarks.md`
- `http-header-non-ascii-encoding.md`

Không cần copy các bài career/market/CDN thuần nghiên cứu vào sub repo trừ khi task cụ thể cần.

## 4. Cách xác định phiên bản mới hơn

1. Ưu tiên source code đang checkout và commit date để xác định implementation.
2. Với markdown trùng tên, diff nội dung và changelog; không dùng `LastWriteTime` đơn độc.
3. Bản chứa phần mới có nguồn/bằng chứng được merge vào canonical, không xóa phần cũ.
4. Khi assertion cũ sai, thêm `SUPERSEDED` + assertion mới `UPDATED`.
5. Sau khi canonical ổn định mới copy nhóm liên quan sang project code.

## Upload/replication contract đang áp dụng

- `upload-replication-contract-v2.md` — contract FE → Central → Sub và Sub → Sub; Central sở hữu DB, Sub chỉ xử lý data plane.

## Changelog

- **2026-07-19** — Thêm contract upload/replication v2 và ranh giới runtime Sub không DB.

- **2026-07-19** — Tạo index sau khi đối chiếu ba repo; xác định Stream-Documents là canonical,
  lập nhóm sync chọn lọc cho Central/Sub và quy tắc phân biệt AS-IS/TARGET/version mới hơn.
