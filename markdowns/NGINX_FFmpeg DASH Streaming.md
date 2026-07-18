# NGINX + FFmpeg DASH Streaming - Hướng dẫn Chi tiết

**Phiên bản:** 1.0  
**Cập nhật:** June 2026  
**Tác giả:** Từ tài liệu chính thức NGINX & FFmpeg  
**Mục đích:** Cấu hình DASH streaming server trên Windows với NGINX

---

## Phần 1: Giới thiệu DASH (Dynamic Adaptive Streaming over HTTP)

### DASH là gì?

DASH (Dynamic Adaptive Streaming over HTTP) là một tiêu chuẩn streaming video cho phép:
- Phát video với chất lượng tự động thích ứng (adaptive bitrate)
- Chia video thành các segment nhỏ (thường 2-10 giây)
- Máy khách chọn bitrate phù hợp với băng thông hiện tại
- Sử dụng HTTP standard (dễ deploy, không cần port đặc biệt)

### Các thành phần DASH

1. **MPD File (Media Presentation Description)** - File XML chứa metadata
2. **Initialization Segment** - Init file (.mp4) có codec info
3. **Media Segments** - Các segment video (.m4s) nhỏ từng cái

### Ưu điểm
- Adaptive bitrate (ABR) - tự động điều chỉnh chất lượng
- Tương thích cao với các CDN hiện đại
- Hỗ trợ multiple codecs và resolutions
- Không cần server đặc biệt (chỉ HTTP file server)

---

## Phần 2: NGINX - Cài đặt & Cấu hình Cơ bản

### 2.1 Cài đặt NGINX trên Windows

#### Tùy chọn 1: Tải từ trang chính thức
- **URL:** https://nginx.org/en/download.html
- **Chọn:** Mainline version (phiên bản mới nhất với tính năng mới)
- **Giải nén:** Vào thư mục `path\to\nginx` (hoặc tùy ý)

#### Tùy chọn 2: Tải NGINX-RTMP (có module DASH)
- **URL:** https://github.com/illuspas/nginx-rtmp-win32
- Phiên bản này đi kèm module RTMP/DASH support

### 2.2 Cấu trúc Thư mục
D:/nginx_server/
├── conf/
│   ├── nginx.conf          (file cấu hình chính)
│   └── mime.types          (MIME type mappings)
├── html/
│   ├── index.html          (trang mặc định)
│   └── dash/               (thư mục lưu DASH content)
│       ├── manifest.mpd    (file manifest)
│       ├── init_.mp4      (initialization segments)
│       └── chunk_.m4s     (media segments)
├── logs/
│   ├── access.log
│   └── error.log
├── nginx.exe               (executable)
└── start.bat               (batch script tùy chọn)
### 2.3 Cấu hình nginx.conf Chi tiết

Đây là một file cấu hình hoàn chỉnh cho DASH streaming:

```nginx
worker_processes auto;

events {
    worker_connections 1024;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    
    sendfile      on;
    keepalive_timeout 65;
    
    # Logging
    access_log    logs/access.log;
    error_log     logs/error.log;
    
    # Gzip compression (tuỳ chọn, giúp tiết kiệm băng thông)
    gzip on;
    gzip_types application/dash+xml video/mp4 audio/mp4 application/mp4;
    gzip_min_length 1024;

    server {
        listen       8080;
        server_name  localhost;
        
        # Root configuration - tất cả requests từ localhost:8080/
        root html;
        
        # Location cho DASH content
        location /dash {
            # Nếu dùng root (append location path)
            root html;  # Tìm file tại D:/nginx_server/html/dash/dash/...
            
            # Hoặc dùng alias (direct substitution) - recommended
            alias html/dash/;  # Tìm file tại D:/nginx_server/html/dash/...
            
            # CORS headers - QUAN TRỌNG cho DASH player
            add_header 'Access-Control-Allow-Origin' '*';
            add_header 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS';
            add_header 'Access-Control-Allow-Headers' 'Content-Type, Range';
            add_header 'Access-Control-Expose-Headers' 'Content-Length, Content-Type';
            
            # Cache control
            add_header Cache-Control 'public, max-age=10';
            
            # MIME types cho DASH
            types {
                application/dash+xml mpd;
                video/mp4 mp4 m4v m4p;
                audio/mp4 m4a;
                application/mp4 mp4;
            }
        }
        
        # Location cho static player (tuỳ chọn)
        location /player {
            root html;
            index index.html;
        }
        
        # Default location
        location / {
            index index.html index.htm;
        }
    }
}
```

**Lưu ý về mime.types:**
- File `mime.types` trong thư mục `conf/` đã chứa mapping cho `video/mp4`
- Nếu thêm custom types vào `nginx.conf`, nó sẽ override mime.types
- Để tránh duplicate warning, dùng `include mime.types` và thêm custom types ngoài block types

### 2.4 Các NGINX Commands quan trọng

#### Khởi động NGINX
```bash
# Từ thư mục path\to\nginx
nginx.exe

# Hoặc chạy từ anywhere (nếu thêm vào PATH)
start nginx
```

#### Dừng NGINX
```bash
# Graceful shutdown (finish active requests)
nginx -s quit

# Force shutdown (immediate)
nginx -s stop
```

#### Reload configuration (không restart)
```bash
nginx -s reload
```

#### Test cấu hình syntax
```bash
nginx -t
# Output: nginx: configuration file ... test is successful
```

#### Reopen log files
```bash
nginx -s reopen
```

#### Kiểm tra version
```bash
nginx -v
# Detailed version with modules
nginx -V
```

#### Kiểm tra process
```bash
tasklist /fi "imagename eq nginx.exe"
```

#### Force kill (nếu hang)
```bash
taskkill /F /IM nginx.exe
```

---

## Phần 3: Tạo DASH Content với FFmpeg

### 3.1 Cài đặt FFmpeg

- **Download:** https://ffmpeg.org/download.html
- **Windows:** Chọn static build (exe file)
- **Thêm vào PATH:** Để dùng `ffmpeg` từ command line bất kỳ

### 3.2 FFmpeg DASH Encoding Command

Câu lệnh cơ bản để tạo DASH content từ video source:

```bash
ffmpeg -i input_video.mp4 \
  -c:v libx264 \
  -b:v 2500k \
  -c:a aac \
  -b:a 128k \
  -vf "scale=1920:1080" \
  -map 0 \
  -f dash \
  -seg_duration 4 \
  -use_template 1 \
  -use_timeline 1 \
  -init_seg_name "init_$RepresentationID$.mp4" \
  -media_seg_name "chunk_$RepresentationID$_$Number$.m4s" \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  output/manifest.mpd
```

#### Giải thích tham số:

| Tham số | Ý nghĩa |
|--------|---------|
| `-i input_video.mp4` | File video input |
| `-c:v libx264` | Video codec: H.264 |
| `-b:v 2500k` | Bitrate video: 2500 kbps |
| `-c:a aac` | Audio codec: AAC |
| `-b:a 128k` | Bitrate audio: 128 kbps |
| `-vf "scale=1920:1080"` | Resolution output: 1920x1080 |
| `-f dash` | Format output: DASH |
| `-seg_duration 4` | Độ dài segment: 4 giây |
| `-use_template 1` | Dùng template names cho segments |
| `-use_timeline 1` | Tạo timeline.xml cho accurate timing |
| `-init_seg_name` | Tên init segment (dùng $RepresentationID$) |
| `-media_seg_name` | Tên media segments |
| `-adaptation_sets` | Group streams: id=0 cho video, id=1 cho audio |

### 3.3 Multiple Bitrates (Adaptive)

Để tạo DASH với adaptive bitrate (recommended), encode multiple quality levels:

```bash
ffmpeg -i input.mp4 \
  -c:v libx264 -b:v 5000k -vf "scale=1920:1080" -c:a aac -b:a 192k \
  -c:v libx264 -b:v 2500k -vf "scale=1280:720" -c:a aac -b:a 128k \
  -c:v libx264 -b:v 1000k -vf "scale=854:480" -c:a aac -b:a 96k \
  -map 0:v:0 -map 0:a:0 \
  -map 0:v:0 -map 0:a:0 \
  -map 0:v:0 -map 0:a:0 \
  -f dash \
  -seg_duration 4 \
  -use_template 1 \
  -use_timeline 1 \
  -init_seg_name "init_$RepresentationID$.mp4" \
  -media_seg_name "chunk_$RepresentationID$_$Number$.m4s" \
  output/manifest.mpd
```

---

## Phần 4: Root vs Alias - Sự Khác biệt Chi tiết

Đây là phần quan trọng nhất để hiểu cấu hình NGINX. Hiểu sai sẽ gây 404 errors.

### 4.1 Root Directive

#### Cách hoạt động

```nginx
location /dash {
    root html/dash;
}
```

Khi request `GET /dash/manifest.mpd` đến NGINX:

1. NGINX lấy **location path** = `/dash`
2. NGINX lấy **root path** = `html/dash`
3. **Combine:** `root_path + location_path`
4. **Final path:** `html/dash + /dash = html/dash/dash`
5. **Absolute:** `D:/nginx_server/html/dash/dash/manifest.mpd`

**Điều này sai!** Bạn sẽ gặp 404 vì file không tồn tại ở `...dash/dash/...`

#### Cách đúng: Chỉ định root là parent folder

```nginx
location /dash {
    root html;  # Parent folder, không chứa /dash
}
```

Khi request `GET /dash/manifest.mpd`:

1. Location path = `/dash`
2. Root path = `html`
3. Combine: `html + /dash = html/dash`
4. Absolute: `D:/nginx_server/html/dash/manifest.mpd`

**Đúng!** File tồn tại tại đây.

#### Giải thích Relational Path

- `html/dash` được resolve từ **NGINX installation directory** (`D:/nginx_server`)
- NGINX trên Windows không có concept "current working directory" như bash
- Tất cả relative paths đều từ NGINX root folder

**Absolute path example:**
```nginx
location /dash {
    root D:/nginx_server/html;  # Full path, always works
}
```

### 4.2 Alias Directive

#### Cách hoạt động

```nginx
location /dash {
    alias html/dash/;
}
```

Khi request `GET /dash/manifest.mpd`:

1. **Location match:** `/dash`
2. **Alias:** `html/dash/`
3. **Substitution:** Thay thế `/dash` bằng `html/dash/`
4. **Final path:** `html/dash/manifest.mpd` (không thêm `/dash` lần 2)
5. **Absolute:** `D:/nginx_server/html/dash/manifest.mpd`

**Đúng!** Alias directly maps location to folder.

#### Khi nào dùng Alias

- Khi bạn muốn map một location tới thư mục **khác tên**
- Khi thư mục DASH nằm **ngoài** thư mục html
- Ví dụ: location `/media` nhưng folder là `/videos` (thay vì `/html/media`)

```nginx
# Alias example: ngoài html folder
location /media {
    alias /path/to/videos/;
}

# Request: GET /media/video.mp4
# Tìm file tại: /path/to/videos/video.mp4 (KHÔNG /path/to/videos/media/video.mp4)
```

### 4.3 Bảng so sánh Root vs Alias

| Tiêu chí | Root | Alias |
|---------|------|-------|
| **Cách hoạt động** | Append location path | Replace location path |
| **Request `/dash/file.mpd` sẽ tìm tại** | `root + /dash + /file.mpd` | `alias + /file.mpd` |
| **Nên dùng khi** | Folder tên giống location | Folder tên khác location |
| **Ví dụ root** | `root html;` → `html/dash/manifest.mpd` | N/A |
| **Ví dụ alias** | N/A | `alias html/dash/;` → `html/dash/manifest.mpd` |

### 4.4 Cấu hình đúng cho DASH

**Option 1 - Root (tính toán đúng):**
```nginx
server {
    root html;  # Define at server level
    
    location /dash {
        # Inherit root from server level
        add_header 'Access-Control-Allow-Origin' '*';
        types { application/dash+xml mpd; }
    }
}
```

**Option 2 - Alias (explicit):**
```nginx
location /dash {
    alias html/dash/;  # Trailing slash important!
    add_header 'Access-Control-Allow-Origin' '*';
    types { application/dash+xml mpd; }
}
```

**Option 3 - Absolute path (fail-safe):**
```nginx
location /dash {
    root D:/nginx_server/html;  # Full path, no ambiguity
    add_header 'Access-Control-Allow-Origin' '*';
    types { application/dash+xml mpd; }
}
```

---

## Phần 5: CORS & MIME Types

### 5.1 Tại sao CORS quan trọng?

DASH player (ví dụ: dash.js) chạy trong browser (same-origin policy). Nếu:
- Player HTML ở `http://localhost:8080`
- DASH MPD/segments ở `http://localhost:8080/dash`
- **Vẫn cần CORS headers!** Vì browser-based player yêu cầu explicit CORS

### 5.2 CORS Headers cần thiết

```nginx
location /dash {
    alias html/dash/;
    
    # Allow từ bất kỳ origin (*)
    add_header 'Access-Control-Allow-Origin' '*';
    
    # Chỉ định methods cho OPTIONS requests
    add_header 'Access-Control-Allow-Methods' 'GET, HEAD, OPTIONS';
    
    # Allow custom headers (ví dụ Range requests)
    add_header 'Access-Control-Allow-Headers' 'Content-Type, Range';
    
    # Expose headers cho client
    add_header 'Access-Control-Expose-Headers' 'Content-Length, Content-Type';
    
    # Handle OPTIONS requests
    if ($request_method = 'OPTIONS') {
        return 204;  # No content
    }
}
```

### 5.3 MIME Types đầy đủ

```nginx
types {
    # DASH manifest
    application/dash+xml mpd;
    
    # Video segments
    video/mp4 mp4;
    video/mp4 m4v;
    video/mp4 m4p;
    
    # Audio segments  
    audio/mp4 m4a;
    
    # General MP4
    application/mp4 mp4;
    
    # Alternate MIME types (tuỳ chọn)
    video/x-m4v m4v;
}
```

### 5.4 CORS Preflight & Custom Header (⚠️ điểm hay vấp khi player gắn token)

> [UPDATED 2026-06-21] Bổ sung từ case thực tế: player dash.js gắn custom header
> để xác thực segment → bị browser chặn ở preflight.

**Hiện tượng:** player thêm header tùy ý qua `RequestModifier` (dash.js) /
`xhrSetup` (hls.js):
```js
xhr.setRequestHeader('X-Player-Token', 'abcdef123456');
xhr.setRequestHeader('X-Player-Session', '1234567890');
```
→ Lỗi:
```
Access to XMLHttpRequest ... blocked by CORS policy:
Request header field x-player-session is not allowed by
Access-Control-Allow-Headers in preflight response.
```

**Nguyên nhân (by-design của Fetch spec):**
- `X-Player-Token` / `X-Player-Session` là **custom header, KHÔNG thuộc CORS-safelist**
  (safelist gồm `Accept`, `Accept-Language`, `Content-Language`, `Content-Type` giới hạn,
  và `Range` cho range đơn giản).
- Có custom header → browser **bắt buộc gửi preflight `OPTIONS`** trước, kèm
  `Access-Control-Request-Headers: x-player-token, x-player-session`.
- Server **phải đáp** `Access-Control-Allow-Headers` liệt kê đúng các header đó, nếu
  không → browser chặn request thật.
- **Vì sao bỏ 2 dòng `setRequestHeader` thì chạy:** không còn custom header → request
  thành "simple request" (GET + Range đã safelist) → **không có preflight** → không bị
  kiểm tra Allow-Headers.

**Sửa nginx — liệt kê custom header (tên KHÔNG phân biệt hoa/thường):**
```nginx
add_header Access-Control-Allow-Origin   '*' always;
add_header Access-Control-Allow-Methods  'GET, HEAD, OPTIONS' always;
add_header Access-Control-Allow-Headers  'Range, X-Player-Token, X-Player-Session' always;
add_header Access-Control-Expose-Headers 'Content-Length, Content-Range' always;
add_header Access-Control-Max-Age        86400 always;   # cache preflight 1 ngày -> đỡ OPTIONS lặp
```

**Lưu ý quan trọng:**
- **`always`** bắt buộc để header xuất hiện cả trên response lỗi (4xx/5xx) và 204
  preflight — thiếu `always` thì header chỉ ra ở 2xx/3xx.
- **`add_header` KHÔNG kế thừa** xuống `location` nếu location đó tự khai `add_header`
  riêng → đặt CORS ở **server level**, đừng khai lại add_header trong location con.
- **`Access-Control-Max-Age`**: không có thì browser preflight lại rất thường xuyên
  (Chrome cache mặc định ~5s) → mỗi nhóm segment tốn 1 OPTIONS thừa.
- **`Allow-Origin: *` + credentials KHÔNG đi cùng nhau.** Nếu bật `withCredentials`/cookie,
  phải echo đúng origin cụ thể + `Access-Control-Allow-Credentials: true`.
- Thêm header mới ở player → **nhớ cập nhật lại** dòng `Allow-Headers`.

> Header client tự đặt = **token-gated access**, KHÔNG phải DRM. Server (Node qua
> `auth_request`) phải verify thật (HMAC/TTL), không chỉ so chuỗi tĩnh.

---

## Phần 6: Troubleshooting & Best Practices

### 6.1 Lỗi 404 Not Found

**Nguyên nhân:**
- Folder structure sai
- Root/alias path sai
- File không tồn tại

**Debug:**
1. Check nginx error log: `path\to\nginx\logs\error.log`
2. Test config: `nginx -t`
3. Reload: `nginx -s reload`
4. Verify folder: Mở File Explorer, check thực tế file tồn tại

### 6.2 Cấu trúc Thư mục Recommended
D:/nginx_server/
├── conf/
│   └── nginx.conf
├── html/
│   ├── index.html
│   └── dash/
│       ├── manifest.mpd
│       ├── init_v1.mp4
│       └── chunk_v1_1.m4s
│       └── chunk_v1_2.m4s
│       ...
├── logs/
├── temp/
└── nginx.exe
### 6.3 Performance Tips

1. **Enable gzip compression** cho DASH content
2. **Set appropriate cache headers** (Cache-Control)
3. **Monitor bandwidth** với access logs
4. **Consider CDN** cho production (CloudFlare, Akamai, etc.)

---

## Phần 7: Tài liệu Tham khảo Chính thức

### NGINX
- **Official docs:** https://nginx.org/en/docs/
- **HTTP Server module:** https://nginx.org/en/docs/http/ngx_http_core_module.html
- **Windows:** https://nginx.org/en/docs/windows.html

### FFmpeg
- **Official site:** https://ffmpeg.org/
- **DASH documentation:** https://ffmpeg.org/ffmpeg-formats.html#dash
- **Examples:** https://ffmpeg.org/ffmpeg-all.html

### DASH Standard
- **DASH-IF (Industry Forum):** https://dashif.org/
- **MPEG-DASH Specification:** https://www.iso.org/standard/79329.html
- **W3C Media Source Extensions:** https://www.w3.org/TR/media-source/

### DASH Players
- **dash.js (Recommended):** https://github.com/Dash-Industry-Forum/dash.js/wiki
- **Shaka Player:** https://shaka-player-demo.appspot.com/
- **hls.js (HLS, nhưng tương tự):** https://github.com/video-dev/hls.js

---

## Quick Reference

### Folder structure mình đang dùng:
path\to\nginx\html\dash\
### NGINX.conf được recommend:
```nginx
server {
    listen 8080;
    root html;
    
    location /dash {
        add_header 'Access-Control-Allow-Origin' '*';
        types { application/dash+xml mpd; }
    }
}
```

### FFmpeg command:
```bash
ffmpeg -i video.mp4 -c:v libx264 -b:v 2500k -c:a aac -b:a 128k \
  -f dash -seg_duration 4 -use_template 1 -use_timeline 1 \
  -init_seg_name "init_$RepresentationID$.mp4" \
  -media_seg_name "chunk_$RepresentationID$_$Number$.m4s" \
  dash/manifest.mpd
```

### Kiểm tra NGINX:
```bash
nginx -t          # Test config
nginx -s reload   # Reload config
tasklist /fi "imagename eq nginx.exe"  # Check process
```

---

## Changelog
- **2026-06-25** — (b) Tạo **`nginx-config-operations-guide.md`** — **vá reference treo** từ
  changelog 2026-06-21 (file vận hành/config trước đó chỉ được trỏ tới mà chưa tồn tại).
  Nội dung: path resolve theo **prefix** (relative path được phép, không cần absolute);
  **fail-fast by-design** + nginx **không tự mkdir** `logs/`/`temp/` (nguyên nhân `[emerg]`
  không chạy); bẫy `error_log off` → tạo file tên "off" (dùng `nul/dev/null crit`);
  `include .../*.conf` wildcard khớp 0 file = OK vs literal thiếu = lỗi.
- **2026-06-25** — (a) Phân tích **cơ chế + số liệu kiểm chứng** vì sao nginx phù hợp serve
  DASH (event-driven C10K, sendfile zero-copy, thread pool 9x: 1→9.5 Gbps, Netflix 400/800
  Gbps, cảnh báo by-design bản Windows beta) → tách sang file riêng
  **`nginx-streaming-mechanism-and-benchmarks.md`** (góc mechanism/benchmark; file này giữ
  góc how-to/config). Nội dung cũ giữ nguyên.
- **2026-06-21** — Thêm **§5.4 CORS Preflight & Custom Header** (case dash.js gắn
  `X-Player-Token`/`X-Player-Session` bị chặn preflight): cơ chế preflight, cách khai
  `Access-Control-Allow-Headers`, `Access-Control-Max-Age`, bẫy `always` +
  add_header không kế thừa. Đính chính ngầm: gzip KHÔNG nên áp cho m4s/mp4 (xem file
  `nginx-config-operations-guide.md`). Nội dung cũ giữ nguyên.
  → File chi tiết vận hành/config nginx cho dự án (central/sub, two-port, upstream,
  auth_request, Windows test): xem **`nginx-config-operations-guide.md`**.