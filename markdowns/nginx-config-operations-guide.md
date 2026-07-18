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

## References (truy cập 2026-06-25)
- nginx docs, *Command-line parameters* (`-p`, `-c`, `-t`) — https://nginx.org/en/docs/switches.html
- nginx docs, *ngx_http_core_module* (root/alias/access_log) — https://nginx.org/en/docs/http/ngx_http_core_module.html
- nginx docs, *ngx_http_log_module* (access_log off) — https://nginx.org/en/docs/http/ngx_http_log_module.html
- nginx docs, *Core* (error_log) — https://nginx.org/en/docs/ngx_core_module.html#error_log
- nginx docs, *include* — https://nginx.org/en/docs/ngx_core_module.html#include
- nginx docs, *nginx for Windows* — https://nginx.org/en/docs/windows.html

---

## Changelog
- **2026-06-25** — Tạo file (vá reference treo). Path resolution theo prefix; fail-fast
  by-design + nginx không mkdir (emerg log dir); bẫy `error_log off` → file "off"; include
  wildcard vs literal; recipe test Windows. Nguồn: nginx.org docs.
