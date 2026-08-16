# Deployment & Coding — Lỗi Thường Gặp / Lỗi Ẩn (Node.js + PM2 + nginx + Oracle Cloud)

**Tạo:** 2026-07-05
**Project:** Stream-Central-Server
**Mục đích:** Tổng hợp lỗi **thật đã gặp** (không phải lý thuyết suy đoán) khi deploy STORAGE/SUB
node lên Oracle Cloud lần đầu. Tổ chức theo **Triệu chứng → Nguyên nhân gốc → Cách phát hiện →
Cách sửa/phòng**, để lần sau tra theo triệu chứng thay vì debug lại từ đầu. Nhiều lỗi ở đây
**không đặc thù Oracle** — sẽ tái diễn ở bất kỳ VM/cloud nào dùng chung stack Node.js + PM2 + nginx.

**Related files:**
- [vm-server-setup-guide.md](vm-server-setup-guide.md) — checklist thao tác step-by-step đầy đủ
  (provision, network, firewall). Các gotcha đặc thù Oracle ở file này được **tóm tắt** ở mục 5
  bên dưới, chi tiết đầy đủ trỏ ngược lại file đó, không lặp lại toàn văn.
- [multi-cloud-free-tier-node-deployment.md](multi-cloud-free-tier-node-deployment.md) —
  pricing/rationale, không liên quan trực tiếp lỗi kỹ thuật ở đây.
- Repo `Stream-Sub-Server` (`scripts`, `nginx.conf`, `streaming`, `ecosystem.config.js`,
  `config.env`) — case thực tế minh hoạ cho mục 1, 2, 4.

---

## 1. Node app crash-loop do thiếu biến môi trường bắt buộc (silent `dotenv` failure)

**Triệu chứng:** `pm2 status` báo trống hoặc process `errored`/restart liên tục; port app
(VD `9100`) không bao giờ `listen`; nginx proxy tới port đó trả `502`, hoặc worse — trả `404`
mập mờ (xem mục 3).

**Nguyên nhân gốc — chuỗi đầy đủ:**
```
git clone lên VM (config.env nằm trong .gitignore → KHÔNG được mang theo)
        ↓
dotenv.config({ path: './config.env' })   ← file không tồn tại
        ↓
dotenv KHÔNG throw, không log rõ ràng — chỉ âm thầm return { error: ... },
code không kiểm tra giá trị trả về này
        ↓
process.env.DATABASE vẫn undefined
        ↓
db_index.js chạy process.env.DATABASE.replace(...) ở CẤP MODULE (top-level),
KHÔNG nằm trong try/catch của hàm connect() async bên dưới
        ↓
TypeError: Cannot read properties of undefined (reading 'replace')
── uncaught exception, xảy ra TRƯỚC app.listen(port)
        ↓
Node process chết ngay — port app không bao giờ được bind
```

**Điểm mấu chốt kỹ thuật:** dòng crash nằm ở top-level module (chạy lúc `require()`), nên
`try/catch` bên trong hàm `connect()` (dùng để bắt lỗi kết nối Mongo thật) **hoàn toàn không có
tác dụng** — bug xảy ra ở bước đọc biến môi trường, trước khi logic try/catch đó kịp chạy.

**Vì sao local dev không gặp:** file `config.env` tồn tại vĩnh viễn trên máy dev (tự tạo tay,
không qua git). VM chỉ có đúng những gì git mang theo — thiếu hẳn file mà code phụ thuộc cứng.

**By-design, không phải bug của `dotenv`:** `dotenv` cố tình không throw khi file thiếu, vì
nhiều app production đọc biến môi trường trực tiếp từ OS (Docker `-e`, systemd `Environment=`,
cloud secret manager...) mà không cần file `.env` — với các app đó, "file `.env` không tồn tại"
là tình huống **bình thường**, không phải lỗi. Trách nhiệm validate "các biến tôi cần có tồn tại
hay chưa" thuộc về **code của ứng dụng**, không phải của thư viện đọc file.

**Cách phát hiện nhanh:**
```bash
pm2 logs <app-name> --lines 50 --nostream   # tìm "Cannot read properties of undefined"
ls -la config.env                            # confirm file có tồn tại ở đúng cwd không
```

**Cách sửa/phòng:**
- Ngay lập tức: copy `config.env` lên VM thủ công (`scp`), không có cách nào khác vì file
  cố tình không nằm trong git.
- Phòng tái diễn ở tầng script deploy: fail-fast thay vì để PM2 crash-loop âm thầm:
  ```bash
  test -f config.env || { echo "THIẾU config.env — copy trước khi tiếp tục"; exit 1; }
  ```
- Phòng tái diễn ở tầng code (đề xuất, chưa áp dụng — quyết định của dự án): validate biến môi
  trường bắt buộc ngay đầu `server.js`/`app.js`, thoát rõ ràng nếu thiếu, thay vì để lỗi rơi tự
  do xuống tận một `.replace()` sâu trong module DB không liên quan tới thông điệp lỗi thật.

**References:**
- dotenv — hành vi khi file không tồn tại (không throw mặc định) — https://github.com/motdotla/dotenv#-options (xem `error` field ở option nâng cao, và README phần "What happens to environment variables that were already set?")
- Node.js docs — Uncaught Exceptions — https://nodejs.org/api/process.html#event-uncaughtexception

---

## 2. PM2 chạy dưới `sudo` tạo daemon riêng biệt với user thường

**Triệu chứng:** `pm2 status` (chạy với user thường, VD `ubuntu`) báo **trống hoàn toàn**, dù
app rõ ràng đang chạy (curl nội bộ vẫn work, hoặc ngược lại app rõ ràng đang crash nhưng
`pm2 status` không hề cho biết).

**Nguyên nhân gốc:** PM2 lưu trạng thái process theo **từng user** — mỗi user có PM2 daemon +
socket + log riêng tại `~/.pm2/`. Chạy `sudo pm2 start ...` tạo daemon dưới `/root/.pm2/`, hoàn
toàn tách biệt với daemon của user `ubuntu` (đã setup `pm2 startup`/`pm2 save` từ trước). Đây
**không phải lỗi PM2** — daemon-theo-user là thiết kế có chủ đích (mỗi user login riêng, PM2
không giả định có quyền truy cập process của user khác).

**Cách phát hiện:**
```bash
pm2 status          # daemon của user hiện tại
sudo pm2 status      # daemon của root — kiểm tra cả 2 nếu 1 bên trống bất thường
```

**Cách sửa/phòng:** chọn **1 user duy nhất** chạy PM2 xuyên suốt (khuyến nghị: user thường,
không phải root — khớp checklist hardening "không dùng root chạy app/PM2"). Không trộn lệnh có
`sudo pm2` và không `sudo pm2` cho cùng một app.

**References:**
- PM2 docs — Process management / multi-user — https://pm2.keymetrics.io/docs/usage/quick-start/

---

## 3. nginx `error_page` che giấu `502` thành `404` — triệu chứng đánh lừa root cause

**Triệu chứng:** GET request nào cũng trả về `404 Not Found` (trang mặc định của **nginx**, có
chữ "nginx" ở cuối trang) — trông giống lỗi routing/path, nhưng thật ra backend đã chết hoàn toàn.

**Nguyên nhân gốc — chuỗi redirect lỗi lồng nhau:**
```
Node chết (xem mục 1) → port app không listen
        ↓
nginx proxy_pass http://localhost:<port> → OS trả ECONNREFUSED (không ai lắng nghe)
        ↓
nginx hiểu đây là lỗi backend → trả 502 Bad Gateway (ĐÚNG, rõ ràng — nếu dừng ở đây)
        ↓
NHƯNG có dòng: error_page 500 502 503 504 /50x.html;
→ nginx redirect nội bộ sang phục vụ file tĩnh /50x.html
        ↓
location = /50x.html { root html; }   ← "root html" là path TƯƠNG ĐỐI,
resolve theo --prefix lúc compile nginx (thường /usr/share/nginx trên Debian/Ubuntu)
        ↓
File /usr/share/nginx/html/50x.html KHÔNG tồn tại thật trên VM (image minimal không có sẵn)
        ↓
Không có error_page 404 tuỳ chỉnh → nginx trả 404 BUILT-IN của chính nó
```

**Vì sao dễ đánh lừa người debug:** `404` khiến người debug đi tìm sai hướng — nghĩ do routing/
path trong code Express, hoặc do location block nginx sai — trong khi gốc rễ thật là **backend
đã chết từ trước** (mục 1). Status code `404` không phản ánh đúng bản chất lỗi `502`.

**Cách phát hiện:**
```bash
curl -sI http://127.0.0.1:<port_app>/    # nếu backend chết, connect() sẽ refused ngay
sudo ss -tlnp | grep <port_app>          # xác nhận có process nào listen port đó không
```

**Cách sửa/phòng:** **bỏ hẳn** khối `error_page 500 502 503 504 /50x.html` khi không thật sự cần
trang lỗi tuỳ chỉnh đẹp — để nginx trả thẳng `502 Bad Gateway` khi backend chết. `502` là tín
hiệu chẩn đoán rõ ràng ("backend down"), trong khi `404` (nhất là khi bị remap qua 1 tầng trung
gian không tồn tại) là tín hiệu mù mờ, tốn thời gian debug sai hướng.

**References:**
- nginx docs — `error_page` directive — https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page
- nginx docs — `proxy_pass` và xử lý lỗi upstream — https://nginx.org/en/docs/http/ngx_http_proxy_module.html

---

## 4. `ecosystem.config.js` có nhiều app entry trùng port → `EADDRINUSE`

**Triệu chứng (case thực tế `Stream-Sub-Server`):** `pm2 status` sau `pm2 start
ecosystem.config.js` cho ra 1 app `online`, 1 app khác `errored`/restart loop.

**Nguyên nhân gốc:**
```js
apps: [
  { name: 'sub-server-0', script: './server.js', ... },
  { name: 'backend',      script: './server.js', ... },   // TRÙNG — cùng config.env
]
```
Cả 2 entry chạy cùng file `server.js` với cùng `config.env` → cùng công thức tính port
(`PORT + SERVERINDEX*SERVERREP`) → ra **cùng 1 port**. App khởi động sau nhận `EADDRINUSE` vì
port đã bị app đầu chiếm.

**Cách sửa/phòng:** `pm2 delete <app dư>` sau khi xác nhận app chính chạy ổn, hoặc sửa
`ecosystem.config.js` để mỗi entry có `SERVERINDEX` khác nhau (qua trường `env` riêng per-app)
nếu thật sự cần chạy nhiều instance — việc sửa code này là **đề xuất**, tự quyết định theo nhu
cầu dự án.

---

## 5. Oracle Cloud (OCI) — gotcha hạ tầng (tóm tắt, chi tiết đầy đủ ở `vm-server-setup-guide.md`)

Không lặp lại toàn văn ở đây — chỉ liệt kê triệu chứng để tra nhanh, xem full chi tiết + lệnh fix
tại các mục tương ứng trong [vm-server-setup-guide.md](vm-server-setup-guide.md) §4:

| Triệu chứng | Nguyên nhân | Xem chi tiết |
|---|---|---|
| "Out of host capacity" khi tạo instance | Pool always-free giới hạn, cả `E2.1.Micro` và `A1.Flex` có thể hết cùng lúc | §4.0 |
| Checkbox "Assign a public IPv4 address" bị xám/disable | Đang chọn nhầm Private Subnet thay vì Public Subnet | §4.2 |
| Field "Private IPv4 address" bị mask/xám | Bình thường — do "Automatically assign" tick sẵn, không phải lỗi | §4.2 |
| Connect timeout dù đã mở port ở Security List | iptables OS-level mặc định REJECT-all trừ port 22/loopback/established | §4.3 |
| Ping không hoạt động dù port TCP đã thông | ICMP Echo khác TCP, Security List mặc định không mở Echo — không cần thiết cho stack này | §4.3 |
| `Load key ...: bad permissions` khi SSH từ Windows | `icacls` (PowerShell) và `chmod` (Git Bash) là 2 cơ chế permission khác nhau, không trộn lẫn cho cùng 1 file | §4.4 |

---

## 6. Nguyên lý chung rút ra từ toàn bộ session

1. **"Chết trước khi tới `app.listen()`" luôn nguy hiểm hơn "chết sau khi đã listen"** — vì mọi
   layer phía trước (nginx, PM2 health-check nếu có) đều mất khả năng phân biệt "app đang khởi
   động chậm" với "app crash vĩnh viễn". Validate input/config càng sớm càng tốt, càng gần đầu
   file càng tốt, để lỗi hiện ra rõ ràng thay vì rơi xuống module không liên quan.
2. **Process manager (PM2) + secret bị exclude khỏi git là tổ hợp kinh điển sinh crash-loop.**
   Từng thứ riêng đều là best practice đúng đắn (giữ uptime / không commit secret); cộng lại tạo
   ra vòng lặp vô tận nếu ứng dụng không tự kiểm tra input lúc khởi động.
3. **Status code HTTP bị remap qua nhiều tầng (`error_page`, fallback, `try_files`) càng nhiều
   càng khó debug** — mỗi lần remap là một cơ hội che giấu bản chất lỗi gốc. Ưu tiên để lỗi thật
   lộ ra (502 rõ ràng hơn 404 mù mờ) trừ khi có lý do UX cụ thể cần trang lỗi đẹp.
4. **Không có gì đảm bảo "làm trên Windows local" giống hệt "làm trên VM Linux"** — permission
   model (ACL vs POSIX), path separator, iptables mặc định, tất cả là điểm khác biệt âm thầm.

---

## 7. FFmpeg DASH template `$Name$` bị bash nuốt mất — rác ngẫu nhiên từ biến đặc biệt `$_`

**Triệu chứng:** Chạy lệnh FFmpeg DASH (`-init_seg_name`/`-media_seg_name` chứa
`$RepresentationID$`, `$Number%05d$`) trên VM Linux → lỗi kiểu:
```
Unable to open videos/xxx/chunk_/usr/bin/pm2%05d$.m4s.tmp for writing: No such file or directory
```
Filename bị chèn rác (VD `/usr/bin/pm2`) không liên quan gì tới FFmpeg. **Cùng lệnh y hệt chạy êm
trên Windows local.**

**Nguyên nhân gốc:** `$RepresentationID$`/`$Number%05d$` là **placeholder riêng của FFmpeg** (DASH
muxer tự thay thế theo từng output file) — không phải biến shell. Nhưng lệnh chạy qua **bash**
(`/bin/sh`) trên Linux, và `$` là ký tự mở biến môi trường của bash:
```
chunk_$RepresentationID$_$Number%05d$.m4s
        └────┬────┘└┬┘
              │      └── $_ → BIẾN ĐẶC BIỆT bash: "tham số cuối của lệnh vừa chạy trước đó"
              └── $RepresentationID → biến không tồn tại → rỗng
```
`$_` là biến đặc biệt **có thật** trong bash. Nếu lệnh chạy trước đó trong cùng shell session có
liên quan `pm2` (VD `pm2 restart ...`), `$_` đang giữ `/usr/bin/pm2` → bash âm thầm chèn giá trị
đó vào giữa filename. **Vì giá trị phụ thuộc lệnh gõ trước đó, bug này không tái hiện nhất quán**
— mỗi lần thử lại có thể ra rác khác nhau tuỳ lịch sử lệnh trong session.

**Vì sao Windows không gặp:** `cmd.exe` không coi `$` là ký tự đặc biệt — chuỗi
`$RepresentationID$...` đi qua nguyên vẹn, FFmpeg nhận đúng literal string cần. Đây là lý do lệnh
chạy êm ở dev Windows nhưng vỡ khi chạy qua bash trên VM Linux — cùng loại vấn đề với nguyên lý #4
ở mục 6.

**Cách sửa khi chạy tay trên bash:** bọc **single quote** quanh giá trị chứa `$` — single quote
chặn tuyệt đối mọi expansion (biến, `$_`, wildcard):
```bash
-init_seg_name 'init_$RepresentationID$.m4s' -media_seg_name 'chunk_$RepresentationID$_$Number%05d$.m4s'
```

**Ảnh hưởng tới code (`encodeAPI.js`):** mọi case hiện có build chuỗi lệnh FFmpeg qua nối string
(không quote quanh `$...$`) rồi chạy qua `exec()` (dùng shell của OS) đều mang bug tiềm ẩn này —
chưa lộ ra vì trước giờ chỉ chạy qua NVENC trên Windows dev. Do `exec()` phụ thuộc shell của từng
OS (`cmd.exe` Windows, `/bin/sh` Linux — 2 shell hiểu quote khác nhau), không có cách quote nào
chung cho cả 2 platform cùng lúc. Hướng sửa tận gốc (đề xuất, chưa áp dụng): chuyển từ `exec()`
(string + shell) sang `spawn()`/`execFile()` với **mảng argument** — Node truyền thẳng từng arg
cho ffmpeg process, không qua shell nào, loại bỏ hẳn lớp bug này (không chỉ `$_`, mà mọi ký tự đặc
biệt shell khác). Đánh đổi: đoạn pipe `|` nối 2 lệnh ffmpeg (thumbnail → encode) hiện dựa vào shell
pipe, cần tách thành 2 lần `spawn()` riêng nếu chuyển sang argv-array.

**References:**
- FFmpeg DASH muxer — `$RepresentationID$`/`$Number$` template — https://ffmpeg.org/ffmpeg-formats.html#dash-2
- Bash manual — Special Parameters (`$_`) — https://www.gnu.org/software/bash/manual/bash.html#Special-Parameters
- Node.js docs — `child_process.exec` vs `execFile`/`spawn` (shell injection/quoting) — https://nodejs.org/api/child_process.html#child_processexeccommand-options-callback

---

## 8. Tách nginx.conf thành 2 file (Ver3) — 5 lỗi ẩn cùng lúc, `nginx -t` vẫn PASS hết

**Bối cảnh:** commit `Stream-Sub-Server` 2026-07-25 chuyển từ **Cách B** (server block gộp trong
`nginx_sub.conf`) sang **Cách A** (site tách ra `sites-enabled`), sinh ra cặp file mới
`nginx_subVer3.conf` + `streamingVer3`, và sửa `scripts` để copy 2 file này.

**Triệu chứng:** deploy theo `scripts` như mọi lần, `sudo nginx -t` báo **`test is successful`**,
`systemctl status nginx` **active (running)** — nhưng: Central gọi API sub node thì **connection
refused**, và (nếu gọi được) mọi request video qua `:9150` trả **404** hoặc **403**.

**Điểm chung của cả 5 lỗi — vì sao `nginx -t` vô dụng ở đây:** `nginx -t` chỉ kiểm tra **cú pháp
+ ngữ nghĩa tĩnh** của config. Nó **không** kiểm tra: thư mục `root` có tồn tại thật không, worker
có quyền đọc không, URI trong `auth_request` có location tương ứng không, hay "config này có còn
đủ server block như bản trước không". Tất cả đều là lỗi **runtime**. Đây là by-design — nginx
không thể biết ý định của người viết config, chỉ biết config có hợp lệ về mặt ngôn ngữ hay không
(khác với mục 3, nơi lỗi bị *che* bởi remap status code; ở đây lỗi *chưa bao giờ được kiểm tra*).

### 8.1 `sudo cp <site> /etc/nginx/sites-enabled/default` làm rơi mất server `:80`

`streaming` (file cũ) chứa server `listen 80 default_server` proxy sang Node `:9100`.
`streamingVer3` chỉ chứa server `:9150` static. Nhưng dòng deploy vẫn là:
```bash
sudo cp streamingVer3 /etc/nginx/sites-enabled/default   # GHI ĐÈ file duy nhất còn giữ server :80
```
→ sau deploy **không còn ai listen `:80`**. Node vẫn sống ở `:9100`, nhưng Security List/iptables
cố ý **chỉ mở `22/80/443/9150`, không mở `9100`** (`vm-server-setup-guide.md` §4.3) → từ ngoài
internet sub node **hoàn toàn không gọi được**, dù `pm2 status` báo `online`.

Hai chi tiết dễ bỏ sót đi kèm:
- `sites-enabled/default` trên Ubuntu là **symlink** tới `sites-available/default`. `cp` **ghi
  xuyên qua symlink** → file trong `sites-available` bị thay nội dung luôn, không phải bị thay
  symlink. Backup trước khi cp nếu còn cần bản gốc.
- nginx **không cảnh báo** khi không có server nào nghe `:80`. "Không có server block" là trạng
  thái hợp lệ, không phải lỗi.

**Cách phát hiện:**
```bash
sudo ss -tlnp | grep -E ':80|9100|9150'   # phải thấy ĐỦ 3 dòng
curl -sI http://127.0.0.1/                # connection refused = mất server :80 (khác hẳn 502 = Node chết)
```
**Cách sửa:** giữ **cả 2 server block trong cùng 1 file site** (`streamingVer3` đã gộp lại từ
2026-08-09), hoặc tách 2 file rồi copy cả 2 vào `sites-enabled/`. Đừng để 1 lệnh `cp` quyết định
số phận của server block khác.

### 8.2 `root` còn path Windows → 404 toàn bộ, không hề báo lỗi

```nginx
root D:/gitrepos/Stream-Sub-Server;   # path máy dev Windows, sót lại trong file deploy
```
Trên Linux `D:/gitrepos/...` **không phải path tuyệt đối** (không bắt đầu bằng `/`) → nginx coi là
**relative** và resolve theo **prefix** `/etc/nginx` (xem [nginx-config-operations-guide.md §1](nginx-config-operations-guide.md))
→ đi tìm `/etc/nginx/D:/gitrepos/Stream-Sub-Server/videos/...` → `try_files ... =404`.
`nginx -t` pass vì cú pháp `root` hợp lệ và nginx **không kiểm tra thư mục có tồn tại**.

**Bẫy kép — `/videos` thừa hoặc thiếu:** URL contract của frontend (`subservernginxurl`) là
`http://<ip>:9150/videos/<videoname>/init.mpd` — **bản thân URL đã chứa `/videos/`**. Nên `root`
phải trỏ **thư mục gốc repo**, KHÔNG phải thư mục `videos`:

| `root` | URL `/videos/x/init.mpd` mở file | Kết quả |
|---|---|---|
| `/home/ubuntu/Stream-Sub-Server` | `/home/ubuntu/Stream-Sub-Server/videos/x/init.mpd` | ✅ đúng |
| `/home/ubuntu/Stream-Sub-Server/videos` | `.../videos/videos/x/init.mpd` | ❌ 404 |

(TODO §4 của [oracle-storage-node-deploy-log.md](oracle-storage-node-deploy-log.md) trước đây ghi
path có đuôi `/videos` — **sai theo contract URL**, đã đính chính 2026-08-09.)

### 8.3 `auth_request` trỏ tới `location` đã bị comment → đệ quy subrequest

```nginx
location / {
    auth_request /__auth;                    # còn BẬT
    error_page 401 403 500 502 503 504 = @serve;
    try_files $uri =404;
}
# location = /__auth { internal; proxy_pass ... }   # đã COMMENT
```
`auth_request` **không được validate lúc `nginx -t`** — nginx chỉ resolve URI đó lúc chạy thật.
Không còn `location = /__auth` → subrequest `/__auth` rơi vào chính `location /` → location đó
lại chạy `auth_request` → **đệ quy** tới giới hạn subrequest của nginx → `[error] subrequests
cycle` → 500 → `error_page` bắt 500 → `@serve` → **file vẫn ra bình thường**.

Đây là lý do bug sống sót lâu: **kết quả nhìn vẫn đúng**. Cái mất là mỗi segment `.m4s` tốn hàng
chục subrequest vô ích + `error.log` phình rất nhanh (mỗi request 1 dòng), còn auth thì **không có
tác dụng gì**. Thêm nữa route trong khối comment (`/api/default/check/is-this-alive`) **không tồn
tại** — route thật là `/api/default/check/alive/is-this-alive` — nên có bật cũng chỉ 404 → fail-open.

**Cách sửa:** `auth_request` + `error_page` + `location = /__auth` là **một cụm 3 phần, bật/tắt
cùng nhau**. Đang giai đoạn fail-open thì tắt cả 3 (rẻ hơn, log sạch hơn) thay vì bật nửa vời.

### 8.4 Đổi `user root` → `user www-data` mà quên quyền thư mục → 403 (không phải 404)

`nginx_sub.conf` (Ver2) chạy worker bằng `user root;` — đọc được mọi file nên che mất vấn đề quyền.
`nginx_subVer3.conf` đổi sang `user www-data;` (đúng về bảo mật) → worker cần bit **`x` cho other
trên MỌI thư mục cha** của `root`. `/home/ubuntu` trên Ubuntu 22.04+ mặc định `0750` → www-data
không traverse được → **403 Forbidden**, `error.log` ghi `Permission denied`.

```bash
sudo -u www-data stat /home/ubuntu/Stream-Sub-Server/videos   # test đúng thứ nginx thấy
sudo chmod o+x /home/ubuntu                                   # chỉ cần bit traverse, không cần đọc
```
Phân biệt nhanh: **404** = sai path/root (§8.2) · **403** = đúng path, sai quyền (§8.4).

### 8.5 `videos/` nằm trong `.gitignore` → thư mục không tồn tại sau `git clone`

`.gitignore` có `videos/*` → clone xong **không có thư mục `videos`**. Hệ quả kép: nginx `:9150`
404 mọi request, và Node ném `ENOENT` khi ghi chunk upload đầu tiên. Git **không lưu thư mục rỗng**
(git chỉ theo dõi file) — đây là hành vi by-design, không phải lỗi `.gitignore`.
→ thêm `mkdir -p videos` vào script deploy (đã thêm 2026-08-09).

**Nguyên lý rút ra (bổ sung cho mục 6):**
5. **Refactor config hạ tầng nguy hiểm hơn refactor code** — code có test, config chỉ có `nginx -t`
   vốn *chỉ* kiểm tra cú pháp. Khi tách/gộp file config, checklist bắt buộc là **so sánh danh sách
   `listen` trước và sau** (`ss -tlnp`), không phải chỉ nhìn `nginx -t`.
6. **Path và user là 2 thứ luôn khác nhau giữa dev và VM** — mọi giá trị "dummy tạm" (path Windows,
   route giả, location comment) phải bị coi là *nợ deploy*, ghi thành TODO có ngày, vì chúng không
   bao giờ tự lộ ra qua bất kỳ lệnh kiểm tra tự động nào.

**References:**
- nginx docs — `ngx_http_auth_request_module` — https://nginx.org/en/docs/http/ngx_http_auth_request_module.html
- nginx docs — `root`/`try_files` (path resolution theo prefix) — https://nginx.org/en/docs/http/ngx_http_core_module.html#root
- nginx docs — `user` directive (worker process credentials) — https://nginx.org/en/docs/ngx_core_module.html#user
- Git FAQ — vì sao git không track thư mục rỗng — https://git-scm.com/docs/gitignore

---

## References

- dotenv — https://github.com/motdotla/dotenv
- PM2 docs — https://pm2.keymetrics.io/docs/usage/quick-start/
- nginx `error_page` — https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page
- nginx `proxy_pass`/upstream errors — https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- Node.js uncaught exceptions — https://nodejs.org/api/process.html#event-uncaughtexception

---

## Changelog

- **2026-07-05** — Tạo file. Tổng hợp từ session deploy thật STORAGE/SUB node lên Oracle Cloud
  (2026-07-04 → 2026-07-05): dotenv silent fail gây crash-loop (mục 1), PM2 daemon tách biệt theo
  user khi dùng `sudo` (mục 2), nginx `error_page` che giấu 502 thành 404 (mục 3),
  `ecosystem.config.js` trùng port trong `Stream-Sub-Server` (mục 4), tóm tắt tra nhanh gotcha
  OCI trỏ về `vm-server-setup-guide.md` (mục 5), và nguyên lý chung rút ra (mục 6). Không trùng
  chủ đề với các file OTT-protocol hiện có trong project knowledge — tạo file mới theo đúng quy
  tắc §3.1 (search overlap trước khi tạo).
- **2026-08-09** — Thêm mục 8: 5 lỗi ẩn phát sinh khi tách `nginx.conf` thành cặp
  `nginx_subVer3.conf` + `streamingVer3` (commit 2026-07-25) mà `nginx -t` vẫn PASS toàn bộ —
  `cp` đè `sites-enabled/default` làm rơi server `:80` (§8.1), `root` còn path Windows + bẫy
  `/videos` thừa/thiếu (§8.2), `auth_request` trỏ location đã comment gây đệ quy subrequest
  (§8.3), `user root`→`www-data` thiếu bit traverse gây 403 (§8.4), `videos/` bị `.gitignore`
  nên không tồn tại sau clone (§8.5). Kèm 2 nguyên lý bổ sung cho mục 6.
- **2026-07-05** — Thêm mục 7: FFmpeg DASH template `$RepresentationID$`/`$Number$` bị bash nuốt
  thành biến đặc biệt `$_` (rác ngẫu nhiên từ lệnh trước đó trong shell history), phát hiện khi
  test lệnh libx264 CPU-fallback (từ `ffmpeg-presets-reference.md`) trên VM Linux thật. Liên quan
  `encodeAPI.js` dùng `exec()` string+shell — đề xuất hướng sửa tận gốc bằng `spawn()` argv-array.
