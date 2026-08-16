# nginx cho Windows — chạy nhiều sub node cùng lúc

Bộ config để test **nhiều sub node song song trên 1 máy dev Windows**
(`:9150`, `:9250`, `:9350`...), tách hẳn khỏi bộ deploy Linux
(`nginx_subVer3.conf` + `streamingVer3`).

## Cấu trúc

```
<nginx>/conf/
├── nginx.conf                  ← main. Không có user/pid kiểu Linux
├── stream-common.conf          ← types + gzip + log. Nạp ở http level
├── stream-node-body.conf       ← THÂN CHUNG: location / , @serve, /__auth, CORS
└── stream-nodes/
    ├── sub1.conf               ← :9150 → Node :9100
    ├── sub2.conf               ← :9250 → Node :9200
    └── sub3.conf               ← :9350 → Node :9300
```

Nguyên tắc: **cái gì giống nhau nằm ở `stream-node-body.conf`, cái gì khác nhau
nằm ở `stream-nodes/subN.conf`.** Mỗi file node chỉ có đúng 3 giá trị riêng —
`listen`, `$node_api`, `root`.

## Cài đặt

1. Tải nginx bản Windows từ <https://nginx.org/en/download.html>, giải nén ra ví dụ `D:\nginx`.
2. Chép nội dung thư mục này vào `D:\nginx\conf\` (đè `nginx.conf` mặc định).
3. Tạo sẵn 2 thư mục — **nginx không tự tạo, thiếu là `[emerg]` không khởi động được**:

```bash
mkdir D:\nginx\logs D:\nginx\temp
```

4. Sửa `root` trong từng `stream-nodes/subN.conf` cho khớp máy bạn, xoá file của
   node nào chưa dùng.

## Chạy

```bash
D:\nginx\nginx.exe -p D:/nginx -t
```

```bash
D:\nginx\nginx.exe -p D:/nginx
```

```bash
D:\nginx\nginx.exe -p D:/nginx -s reload
```

```bash
D:\nginx\nginx.exe -p D:/nginx -s stop
```

`-p` neo prefix một lần, để mọi đường dẫn tương đối bên trong (`logs/`, `temp/`)
tính từ đó — đỡ phải hardcode absolute khắp nơi.

> nginx trên Windows **không tự tắt process cũ**. Chạy `nginx.exe` lần thứ hai khi
> lần đầu chưa stop sẽ ra `bind() to 0.0.0.0:9150 failed (10048)` (cổng đang bị
> chiếm bởi chính nginx cũ). Kiểm tra bằng `tasklist | findstr nginx`.

## Thêm node thứ 4

```bash
copy D:\nginx\conf\stream-nodes\sub1.conf D:\nginx\conf\stream-nodes\sub4.conf
```

Mở `sub4.conf`, sửa đúng 3 dòng: `listen 9450;`, `set $node_api 127.0.0.1:9400;`,
`root D:/gitrepos/Stream-Sub-Server-4;` rồi `-t` và `-s reload`. Không đụng file nào khác.

Công thức cổng lấy từ `server.js`: `PORT + SERVERINDEX * SERVERREP`
(`9000 + N*100`), nên `SERVERINDEX=N` → Node `:9N00` → nginx `:9N50`.
Mỗi bản clone phải có `config.env` riêng với `SERVERINDEX` khác nhau, nếu không
node thứ hai sẽ chết vì `EADDRINUSE`.

## Kiểm tra nhanh

```bash
curl -i http://localhost:9150/videos/<ten-video>/init.mpd
```

Đọc header trả về:

| Header/kết quả | Ý nghĩa |
|---|---|
| `X-Sub-Node: 9150` | request đi đúng node mong muốn |
| `Content-Type: application/dash+xml` | bảng `types` đã nạp đúng |
| `404` | sai `root` hoặc file chưa tồn tại (`try_files` không tìm thấy) |
| `401` / `403` | auth chặn — xem cột lý do bằng `curl -i .../api/auth/verify` |
| `500` | Node chết **và** `error_page` fail-open đã bị xoá |

## Auth

nginx gọi `http://127.0.0.1:<node>/api/auth/verify` cho **mỗi** request file.
Mức siết điều khiển bằng `AUTH_MODE` trong `config.env` của từng Node — không
phải sửa nginx:

| `AUTH_MODE` | Hành vi | Dùng khi |
|---|---|---|
| `off` (mặc định) | luôn 204 | chưa có Central phát token |
| `log` | vẫn cho qua, nhưng đếm số request lẽ ra bị chặn | trước khi siết, để đo tỉ lệ chặn nhầm |
| `enforce` | chặn thật bằng 401/403 | khi `log` đã sạch |

```bash
curl http://localhost:9100/api/auth/stats
```

Đổi mode xong nhớ `pm2 restart server --update-env` (hoặc restart tay) — Node chỉ
đọc `config.env` lúc khởi động.

## Vì sao không dùng chung file với bản Linux

| | Linux (VM) | Windows (dev) |
|---|---|---|
| `user www-data` | cần, và kéo theo cả lớp lỗi 403 do quyền thư mục | không hỗ trợ, worker chạy bằng user đang đăng nhập |
| `pid /run/nginx.pid` | đúng chuẩn systemd | `/run` không tồn tại |
| `sites-enabled/` | quy ước của gói Debian/Ubuntu | không có |
| `sendfile on` | có tác dụng thật | không có sendfile() tương đương |
| Số node | 1 node/VM | nhiều node/máy, phân biệt bằng cổng |

Vì 4 dòng đầu bảng, một file config dùng chung sẽ luôn thừa/thiếu ở một trong hai
phía. **Chạy được trên Windows không chứng minh được gì về Linux** — đặc biệt là
nhóm lỗi phân quyền, thứ Windows không bao giờ tái hiện.
