# NGINX — Hướng dẫn Vận hành & Config (đường dẫn, log, include, fail-fast)

**Tạo:** 2026-06-25
**Mục đích:** Vận hành/config nginx cho dự án (path resolution, tắt log, include
site-enabled, vì sao nginx refuse-to-start). Bổ trợ:
- [[NGINX_FFmpeg DASH Streaming]] — config DASH/CORS/auth_request (how-to)
- [[nginx-streaming-mechanism-and-benchmarks]] — cơ chế/benchmark (why)

> File này vá reference bị treo từ changelog 2026-06-21 của
> `NGINX_FFmpeg DASH Streaming.md` (đã trỏ tới `nginx-config-operations-guide.md`
> nhưng file chưa từng tạo).

---

## 0. TL;DR
- nginx **KHÔNG bắt buộc absolute path** — relative path được phép, resolve theo **prefix**.
- Tạm tắt log được: `access_log off;`. **`error_log off;` là BẪY** → tạo file tên "off".
- `include .../*.conf` khớp 0 file = **OK**; `include file-literal.conf` thiếu = **`[emerg]`**.
- **Không có lenient mode**: nginx **cố ý fail-fast** (validate toàn bộ config khi start, sai
  thì refuse-to-start). By-design, không phải bug.
- nginx **KHÔNG tự tạo thư mục** (`logs/`, `temp/`) → thiếu dir = `[emerg]`, phải mkdir trước.
- **`nginx -t` PASS ≠ config đúng** — nó chỉ check cú pháp/ngữ nghĩa tĩnh, KHÔNG check `root` có
  tồn tại, worker có quyền đọc, `auth_request` có location tương ứng, hay còn đủ server block
  hay không (§6).

---

## 1. Đường dẫn tương đối — giải theo "prefix" (KHÔNG theo CWD)

nginx không có khái niệm current-working-directory như shell. Mọi relative path
(`root`, `alias`, `include`, `access_log`, `error_log`, `pid`, ...) tính theo **prefix**.

Prefix quyết theo thứ tự:
1. Cờ runtime `nginx -p <prefix>` (ưu tiên cao nhất).
2. Compile-time `--prefix=...` — xem bằng `nginx -V` (dòng `configure arguments`).

Windows: prefix mặc định = **thư mục chứa `nginx.exe`**. Nên `root html;` =
`<nginx-dir>/html`, `logs/access.log` = `<nginx-dir>/logs/access.log`.

Neo prefix một lần thay vì hardcode absolute khắp nơi:
```bash
nginx -p D:/nginx_server -c conf/nginx.conf
```
→ tất cả relative path bên trong tính từ `D:/nginx_server`.

Absolute path vẫn dùng được khi muốn chắc chắn:
```nginx
root D:/nginx_server/html;
```

---

## 2. Fail-fast by-design — vì sao "báo lỗi & không chạy luôn"

**Triết lý:** nginx là production server; "chạy với config sai" nguy hiểm hơn "không
chạy" (serve nhầm file, hở bảo mật, sai upstream). Nên nginx **parse + validate TOÀN BỘ
config khi start**; 1 lỗi → `[emerg]` + **refuse to start**. Với `reload`, process cũ
được **giữ nguyên** nếu config mới lỗi (không bao giờ rơi vào trạng thái nửa vời). Đây là
**fail-closed**, ngược mô hình `.htaccess` "lỏng" của Apache.

**Hệ quả quan trọng nhất — nginx KHÔNG tự mkdir:**
```
[emerg] open() "D:/nginx_server/logs/error.log" failed (2: No such file or directory)
```
→ thiếu `logs/` (và thường cả `temp/`). Phải tạo trước:
```bash
mkdir D:/nginx_server/logs D:/nginx_server/temp
```

Luôn validate trước khi chạy / reload:
```bash
nginx -t            # in đúng dòng/khối lỗi
nginx -s reload     # chỉ reload khi -t pass
```

---

## 3. Tạm không ghi log (có bẫy error_log)

**Access log — tắt sạch:**
```nginx
access_log off;
```

**Error log — KHÔNG có cú pháp "off":**
```nginx
error_log off;      # SAI: tạo FILE tên "off" trong prefix!
```
Cách đúng (trỏ null + chỉ log thảm hoạ):
```nginx
error_log /dev/null crit;   # Linux
error_log nul crit;         # Windows
```
Phải có ≥1 `error_log` ở main context. An toàn khi test trên Windows:
```nginx
error_log  nul crit;
http {
    access_log off;
    # ...
}
```

---

## 4. include site-enabled — wildcard vs literal

| Cú pháp | Khi không tồn tại | Kết quả |
|---|---|---|
| `include sites-enabled/*.conf;` | glob khớp 0 file | **OK** (bỏ qua) |
| `include sites-enabled/*;` | dir tồn tại nhưng rỗng | **OK** |
| `include sites-enabled/site.conf;` | file literal thiếu | **`[emerg]`** |

→ Dùng **wildcard** cho site-enabled để tự bỏ qua khi rỗng.
→ `sites-available`/`sites-enabled` là **quy ước Debian/Ubuntu packaging**, KHÔNG phải mặc
định nginx gốc. Bản tự tải/Windows không có sẵn — tự tạo `include` nếu muốn.

### 4.1 [UPDATED 2026-08-15] Mặt trái của wildcard: **nạp 0 file cũng là "OK"**

Bảng trên nói "glob khớp 0 file → OK (bỏ qua)". Tiện khi thư mục rỗng, nhưng đó cũng chính là
cách **hỏng im lặng** khó tìm nhất trong cả bộ config: đường dẫn `include` sai → khớp 0 file →
`nginx -t` báo `syntax is ok` → nginx chạy bình thường → mà **toàn bộ site không tồn tại**.
Triệu chứng ở tầng trên là "nginx sống mà stream 404 / connection refused ở cổng site".

`include` có luật đường dẫn **KHÁC** mọi directive còn lại (đối chiếu §1):

| | Giải tương đối theo |
|---|---|
| `include` | **thư mục chứa file config** (`<nginx>/conf/`) |
| `root`, `error_log`, `access_log`, `pid` | **prefix** (`<nginx>/`, đổi được bằng `-p`) |

Bốn cách viết sai đã gặp thật, cả bốn đều **không** làm `nginx -t` fail:

| Viết | Chuyện gì xảy ra |
|---|---|
| `include /nginx-sites/*;` | Dấu `/` đầu = **tuyệt đối** → tìm ở gốc ổ đĩa, khớp 0 file → im lặng bỏ qua |
| `include nginx-sites/*;` | Trên Windows `*` khớp cả `.` và `..` → `[error] ReadFile() ".../nginx-sites/.." failed (1: Incorrect function)` |
| `include D:\nginx-1.28.0\conf\nginx-sites\*;` | **Backslash là ký tự escape của nginx**: `\n` thành newline thật → `[emerg] FindFirstFile() "D:` + xuống dòng + `ginx-1.28.0..." failed (123)` |
| `include nginx-sites/*.conf;` | ✅ đúng: tương đối + `/` xuôi + đuôi `.conf` (đuôi giúp không khớp `.` và `..`) |

**Kiểm tra bắt buộc — `nginx -t` KHÔNG trả lời được câu này, phải dùng `-T` (hoa):**

```bash
nginx -T 2>/dev/null | grep "^# configuration file"
```

In ra đúng danh sách file nginx **thật sự** đã nạp. Không thấy file site trong đó = `include`
chưa trỏ tới nó, bất kể `-t` nói gì.

```bash
nginx -T 2>/dev/null | grep -E "^ *listen |^ *root "
```

**Ca thật (2026-08-15, `D:/nginx-1.28.0`):** `include /nginx-sites/*;` → `-T` chỉ có `nginx.conf`
và `mime.types`, không có `listen 9150` nào. nginx chạy, `-t` successful, `curl :9150` connection
refused. Sửa thành `include nginx-sites/*.conf;` là xong.

### 4.2 [UPDATED 2026-08-15] `server_name` trùng trên cùng cổng — chỉ là `[warn]`

Hai `server` block cùng `listen 80` **và** cùng `server_name localhost` là hợp lệ về cú pháp.
nginx chỉ cảnh báo rồi cho block **đầu tiên** thắng:

```
nginx: [warn] conflicting server name "localhost" on 0.0.0.0:80, ignored
```

`nginx -t` vẫn kết luận `test is successful`, nên rất dễ lướt qua — trong khi hậu quả là một
server block **không bao giờ nhận được request nào**. Hay gặp khi:

- quên tắt server mặc định "Welcome to nginx" của bản tải về, rồi thêm site của mình;
- chạy nhiều sub node trên một máy dev và copy-paste khối `:80` cho từng node.

Một cổng + một `server_name` chỉ thuộc về **một** block. Ba cách tách: đổi cổng (`:81`, `:82`),
đổi `server_name` + trỏ hosts file, hoặc bỏ hẳn block thừa. Luôn đọc kỹ dòng `[warn]` của
`nginx -t` chứ không chỉ nhìn chữ `successful` ở cuối.

---

## 5. Recipe "nginx dễ tính hơn khi test" (không bỏ qua được lỗi config)

Không thể bắt nginx ignore lỗi, nhưng giảm số thứ bắt buộc tồn tại:
1. Tạo sẵn `logs/` + `temp/` (nginx không mkdir).
2. `access_log off;` + `error_log nul crit;` (Windows) → bớt phụ thuộc file log.
3. `include .../*.conf` (wildcard) thay vì liệt kê file literal.
4. Relative path + set prefix một lần bằng `-p`, tránh hardcode absolute khắp nơi.
5. `nginx -t` trước mỗi lần `nginx` / `nginx -s reload`.

Block test tối giản trên Windows:
```nginx
# nginx -p D:/nginx_server -c conf/nginx.conf
error_log nul crit;
events { worker_connections 1024; }
http {
    access_log off;
    include    mime.types;
    server {
        listen 8080;
        root   html;            # = D:/nginx_server/html
        location /dash {
            types { application/dash+xml mpd; }
            add_header Access-Control-Allow-Origin '*' always;
        }
    }
}
```
⚠️ Vẫn phải `mkdir D:/nginx_server/temp` (nginx cần temp dirs cho proxy/fastcgi/client_body).

---

## 6. Ranh giới của `nginx -t` — cái nó KHÔNG bao giờ kiểm tra

`nginx -t` load config y hệt lúc start (parse toàn bộ, resolve `include`, khởi tạo module) rồi
thoát. Nên nó bắt rất chắc **lỗi ngôn ngữ config**: sai directive, thiếu `;`, thừa `}`, directive
đặt sai context, `include` file literal không tồn tại, port trùng `listen`... Nhưng theo thiết kế,
nó **không chạm vào request thật nào**, nên toàn bộ nhóm lỗi dưới đây lọt qua 100%:

| `nginx -t` KHÔNG check | Lỗi lộ ra lúc nào | Triệu chứng |
|---|---|---|
| `root`/`alias` có tồn tại trên đĩa không | request đầu tiên | `404` (path Windows còn sót trên VM Linux là ca kinh điển — bị coi là relative rồi ghép vào prefix) |
| worker (`user www-data`) có quyền đọc/traverse không | request đầu tiên | `403` + `Permission denied` trong `error.log` |
| URI trong `auth_request` có `location` tương ứng không | request đầu tiên | đệ quy subrequest → `subrequests cycle` → `500` |
| `proxy_pass` upstream có sống không | request đầu tiên | `502` (đúng và rõ ràng — đừng che bằng `error_page`) |
| **Còn đủ server block như bản trước không** | không bao giờ | im lặng — "không có server nào nghe `:80`" là trạng thái **hợp lệ** |
| **`include` có nạp được file nào không** | không bao giờ | im lặng — glob khớp 0 file là **hợp lệ** (§4.1). Site biến mất hoàn toàn mà `-t` vẫn "successful" |
| `server_name` trùng trên cùng cổng | không bao giờ | chỉ `[warn] conflicting server name`, block thứ hai chết lặng (§4.2) |

Ô cuối là nguy hiểm nhất khi refactor (tách/gộp file config), vì không có tín hiệu lỗi nào cả.
Checklist bắt buộc sau mỗi lần đổi cấu trúc file config — **so danh sách listen trước/sau**:
```bash
sudo ss -tlnp | grep nginx      # nguồn sự thật DUY NHẤT về "đang nghe cổng nào"
sudo nginx -T | grep -nE 'listen|root|server_name'   # -T (hoa) = dump config sau khi gộp mọi include
```
`nginx -T` đặc biệt hữu ích khi config trải trên nhiều file: nó in ra **config hợp nhất thật sự**
mà nginx nhìn thấy, tránh việc đọc từng file rồi tự ghép nhầm trong đầu.

Ca thực tế đầy đủ (5 lỗi cùng lúc, `-t` pass hết) → [[deployment-hidden-bugs-and-pitfalls]] mục 8.

---

## 7. [UPDATED 2026-08-15] Module không được biên dịch — nhóm lỗi `-t` **fail thẳng**

§6 nói về lỗi lọt qua `nginx -t`. Nhóm này ngược lại: `-t` chặn ngay, nhưng thông báo dễ bị đọc
sai thành "config viết sai".

```
nginx: [emerg] unknown directive "auth_request" in .../stream-sub.conf:134
```

"Unknown directive" ở đây **không có nghĩa là gõ sai tên**. Nghĩa là bản nginx đang chạy
**không được biên dịch** module cung cấp directive đó. nginx là kiến trúc module biên dịch tĩnh:
directive nào không có module tương ứng thì parser không biết nó tồn tại.

Kiểm tra bản đang dùng có gì:

```bash
nginx -V 2>&1 | tr ' ' '\n' | grep with-http
```

```bash
nginx -V 2>&1 | grep -o with-http_auth_request_module
```

Không in ra gì = không có module. Các module hay thiếu trong ngữ cảnh dự án này:

| Directive | Module | Mặc định |
|---|---|---|
| `auth_request` | `ngx_http_auth_request_module` | **KHÔNG** build sẵn — cần `--with-http_auth_request_module` |
| `stub_status` | `ngx_http_stub_status_module` | **KHÔNG** build sẵn |
| `sub_filter` | `ngx_http_sub_module` | **KHÔNG** build sẵn |
| `gzip` | `ngx_http_gzip_module` | có sẵn |

Nguồn gói:

- Ubuntu/Debian: `nginx-full` và `nginx-extras` có `auth_request`; **`nginx-light` không có**.
- Tự build: thêm cờ vào `./configure`.
- Windows: bản tải từ nginx.org khác nhau tuỳ phiên bản — **luôn kiểm tra `-V` trước**.

**Ca thật (2026-08-15):** `Working-Window-NGINX-Streaming-Server/NGINX.exe` — nginx 1.17.10 —
thiếu `ngx_http_auth_request_module`. Hậu quả không phải "auth không chạy" mà là nginx **không
khởi động được**, tức mất luôn cả lớp serve file. Đây là lý do phải chạy `nginx -t` trên **đúng
binary sẽ dùng để chạy**, không phải trên một nginx khác trong máy.

Mẹo khi cần tách bạch "sai cú pháp" với "thiếu module": comment tạm cụm directive nghi ngờ rồi
`-t` lại. Pass = thiếu module; vẫn fail = lỗi cú pháp thật.

---

## References (truy cập 2026-06-25)
- nginx docs, *Command-line parameters* (`-p`, `-c`, `-t`) — https://nginx.org/en/docs/switches.html
- nginx docs, *ngx_http_core_module* (root/alias/access_log) — https://nginx.org/en/docs/http/ngx_http_core_module.html
- nginx docs, *ngx_http_log_module* (access_log off) — https://nginx.org/en/docs/http/ngx_http_log_module.html
- nginx docs, *Core* (error_log) — https://nginx.org/en/docs/ngx_core_module.html#error_log
- nginx docs, *include* — https://nginx.org/en/docs/ngx_core_module.html#include
- nginx docs, *nginx for Windows* — https://nginx.org/en/docs/windows.html

---

## Changelog
- **2026-08-15b** — Thêm §4.1 và §4.2 từ ca debug thật `D:/nginx-1.28.0`. §4.1: mặt trái của
  wildcard — `include` sai đường dẫn khớp 0 file là **hợp lệ**, nên site biến mất mà `nginx -t`
  vẫn "successful"; bảng 4 cách viết sai đã gặp (dấu `/` đầu làm nó thành tuyệt đối; `*` khớp
  `.`/`..` trên Windows; backslash bị nginx hiểu là ký tự escape nên `\n` thành newline); luật
  đường dẫn của `include` khác mọi directive khác (theo thư mục chứa config, không theo prefix);
  và `nginx -T | grep "^# configuration file"` là cách duy nhất xác minh. §4.2: `server_name`
  trùng trên cùng cổng chỉ là `[warn]` nhưng làm một server block chết lặng. Bổ sung 2 dòng
  tương ứng vào bảng §6.
- **2026-08-15** — Thêm §7: nhóm lỗi `[emerg] unknown directive` do **module không được biên dịch**
  (đối lập với §6 — ở đây `-t` fail thẳng nhưng thông báo dễ bị đọc nhầm thành lỗi cú pháp). Bảng
  module hay thiếu (`auth_request`, `stub_status`, `sub_filter`), cách kiểm tra bằng `nginx -V`,
  khác biệt `nginx-light` vs `nginx-full`, và mẹo tách "thiếu module" khỏi "sai cú pháp". Nguồn:
  ca thật nginx 1.17.10 bản Windows trong repo thiếu `ngx_http_auth_request_module`.
- **2026-08-09** — Thêm §6: ranh giới của `nginx -t` (bảng 5 nhóm lỗi runtime lọt qua config test:
  `root` không tồn tại, thiếu quyền worker, `auth_request` trỏ location không có, upstream chết,
  và mất server block khi refactor), kèm checklist `ss -tlnp` + `nginx -T`. Bổ sung 1 gạch đầu
  dòng tương ứng ở TL;DR. Nguồn: ca deploy thật Ver3 của `Stream-Sub-Server` (2026-07-25).
- **2026-06-25** — Tạo file (vá reference treo). Path resolution theo prefix; fail-fast
  by-design + nginx không mkdir (emerg log dir); bẫy `error_log off` → file "off"; include
  wildcard vs literal; recipe test Windows. Nguồn: nginx.org docs.
