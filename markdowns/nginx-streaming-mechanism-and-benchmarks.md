# NGINX cho serving DASH — Cơ chế, Điểm mạnh & Số liệu kiểm chứng

**Tạo:** 2026-06-25
**Mục đích:** Phân tích **TẠI SAO** nginx phù hợp serve DASH (static segment), kèm số
liệu benchmark kiểm chứng được. Đây là góc **cơ chế/benchmark**, khác file
`NGINX_FFmpeg DASH Streaming.md` (góc **how-to/config**).

> Liên quan: [[NGINX_FFmpeg DASH Streaming]] (config/CORS/auth_request),
> [[cdn-providers-akamai-vs-hyperscaler-ott]], [[central-node-performance-checklist]].

---

## 0. Tóm tắt 1 dòng
DASH serving = **HTTP static delivery của nhiều file nhỏ, nhiều kết nối đồng thời, kéo
dài** → đúng bài toán C10K mà nginx sinh ra để giải. 5 cơ chế cốt lõi: (1) event-driven
non-blocking, (2) `sendfile()` zero-copy, (3) thread pool cho blocking disk I/O, (4)
Range + `open_file_cache` native, (5) HTTP/2-3 multiplexing. Bằng chứng quy mô thật:
**Netflix Open Connect serve 400 Gbps video TLS / 1 máy bằng nginx**.

> ⚠️ **By-design:** gần như TOÀN BỘ ưu thế dưới đây KHÔNG có trên bản nginx **Windows**
> (§7). Production phải chạy nginx trên **Linux**.

---

## 1. Event-driven non-blocking — bài toán C10K

**Lịch sử:** Apache (1995) dùng process/thread-per-connection → RAM tăng tuyến tính,
context-switch bùng nổ khi vượt vài nghìn kết nối ("C10K problem", Dan Kegel 1999). Igor
Sysoev viết nginx (public 2004) **chỉ để giải C10K** cho Rambler.

**Cơ chế:**
- 1 master + N worker (`worker_processes auto` = #CPU core).
- Mỗi worker = single-thread event loop dùng `epoll`(Linux)/`kqueue`(BSD) theo dõi hàng
  nghìn socket, **không block** từng kết nối.
- Kết nối idle/keepalive gần như free: chỉ 1 entry epoll + struct nhỏ, KHÔNG tốn 1
  thread/stack.

**Khớp DASH (3 lăng kính):**
- *Network:* mỗi viewer = 1 keepalive dài, request burst theo nhịp segment, phần lớn idle
  giữa các segment → event-driven giữ free; prefork chết vì RAM.
- *Software:* worker = #core, scale tuyến tính không cần tune thread thủ công.
- *Broadcast:* ABR rendition switch → thêm nhiều request nhỏ, càng lợi.

**Số liệu:** *Architecture of Open Source Applications — nginx*: ~10.000 kết nối inactive
trong vài MB RAM.

---

## 2. `sendfile()` zero-copy — trái tim static serving

`read()`+`write()` ngây thơ: 4 copy + 2 context-switch (disk→page cache→**user buffer
nginx**→socket buffer→NIC).
`sendfile(2)`: kernel chuyển thẳng **page cache → socket**, data KHÔNG vào user-space của
nginx → 2 copy (DMA), CPU gần như không đụng payload.
- `sendfile on;` bật.
- `tcp_nopush on;` (chỉ tác dụng khi sendfile bật): gom header+data thành full TCP segment.

**By-design cho video:** `.m4s` là payload thuần, không cần xử lý → kịch bản lý tưởng của
zero-copy. **Netflix giữ bằng được pipeline này**: khi cần TLS, họ đẩy crypto xuống kernel
(kTLS) → NIC offload thay vì kéo về user-space, *"to preserve the sendfile pipeline"*.

> ⚠️ `sendfile` KHÔNG hỗ trợ trên Windows nginx (§7).

---

## 3. Thread pool cho blocking disk I/O — benchmark 9x (mạnh nhất cho VOD)

**Vấn đề:** event loop chỉ nhanh khi không syscall nào block. `read()` từ ĐĨA block khi
cache miss (file không trong page cache) → worker single-thread block = TẤT CẢ kết nối của
worker đó đứng hình. Catalog VOD > RAM → cache miss liên tục.

**Lời giải (NGINX 1.7.11, 2015):** `aio threads;` offload `read()`/`sendfile()` có nguy cơ
block sang thread pool riêng; event loop chính tiếp tục phục vụ request hit-from-RAM.

**Benchmark chính thức (F5/NGINX blog) — kiểm chứng được:**
Cấu hình: 2×Xeon E5645 (24 HT-thread), **48 GB RAM**, 4×HDD RAID10, NIC 10 Gbps, Ubuntu
14.04; dataset **256 GB file 4-MB random** (cố tình > RAM), 200 conn song song.

| Chỉ số | Không thread pool | Có thread pool | Cải thiện |
|---|---|---|---|
| Throughput | ~1 Gbps | **9.5 Gbps** | ~9.5× |
| Latency tb (wrk) | 7.42 **s** | 226 **ms** | ~33× |
| Requests/sec | 8.08 | 250.57 | ~31× |
| Transfer | 34.07 MB/s | 0.98 GB/s | ~30× |
| CPU iowait | 31.9% (worker D-state) | 61.5% (đĩa full, worker S-state) | đĩa thành bottleneck thật |

**Ý nghĩa DASH:** NGINX nói thẳng tối ưu này *"most useful... such as a heavily loaded
NGINX-based streaming media server"*. Khi catalog VOD > RAM (luôn đúng với hệ nhiều phim),
đây là khác biệt giữa "đĩa là bottleneck" và "worker treo, server chết".

> Trung thực: nếu working set VỪA trong RAM → thread pool KHÔNG giúp gì (nginx đã tối ưu từ
> page cache). Đây là tối ưu I/O-bound, không phải "bật là nhanh".

---

## 4. Range request + open_file_cache (native)

- **`ngx_http_range_filter_module`**: xử lý `Range:` → `206 Partial Content` sẵn có, không
  cần app code. Quan trọng cho **DASH `SegmentBase`** (single-file DASH, player kéo segment
  bằng byte-range trên 1 file lớn) và seek/tua/recovery.
- **`open_file_cache`**: cache fd + metadata, loại bỏ `open()`/`stat()` lặp cho hàng nghìn
  `.m4s` request lặp lại.
  ```nginx
  open_file_cache          max=10000 inactive=60s;
  open_file_cache_valid    30s;
  open_file_cache_min_uses 2;
  open_file_cache_errors   on;
  ```

---

## 5. HTTP/2 & HTTP/3 multiplexing — khớp pattern many-small-objects

DASH = nhiều request object nhỏ. HTTP/1.1 giới hạn ~6 conn/host + HOL blocking → segment
xếp hàng.
- **HTTP/2** (nginx ≥1.9.5): multiplex nhiều segment/1 conn, HPACK header compression.
- **HTTP/3/QUIC** (nginx ≥**1.25.0**, 2023): trên UDP, bỏ HOL blocking transport — lợi cho
  mạng mất gói (mobile).

> ⚠️ HTTP/3 cần UDP → KHÔNG có trên Windows nginx (§7).

---

## 6. Bằng chứng quy mô thật: Netflix Open Connect
- OCA = **FreeBSD + nginx**, serve qua `sendfile(2)`.
- TLS video / 1 máy đơn: **200 → 400 Gbps (production) → 800 Gbps prototype** (Drew
  Gallatin, EuroBSDCon 2021). HW: AMD EPYC 7502P, 2×Mellanox ConnectX-6 Dx (kTLS offload).
- Bài học: mọi tối ưu lớn xoay quanh **bảo toàn pipeline `sendfile` zero-copy** của nginx —
  tức điểm mạnh §2 là thứ một CDN tỉ-đô xây toàn stack xung quanh.

---

## 7. ⚠️ By-design: bản nginx Windows mất gần hết ưu thế

Docs chính thức `nginx.org/en/docs/windows.html` (nguyên văn): *"beta version... high
performance and scalability should not be expected."*

| Cơ chế ưu thế | Trên Windows | Hệ quả |
|---|---|---|
| epoll/kqueue (§1) | chỉ `select()`/`poll()` | không scale như Unix |
| multi-worker theo core (§1) | **chỉ 1 worker thực sự làm việc** | không dùng nhiều core |
| `sendfile()` (§2) | **không hỗ trợ** | mất zero-copy |
| HTTP/3/QUIC (§5) | **không có UDP** | không HTTP/3 |

**Hành động:**
- Windows nginx: ĐỦ cho dev/test vài viewer (giai đoạn hiện tại của dự án).
- **Production multi-cloud (AWS/Azure/GCP) PHẢI chạy nginx trên Linux** (VM/container) để
  có epoll + multi-worker + sendfile + (tùy chọn) HTTP/3. Bắt buộc nếu muốn số liệu §1–§6
  có ý nghĩa.

---

## 8. Liên hệ dự án — auth_request
Token-gated: `auth_request` phát subrequest nội bộ sang endpoint Node.js nhẹ validate token
TRƯỚC khi serve segment → giữ toàn bộ ưu thế static zero-copy, chỉ trả chi phí 1 subrequest.
Đây là **token-gated access, KHÔNG phải DRM** (không mã hoá content, không license server).

---

## References (truy cập 2026-06-25)
- NGINX, *Thread Pools in NGINX Boost Performance 9x!* — https://www.f5.com/company/blog/nginx/thread-pools-boost-performance-9x
- nginx docs, *nginx for Windows* — https://nginx.org/en/docs/windows.html
- D. Gallatin, *Serving Netflix Video at 400Gb/s on FreeBSD*, EuroBSDCon 2021 — https://papers.freebsd.org/2021/eurobsdcon/gallatin-netflix-freebsd-400gbps/
- D. Gallatin, *400Gb/s and Beyond* — https://nabstreamingsummit.com/wp-content/uploads/2022/05/2022-Streaming-Summit-Netflix.pdf
- FreeBSD Foundation, *Netflix Case Study* — https://freebsdfoundation.org/netflix-case-study/
- A. Alexeev, *AOSA — nginx* — https://aosabook.org/en/v2/nginx.html
- nginx docs (core/range/sendfile/http_v3) — https://nginx.org/en/docs/

---

## Changelog
- **2026-06-25** — Tạo file. Phân tích 5 cơ chế nginx phù hợp DASH + benchmark thread pool
  9x (1→9.5 Gbps), Netflix 400/800 Gbps, và cảnh báo by-design bản Windows (beta, 1 worker,
  không sendfile/QUIC). Nguồn: F5/NGINX blog, nginx.org docs, Gallatin EuroBSDCon 2021.
