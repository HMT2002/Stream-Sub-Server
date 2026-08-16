# Stream-Sub-Server

## Data-plane không DB (2026-07-19)

Sub nhận đủ metadata upload/replication v2 từ Central, chỉ xử lý filesystem, FFmpeg và truyền file; entrypoint active không còn kết nối MongoDB. Xem [`markdowns/upload-replication-contract-v2.md`](markdowns/upload-replication-contract-v2.md).

## Playback auth (2026-08-09)

nginx `:9150` hỏi Node qua `auth_request` → `GET /api/auth/verify` cho **mỗi** request file.
Mức siết đặt bằng `AUTH_MODE` trong `config.env`: `off` (mặc định) → `log` (vẫn cho qua nhưng
đếm số request lẽ ra bị chặn, xem `/api/auth/stats`) → `enforce` (chặn thật bằng 401/403).
Bảng đầy đủ 12 kiểm tra và ý nghĩa từng mã trả về:
[`markdowns/ott-playback-token-auth.md`](markdowns/ott-playback-token-auth.md).

## Test nhiều sub node trên Windows

[`nginx-windows/`](nginx-windows/) là bộ config riêng để chạy song song `:9150`, `:9250`,
`:9350`... trên một máy dev — thêm node mới = copy 1 file, sửa 3 số. Xem
[`nginx-windows/README.md`](nginx-windows/README.md). Bộ này **không** dùng để deploy Linux.

## Xác thực node-to-node (2026-08-16)

Đặt **cùng một** `NODE_SHARED_SECRET` ở Sub và Central, rồi siết dần:

```bash
curl -s localhost:9100/api/default/node-auth
```

`off` → `log` (đọc tới khi `wouldDeny = 0`) → `enforce`. Bật thẳng `enforce` là cắt liên lạc với
mọi Central/FE chưa cập nhật.

Có **hai** loại chữ ký, không hoán đổi được: Central/Sub ký từng request (có timestamp chống phát
lại), còn FE thì **không ký** — nó là trình duyệt, không giữ được khoá. Chunk upload dùng token
phiên do Central ký sẵn và FE chỉ chuyển tiếp. Chi tiết:
[`platform/nodeAuth.js`](platform/nodeAuth.js).

## Media chỉ đi qua nginx (2026-08-16)

Node **không** phục vụ file media nữa — mọi request `.m4s`/`.mpd`/`.vtt`/`.png` tới Node `:9100`
nhận **410 Gone**. Đường phát duy nhất là nginx `:9150`, và chỉ đường đó mới đi qua `auth_request`
→ token check → danh sách chặn. Van xả: `MEDIA_SERVING=on`. Kiểm tra còn ai gọi sai cửa:

```bash
curl -s localhost:9100/api/default/data-plane
```

**Chặn phát bất cứ lúc nào** — có hiệu lực ở request segment kế tiếp, không cần reload nginx,
không cần restart Node, và **chặn thật kể cả khi `AUTH_MODE=off`**:

```bash
curl -s -X POST localhost:9100/api/v2/playback/blocks -H 'Content-Type: application/json' -d '{"type":"storageKey","value":"<storageKey>","reason":"go theo yeu cau"}'
```

Thử trước khi chặn thật:

```bash
curl -s 'localhost:9100/api/v2/playback/probe?uri=/videos/<storageKey>/init.mpd'
```

Danh sách chặn nằm ở `var/playback-blocks.json` và **sống qua `pm2 restart`**. Kiểm chứng lệnh
chặn đã tới nginx chưa (access log nay bật sẵn với `auth=`):

```bash
grep 'auth=blocked' /var/log/nginx/stream-sub-media.log | tail
```

## Encode có hàng đợi và báo kết quả về Central (2026-08-16)

FFmpeg chạy qua hàng đợi giới hạn `ENCODE_CONCURRENCY` (mặc định 1), trạng thái ghi ra
`.<storageKey>.job.json`, và khi xong Sub gọi ngược Central theo contract `stream-encode-v1`.
Node khởi động lại sẽ đối chiếu: job kẹt ở `running` bị đánh `failed`, job chưa giao được thì gửi
lại. Trước đây `202 Accepted` là tín hiệu cuối cùng Central nhận được.

```bash
curl -s localhost:9100/api/default/encode-jobs
```

## Quy ước code (2026-08-16)

Phase 0 của bản chuẩn hoá đã vào code: `platform/log.js` (logger duy nhất, cùng schema với
Central), `platform/config.js` (đọc + kiểm tra env một chỗ), `storage/paths.js` (nơi duy nhất
ghép đường dẫn, tự chặn path traversal), `middleware/legacyProbe.js` (đếm route v1 còn được
gọi). Bảng thuật ngữ và 7 luật bắt buộc: [`SKILL.sub-node.md`](SKILL.sub-node.md) mục 2b.
Lý do đầy đủ + lộ trình Phase 1–3:
[`markdowns/sub-node-code-standardization-draft.md`](markdowns/sub-node-code-standardization-draft.md).

Xem route v1 nào còn sống trước khi xoá code cũ:

```bash
curl -s localhost:9100/api/default/legacy-usage
```

### Changelog

- **2026-08-16d** — Chuẩn hoá Phase 3: gỡ 67 KB RTMP controller, toàn bộ model Mongo và 15
  dependency vào [`legacy/`](legacy/) — tất cả theo bằng chứng `grep` = 0 require, **không** theo
  counter (counter mới có từ Phase 0, chưa đủ 30 ngày). FFmpeg nay chạy bằng **argv, không qua
  shell** — verify bằng encode thật, output byte-identical với bản cũ; đổi lại biết được **bước
  nào** hỏng (thumbnail / thumb.webp / dash) thay vì một exit code gộp. Phụ đề 206 → 200. Thêm
  counter cho `/api/test`, bề mặt legacy lớn nhất còn mở.

- **2026-08-16c** — Chuẩn hoá Phase 2: xác thực node-to-node bằng HMAC (hai loại chữ ký — per-request
  cho node, upload-session token cho FE vì trình duyệt không giữ được khoá), có test đối chiếu hai
  repo; heartbeat chuyển sang `stream-heartbeat-v2` với inventory gửi theo hash + `bootId`/`sequence`
  + độ sâu hàng đợi encode (payload cũ khiến node chạy tốt vẫn ở lại `suspect` mãi); file tạm tách
  khỏi `videos/` sang `var/incoming/` kèm migration lúc boot; `CONFIG_STRICT` mặc định `on`.
  Central có endpoint `POST /api/v2/nodes/jobs/result` nhận kết quả encode.

- **2026-08-16b** — Chuẩn hoá Phase 1: Node ngừng phục vụ media (410 Gone) nên chỉ còn đúng một
  đường phát qua nginx; công tắc chặn phát bền qua restart, chặn thật ở mọi `AUTH_MODE`; encode
  có hàng đợi, trạng thái `.job.json` và callback `stream-encode-v1` về Central; access log nginx
  bật sẵn với `auth=`/`sess=`/`rid=`. Vá lỗi **`X-Request-Id` bị mất qua multer** —
  `AsyncLocalStorage` không sống qua stream event, nên `upload.chunk.accepted` và
  `replication.file.received` chưa từng có `requestId` dù contract v2 §5b nói ngược lại.

- **2026-08-16** — Chuẩn hoá Phase 0: thêm `platform/log.js`, `platform/config.js`,
  `storage/paths.js`, `middleware/legacyProbe.js`, `tests/platform.test.js`; `AppError` nhận
  `apiCode` nên Central đọc được mã lỗi thật của Sub thay vì `BAD_REQUEST` chung chung. Sửa 12
  lỗi rời — đáng chú ý nhất: **heartbeat trước đây không chạy trên node deploy** (điều kiện
  `NODE_ENV === 'development'` bị ngược), phụ đề thiếu trả 500 thay vì 404, và
  `uploadController` tham chiếu hai biến chưa khai báo. `npm test` chạy cả thư mục `tests/`.

- **2026-08-09** — Implement `/api/auth/verify` cho nginx `auth_request` (`services/authService.js`, `controllers/authController.js`, 12 unit test); thêm bộ config nginx cho Windows chạy nhiều sub node.
- **2026-08-09** — Vá bộ config deploy Ver3: `streamingVer3` gộp lại cả server `:80` (bị rơi lúc tách file) lẫn `:9150`, sửa `root` từ path Windows sang path VM, tắt cụm `auth_request` trỏ location đã comment; `scripts` thêm `mkdir -p videos`, `chmod o+x /home/ubuntu`, cài `ffmpeg`. Xem [`markdowns/deployment-hidden-bugs-and-pitfalls.md`](markdowns/deployment-hidden-bugs-and-pitfalls.md) mục 8.
- **2026-07-19** — Thêm receiver v2, filename xác định từ contract và loại DB khỏi runtime Sub; giữ route v1.
*Hướng dẫn cuối kỳ!!!*
*Đây là hướng dẫn cài đặt mới nhất của Sub Server, dùng để deploy server lên VPS để phục vụ việc streaming cho ứng dụng mobile và web*

Hướng dẫn deploy cho VPS hệ điều hành Ubuntu 20.04.6, máy ảo mới, chưa được cài đặt.
Cần phải cài đặt các môi trường, phần mềm cần thiết trước khi deploy.
Bên trong git có 1 file scripts, chứa các lệnh để cài đặt nếu bạn chưa biết, hoặc biết rồi nhưng lười thì copy paste, chạy LẦN LƯỢT từng lệnh luôn cho lẹ.

*Sau đây là giải thích chi tiết, ai không quan tâm thì cứ bỏ qua, copy paste lệnh là deploy được.*

Đầu tiên là apt-get update là để lấy các cập nhật hệ thống, việc này đương nhiên ai cũng phải làm nếu muốn deploy lên VPS rồi.
Sau đó là cài đặt nginx, cài đặt môi trường để chạy server, ở đây là node 20.
Sau khi cài đặt nginx, ta thiết lập cài đặt, cấu hình. Bộ config đang dùng (Ver3) gồm **2 file**, bỏ vào folder gốc của nginx, sau đó test và restart nginx để nhận cấu hình mới:

| File trong repo | Chép tới | Nội dung |
|---|---|---|
| `nginx_subVer3.conf` | `/etc/nginx/nginx.conf` | phần lõi: worker user, bảng MIME (có `.mpd`/`.m4s`), gzip |
| `streamingVer3` | `/etc/nginx/sites-enabled/default` | 2 server block: `:80` proxy sang Node `:9100`, và `:9150` serve file `videos/` trực tiếp |

Cặp cũ `nginx_sub.conf` + `streaming` (Ver2) chỉ giữ để rollback — **không trộn lẫn 2 bộ**, vì `nginx_sub.conf` đã gộp sẵn server `:9150` bên trong, dùng chung sẽ listen `:9150` hai lần và nginx báo `[emerg]`.

Cài đặt các node_modules bằng npm install, và cài đặt thêm 1 gói mới là pm2, gói này mở cho server chạy liên tục thay vì tắt khi màn hình terminal mất đi.
Thế là bạn đã có thể streaming dựa trên địa chỉ IP của VPS: API đi qua cổng `80` (nginx proxy về Node `:9100`), còn file video đi thẳng qua cổng `9150`. Cổng `9100` cố tình **không mở firewall**, chỉ dùng nội bộ.

> ⚠️ **3 bước rất dễ quên, thiếu là deploy không lên dù `nginx -t` vẫn báo OK:**
> 1. `mkdir -p videos` — thư mục này nằm trong `.gitignore` nên không có sau khi clone.
> 2. `sudo chmod o+x /home/ubuntu` — nginx chạy bằng user `www-data`, không traverse được thư mục home mặc định `0750` → trả 403.
> 3. Sửa `root` trong `streamingVer3` cho khớp chỗ clone thật (mặc định `/home/ubuntu/Stream-Sub-Server`, **không** có đuôi `/videos`).
>
> Danh sách đầy đủ + nguyên nhân gốc: [`markdowns/deployment-hidden-bugs-and-pitfalls.md`](markdowns/deployment-hidden-bugs-and-pitfalls.md) mục 8.

*Thế là đã có 1 Sub Server để phục vụ việc lưu trữ, xử lý phân tán dữ liệu và streaming phim, tuy có thể sử dụng đơn lẻ các API của Sub server, nhưng các API đó được tổng hợp cùng các server của hệ thống và sử dụng thuận tiện hơn ở Central Server, cũng có repo riêng https://github.com/HMT2002/SE400.O12.PMCL , đọc thông tin, hướng dẫn chi tiết bên đó*

---------------------------------------------------
*Hướng dẫn cũ* 
*(Các chức năng bên dưới vẫn có thể sử dụng nhưng không được update nữa)*

Lưu ý!!!
Muốn các hướng dẫn này có tác dụng thì phải tải FFMPEG và thêm vào đường dẫn hệ thống trước (system variables)
Còn nếu steaming không thôi thì có thể sử dụng OBS để stream lên server

    rtmp://localhost:1936/live/<Stream key của OBS>

Cần phải di chuyển vào folder server và bật server lên trước

    cd server
    npm start

Server được bật lên, tạo các file m3u8 hoặc mpd để xem video HLS, DASH, FLV.
Không thì download video test ở đây luôn cũng được.
https://drive.google.com/file/d/1bV1_ObTIWUqQ_q_kbIOSUSWvXBKfHTTR/view?usp=sharing
Giải nén ra folder `videos/`
Truy cập vào các đường dẫn để xem video

    http://localhost:9100/videos/<Tên video>Hls/<Tên video>.m3u8
    http://localhost:9100/videos/<Tên của video>Dash/init.mpd
    http://localhost:9100/videos/flyingwitch_ep01Hls/flyingwitch_ep01.m3u8 (nếu dùng folder test bên trên)

(1936 = 1935 + SERVERINDEX)
Để tạo folder Hls hoặc Dash thì dùng các command có sẵn

    batCvrtMp4Dash.bat <tên video cùng folder file batch>

Các từng loại command dành cho từng loại file, từng loại định dạng muốn đổi qua

    Mp4Dash: từ file mp4 thành list Dash
    Mp4Hls: từ file mp4 thành list Hls
    MkvDash: từ file mkv thành list Dash
    ...

Và còn các APIs khác dùng để tạo bản sao, xóa video dựa trên server khác nhau.
Backend chỉ làm nhiệm vụ điều hướng, Server sẽ là các server chịu tải, chịu lỗi. Copy folder server ra, đổi SERVERINDEX trong file config.env

Server RTMP có thể được stream trên các port 1935 + SERVERINDEX của server

Khi chạy npm start server thì là bật 1 server host live streaming, muốn có video streaming thì phải tạo luồng (stream) và chiếu lên host đó. Không biết lệnh thì có sẵn command line luôn.

    rtmpMp4IP.bat <tên video> localhost:1936

Còn không thì có thể dùng OBS để stream trên PC, Laris Broadcaster nếu dùng Android, xem hướng dẫn bên đó.
 Lưu ý là chỉ có các trình duyệt, phần mềm nhất định mới hỗ trợ redirect phương thức HTTP thành RTMP, nghĩa là chỉ có phần mềm chẳng hạn như VLC có thể truy cập vào đường dẫn redirect live stream của backend.
    
    rtmp://localhost:1936/live/<stream key, nếu dùng bat bên trên thì nó là tên video>
-------------------------------------------------------------

<!-- 
                       _oo0oo_
                      o8888888o
                      88" . "88
                      (| -_- |)
                      0\  =  /0
                    ___/`---'\___
                  .' \\|     |// '.
                 / \\|||  :  |||// \
                / _||||| -:- |||||- \
               |   | \\\  -  /// |   |
               | \_|  ''\---/''  |_/ |
               \  .-\__  '-'  ___/-. /
             ___'. .'  /--.--\  `. .'___
          ."" '<  `.___\_<|>_/___.' >' "".
         | | :  `- \`.;`\ _ /`;.`/ - ` : | |
         \  \ `_.   \_ __\ /__ _/   .-` /  /
     =====`-.____`.___ \_____/___.-`___.-'=====
                       `=---='


     ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~ 
                    HMT2002 copyright@
                        Hồ Minh Tuệ
-->
