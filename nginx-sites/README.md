# nginx-sites — config thả một file là chạy

Hai bản tự chứa, dẫn xuất từ `streamingVer3` (bản chuẩn hiện hành). Mỗi file gộp
sẵn `upstream` + server `:80` (control plane) + server `:9150` (data plane, có
`auth_request`), nên **không phải sửa `nginx.conf` chính**.

| File | Dùng khi |
|---|---|
| `stream-sub-linux.conf` | VM Linux, một sub node |
| `stream-sub-windows.conf` | Máy dev Windows, một sub node |

**Chỉ cần sửa một dòng**: `root` ở server `:9150` — trỏ vào **thư mục gốc repo**,
không phải thư mục `videos` (URL contract đã chứa sẵn `/videos/`).

## Trước khi cài — kiểm tra module

```bash
nginx -V 2>&1 | grep -o with-http_auth_request_module
```

Không in ra gì nghĩa là bản nginx đó **không có** `ngx_http_auth_request_module`.
Hậu quả không phải "auth không chạy" mà là `[emerg] unknown directive
"auth_request"` — **nginx không khởi động được**. Đã xác nhận bản
`Working-Window-NGINX-Streaming-Server/NGINX.exe` (nginx 1.17.10) thiếu module này.

Ubuntu/Debian: `nginx-full` và `nginx-extras` có sẵn, `nginx-light` **không**.

## Linux

```bash
sudo rm -f /etc/nginx/sites-enabled/default
```

```bash
sudo cp stream-sub-linux.conf /etc/nginx/sites-enabled/stream-sub.conf
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

Phải xoá site `default` của distro vì nó đã chiếm `listen 80 default_server` —
hai `default_server` cùng cổng là `[emerg] duplicate`, nginx không khởi động.

Sau khi chạy, nhớ quyền cho worker `www-data`: `sudo chmod o+x /home/ubuntu`.
Thiếu bước này ra **403** (không phải 404), log ghi `Permission denied`. Thư mục
`videos/` nằm trong `.gitignore` nên không có sau `git clone` — phải `mkdir`.

## Windows

Windows không có `sites-enabled` (đó là quy ước đóng gói của Debian/Ubuntu, không
phải của nginx). Tạo một lần:

```bash
mkdir D:\nginx\conf\sites-enabled D:\nginx\logs D:\nginx\temp
```

```bash
copy stream-sub-windows.conf D:\nginx\conf\sites-enabled\
```

Thêm đúng một dòng vào cuối khối `http { }` trong `D:\nginx\conf\nginx.conf`:

```nginx
include sites-enabled/*.conf;
```

> **Viết sai dòng này là lỗi số 1 khiến "nginx chạy mà stream không lên."** Cả ba
> kiểu sai dưới đây đều **không** làm `nginx -t` fail, vì với nginx thì glob khớp
> 0 file là hợp lệ:
>
> | Sai | Chuyện gì xảy ra |
> |---|---|
> | `include /sites-enabled/*.conf;` | dấu `/` đầu = **tuyệt đối** → tìm ở gốc ổ đĩa, khớp 0 file, im lặng bỏ qua |
> | `include sites-enabled/*;` | thiếu `.conf` → trên Windows `*` khớp cả `.` và `..` → `[error] ReadFile() "..\.." failed` |
> | `include D:\nginx\conf\sites-enabled\*;` | **backslash là ký tự escape của nginx**, `\n` thành newline thật → `[emerg]` |
>
> Đúng = **tương đối + dấu `/` xuôi + đuôi `.conf`**. `include` giải đường dẫn
> tương đối theo *thư mục chứa file config*, khác `root`/`error_log` (giải theo
> prefix `-p`).

Xác minh file đã thật sự được nạp — `nginx -t` **không** trả lời được câu này:

```bash
D:\nginx\nginx.exe -p D:/nginx -T | findstr "configuration file"
```

Không thấy tên file site trong danh sách nghĩa là `include` chưa trỏ tới nó, bất
kể `-t` nói gì.

```bash
D:\nginx\nginx.exe -p D:/nginx -t
```

Đọc **cả dòng `[warn]`**, không chỉ nhìn chữ `successful` ở cuối. `[warn]
conflicting server name "localhost" on 0.0.0.0:80, ignored` nghĩa là có một
server block chết lặng — thường do quên tắt server "Welcome to nginx" mặc định,
hoặc do copy khối `:80` cho sub node thứ hai. Một cổng + một `server_name` chỉ
thuộc về một block; node thứ hai phải đổi sang `:81`.

nginx **không tự tạo thư mục** — thiếu `logs/` hoặc `temp/` là `[emerg]`. Và nginx
trên Windows **không tự tắt process cũ**: chạy lần hai khi chưa stop sẽ ra
`bind() ... failed (10048)`, thủ phạm là chính nginx cũ (`tasklist | findstr nginx`).

## Chạy nhiều sub node trên một máy

Copy khối `upstream` + hai `server` trong file rồi sửa **bốn** thứ — không phải ba:

| Sửa | Node 1 | Node 2 |
|---|---|---|
| `upstream` (tên phải khác) | `stream_sub_node1` → `127.0.0.1:9100` | `stream_sub_node2` → `127.0.0.1:9200` |
| cổng nginx data plane | `listen 9150` | `listen 9250` |
| **cổng nginx control plane** | `listen 80` | **`listen 81`** |
| `root` | repo của node 1 | **repo khác** của node 2 |

Hai dòng in đậm là chỗ hay sai nhất:

- **Cổng `:80`**: một máy chỉ có một cổng 80. Để cả hai node cùng `listen 80;
  server_name localhost;` thì nginx chỉ `[warn] conflicting server name ...
  ignored` và node thứ hai không bao giờ nhận request — `nginx -t` vẫn báo
  `successful`.
- **`root`**: trỏ hai node vào **cùng một** thư mục repo là sai về mặt kiến trúc,
  dù stream vẫn chạy. Hai node lúc đó dùng chung một `videos/`, nên test
  replicate mất hết ý nghĩa (bên nhận đã "có sẵn" file trước khi truyền). Dùng
  hai checkout riêng, ví dụ `Stream-Sub-Server` và `Stream-Sub-Server2`.

Nếu cần từ 3 node trở lên, dùng bộ `nginx-windows/` — nó tách thân chung ra
`stream-node-body.conf` nên thêm node chỉ là copy một file nhỏ và sửa 3 giá trị.

## Quan hệ với các file config khác

| File | Trạng thái |
|---|---|
| `streamingVer3` + `nginx_subVer3.conf` | **Bản chuẩn deploy Linux**, nơi đọc để hiểu lý do từng dòng |
| `nginx-sites/*` | Bản tự chứa, thả một file là chạy (file này) |
| `nginx-windows/` | Nhiều sub node song song trên một máy Windows (`:9150`/`:9250`/`:9350`) |
| `nginx.conf`, `streamingVer2`, `nginx_sub.conf`, `site-enabled-streaming` | **LEGACY** — giữ để tham chiếu, không dùng deploy mới |

## Bật auth thật

Config đã nối sẵn `auth_request` → `/api/auth/verify` của Node. Công tắc nằm ở
`AUTH_MODE` trong `config.env` của Node, **không phải ở nginx**:

| `AUTH_MODE` | Hành vi |
|---|---|
| `off` (mặc định) | luôn cho qua |
| `log` | vẫn cho qua nhưng đếm số request *lẽ ra* bị chặn |
| `enforce` | chặn thật 401/403 |

Đọc `GET /api/auth/stats` ở mode `log` trước khi sang `enforce`. Chi tiết đầy đủ:
[`markdowns/ott-playback-token-auth.md`](../markdowns/ott-playback-token-auth.md).

> Nếu tắt auth, phải comment **cả cụm** — `auth_request`, `auth_request_set` và
> `location = /__auth`. Bỏ location mà giữ `auth_request` là tái tạo đúng cái bẫy
> đã gỡ khỏi `nginx.conf` legacy: `nginx -t` vẫn PASS, auth không chặn gì, mà mỗi
> segment vẫn tốn một subrequest chắc chắn hỏng.
