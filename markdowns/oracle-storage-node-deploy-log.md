# Oracle STORAGE Node #1 — Deploy Session Log (sổ tay sống)

**Tạo:** 2026-07-05
**Project:** Stream-Central-Server
**File này là gì:** nhật ký **trạng thái thực tế** của lần deploy STORAGE/SUB node đầu tiên lên
Oracle Cloud (2026-07-04 → 2026-07-05) — VM cụ thể nào, đã làm gì, còn thiếu gì. **Khác với** 3
file reference đã cập nhật trong cùng session (không lặp nội dung, chỉ trỏ chéo):
- [vm-server-setup-guide.md](vm-server-setup-guide.md) — **cách làm đúng ngay từ đầu** (thao tác
  provisioning/network/firewall theo khung chuẩn, áp dụng được cho VM khác/provider khác).
- [deployment-hidden-bugs-and-pitfalls.md](deployment-hidden-bugs-and-pitfalls.md) — **tra theo
  triệu chứng** khi deploy bị lỗi (dotenv/PM2/nginx/shell-quoting), tổng quát cho mọi node.
- [ffmpeg-presets-reference.md](ffmpeg-presets-reference.md) — preset NVENC ↔ libx264, dùng khi
  cấu hình encode cho node không GPU.
- [../scripts/stream-sub-server-deploy.sh](../scripts/stream-sub-server-deploy.sh) — copy sạch
  deploy pipeline (từ `Stream-Sub-Server/scripts`), dễ tinh chỉnh mà không đụng file gốc repo kia.
- [../scripts/oracle-storage-node-nginx-pm2-ops.sh](../scripts/oracle-storage-node-nginx-pm2-ops.sh)
  — bản file của mục 5 bên dưới (lệnh nginx/PM2 + combo theo tình huống), copy-từng-dòng khi cần.

**Quy tắc cập nhật:** chỉ bổ sung/đánh dấu trạng thái mới, không xoá đè — mỗi mục có ngày, thêm
dòng mới bên dưới khi trạng thái đổi thay vì sửa lại dòng cũ.

---

## 1. Thông tin VM hiện tại

| | Giá trị |
|---|---|
| Provider | Oracle Cloud (OCI), home region **Singapore** (`ap-singapore-1`) |
| Shape | `VM.Standard2.1` — ⚠️ **shape trả phí qua Free Trial**, KHÔNG phải always-free — lý do: cả `E2.1.Micro` và `A1.Flex` đều "out of host capacity" cùng lúc lúc tạo (2026-07-04) |
| OS Image | Canonical Ubuntu 22.04 Minimal |
| Public IP | `161.118.234.83` (Ephemeral — **chưa đổi Reserved**, xem TODO §4) |
| Vai trò | STORAGE/SUB node |
| Repo deploy | `Stream-Sub-Server` tại `/home/ubuntu/Stream-Sub-Server` |
| SSH key | `D:\ssh-key-oracle\ssh-key-2026-07-04.key` (máy dev Windows) |

---

## 2. Đã hoàn thành (theo thứ tự thật đã làm)

1. ✅ Provision instance qua Free Trial (`VM.Standard2.1`) sau khi cả 2 shape always-free hết
   capacity — chi tiết networking/boot volume gây rối lúc tạo → [vm-server-setup-guide.md §4.1-4.2](vm-server-setup-guide.md).
2. ✅ SSH access từ Windows — vướng `icacls` (PowerShell) vs `chmod` (Git Bash), đã xác định dùng
   nhất quán 1 terminal → [vm-server-setup-guide.md §4.4](vm-server-setup-guide.md).
3. ✅ Firewall 2 tầng thông — Security List mở `22/80/443/9150`; iptables OS-level (Oracle preload
   REJECT-all mặc định) đã insert ACCEPT rule + persist bằng `iptables-persistent` →
   [vm-server-setup-guide.md §4.3](vm-server-setup-guide.md).
4. ✅ Node.js + PM2 cài, `config.env` copy tay lên VM (không qua git, đúng thiết kế bảo mật).
5. ✅ Debug 2 vòng crash-loop PM2 (thiếu `config.env` sau khi chạy lại `scripts`, và PM2 chạy dưới
   `sudo` tạo daemon root riêng biệt) → root cause đầy đủ ở
   [deployment-hidden-bugs-and-pitfalls.md mục 1-2](deployment-hidden-bugs-and-pitfalls.md).
6. ✅ nginx: dọn file `streaming` (bỏ RTMP/mime dư thừa, bỏ `error_page` che giấu 502 thành 404) —
   nội dung cuối cùng ở [Stream-Sub-Server/streaming](../../Stream-Sub-Server/streaming) *(repo
   khác, tham chiếu path tương đối)*.
7. ✅ Sửa file `scripts` (deploy pipeline): thêm `test -f config.env` fail-fast, bỏ `sudo` trước
   `pm2 start` — không đụng phần ASCII art cuối file theo yêu cầu.
8. ✅ Xác nhận gọi được Node API qua network (port 80 → nginx proxy → Node `:9100`) sau khi vá hết
   các lỗi trên.
9. ✅ Encode: thêm `case 6` vào `modules/encodeAPI.js` — bản libx264 CPU-only tương đương ladder
   NVENC của case 4 (450k/1000k/1900k @ 720x480/1080x720/1920x1080), sửa `-rc -cq 21` sai cú pháp
   thành `-crf 21`, thêm `-pix_fmt yuv420p`/`-threads 0` → chi tiết ánh xạ flag ở
   [ffmpeg-presets-reference.md](ffmpeg-presets-reference.md). Phát hiện kèm theo: bug shell nuốt
   `$RepresentationID$` thành biến `$_` khi test trên bash Linux →
   [deployment-hidden-bugs-and-pitfalls.md mục 7](deployment-hidden-bugs-and-pitfalls.md).

---

## 3. Trạng thái hiện tại (snapshot 2026-07-05)

- PM2 chạy dưới user `ubuntu` (không sudo), `pm2 startup`/`pm2 save` đã set.
- nginx: `nginx.conf` (main) vẫn còn `root D:/gitrepos/Stream-Sub-Server/videos` — **path dummy
  Windows, CHƯA sửa cho VM Linux** → serve video qua `:9150` sẽ 404 cho tới khi sửa (xem TODO §4).
- `ecosystem.config.js` còn 2 app entry trùng port (`sub-server-0`/`backend`) — **chưa dọn**, chỉ
  mới biết nguyên nhân, chưa xoá app dư.
- `ENCODE_TYPE` trong `config.env` **chưa xác nhận đã đổi sang `6`** cho node này (cần set tay nếu
  server không GPU).

**Cập nhật 2026-08-09 — sau khi audit lại bộ config Ver3 (commit `Stream-Sub-Server` 2026-07-25):**

- Bộ config deploy hiện hành đổi thành cặp **`nginx_subVer3.conf` + `streamingVer3`** (Cách A —
  site tách khỏi file lõi). Cặp cũ `nginx_sub.conf` + `streaming` **giữ lại làm tham chiếu, KHÔNG
  dùng chung** — `nginx_sub.conf` gộp sẵn server `:9150` bên trong, trộn với `streamingVer3` sẽ
  listen `:9150` hai lần → `[emerg]`.
- Bản Ver3 lúc mới tạo có **5 lỗi ẩn khiến deploy không lên dù `nginx -t` PASS** — root cause đầy
  đủ ở [deployment-hidden-bugs-and-pitfalls.md mục 8](deployment-hidden-bugs-and-pitfalls.md).
  Đã vá hết trong repo `Stream-Sub-Server` ngày 2026-08-09:
  1. `streamingVer3` mất server `:80` → đã gộp lại **2 server block trong 1 file** (`:80` proxy
     Node `:9100`, `:9150` static).
  2. `root D:/gitrepos/Stream-Sub-Server` (path Windows) → `/home/ubuntu/Stream-Sub-Server`.
  3. `auth_request /__auth` bật trong khi `location = /__auth` bị comment → tắt cả cụm 3 phần,
     kèm ghi chú route đúng là `/api/default/check/alive/is-this-alive`.
  4. `scripts` thiếu `mkdir -p videos`, `chmod o+x /home/ubuntu`, `apt install ffmpeg` → đã thêm.
  5. `:80` thiếu `proxy_read_timeout` > 125s trong khi `server.js` đặt `server.timeout = 125000`
     cho replication v2 → nginx cắt ở 60s mặc định và trả 504 trước khi Node trả lời. Đã set 180s.
- **Đính chính TODO §4 (dòng `root`)**: path đúng là `/home/ubuntu/Stream-Sub-Server` (KHÔNG có
  đuôi `/videos`) — vì URL contract `subservernginxurl` đã chứa sẵn đoạn `/videos/`
  (`current-implementation-audit-2026-07.md` §3). Đặt `root` tới thư mục `videos` sẽ thành
  `.../videos/videos/...` → 404.
- **Chưa verify trên VM thật**: các sửa đổi trên mới ở mức đọc-đối-chiếu config + code, chưa chạy
  lại `scripts` end-to-end trên Oracle VM. Xem TODO §4.

---

## 4. TODO còn treo (ưu tiên giảm dần)

- [ ] **Migrate khỏi shape Free Trial trước khi hết hạn** (30 ngày/$300 kể từ 2026-07-04) — retry
  tạo lại bằng `E2.1.Micro`/`A1.Flex` khi capacity Singapore trống, hoặc chủ động upgrade PAYG nếu
  quyết định giữ `VM.Standard2.1`.
- [ ] **(2026-08-09, ưu tiên cao nhất)** Chạy lại `scripts` bản đã vá trên VM và verify bằng
  checklist §5: `ss -tlnp` thấy đủ `:80/:9100/:9150`, `curl -I http://127.0.0.1/api/default/check/alive/is-this-alive`
  ra 200, `curl -I :9150/videos/<id>/init.mpd` ra 200 + `Content-Type: application/dash+xml`.
- [x] ~~Sửa `root` trong `nginx.conf`/`nginx_sub.conf` từ path Windows dummy sang path thật trên VM
  (`/home/ubuntu/Stream-Sub-Server/videos`)~~ — **xong 2026-08-09 trong `streamingVer3`**, nhưng
  path đúng là `/home/ubuntu/Stream-Sub-Server` (không có `/videos`), xem đính chính ở §3.
- [ ] Đổi Public IP từ Ephemeral → Reserved (Instance → Attached VNICs → Primary VNIC).
- [ ] Dọn `ecosystem.config.js`: xoá app `backend` dư hoặc set `SERVERINDEX` riêng nếu cố ý chạy
  nhiều instance.
- [ ] Set `ENCODE_TYPE=6` trong `config.env` của node này (không GPU) rồi `pm2 restart --update-env`.
- [ ] Test thật `case 6` (libx264 CPU) trên VM — hiện mới verify cú pháp lệnh tay, chưa chạy full
  qua `encodeAPI.js` end-to-end.
- [ ] Cân nhắc refactor `exec()` → `spawn()` argv-array trong `encodeAPI.js` để loại bỏ hẳn lớp bug
  shell-quoting (xem [deployment-hidden-bugs-and-pitfalls.md mục 7](deployment-hidden-bugs-and-pitfalls.md)) — việc lớn, chưa quyết định làm.

---

## 5. Lệnh vận hành nhanh (nginx + PM2)

> Chạy trên VM (SSH vào bằng user `ubuntu`, **không dùng `sudo` cho lệnh `pm2`** — sudo tạo daemon
> PM2 riêng dưới root, xem [deployment-hidden-bugs-and-pitfalls.md mục 2](deployment-hidden-bugs-and-pitfalls.md)).

### nginx
```bash
sudo nginx -t                               # LUÔN chạy trước — kiểm tra config hợp lệ, không tự apply
sudo systemctl reload nginx                 # áp dụng config mới, không drop connection đang có (khuyến nghị)
sudo systemctl restart nginx                # restart toàn bộ — chỉ dùng khi reload không đủ (VD đổi listen port)
sudo systemctl status nginx --no-pager      # xem trạng thái hiện tại
sudo journalctl -u nginx -n 50 --no-pager   # xem log chi tiết nếu lỗi
```

### PM2
```bash
cd ~/Stream-Sub-Server

pm2 start server.js                # lần đầu start (app tự đặt tên "server" theo tên file)
pm2 restart server                 # restart, GIỮ env cũ đã cache lúc start
pm2 restart server --update-env    # restart + nạp lại config.env/biến môi trường — dùng khi vừa sửa config.env
pm2 stop server                    # dừng, không xoá khỏi danh sách quản lý
pm2 delete server                  # xoá hẳn khỏi PM2 (dọn app dư, hoặc trước khi đổi sang ecosystem.config.js)

pm2 status                         # xem tất cả process — trạng thái/uptime/số lần restart
pm2 logs server --lines 50 --nostream   # xem 50 dòng log gần nhất, không tail tiếp
pm2 logs server                    # tail log real-time (Ctrl+C thoát)

pm2 save                           # BẮT BUỘC sau khi start/xoá app — lưu danh sách để sống qua reboot VM
pm2 startup                        # in ra 1 lệnh sudo để PM2 tự khởi động sau reboot — chỉ cần chạy 1 lần
```
Nếu dùng `ecosystem.config.js` thay vì gọi thẳng `server.js`:
```bash
pm2 start ecosystem.config.js      # ⚠️ file hiện có 2 app trùng port (xem TODO §4) — 1 app sẽ errored
```

### Combo theo tình huống

**Sau khi sửa nginx config — bản Ver3 hiện hành (2026-08-09):**
```bash
sudo cp streamingVer3      /etc/nginx/sites-enabled/default   # chứa CẢ :80 proxy lẫn :9150 static
sudo cp nginx_subVer3.conf /etc/nginx/nginx.conf
sudo nginx -t && sudo systemctl reload nginx
sudo ss -tlnp | grep -E ':80|9100|9150'                       # BẮT BUỘC: nginx -t PASS không đảm bảo còn đủ server block
```
> Bản cũ (Ver2, chỉ dùng khi rollback — **không trộn với Ver3**):
> `sudo cp streaming /etc/nginx/sites-enabled/default` + `sudo cp nginx_sub.conf /etc/nginx/nginx.conf`

**Sau khi sửa code (`encodeAPI.js`...) hoặc `config.env`:**
```bash
pm2 restart server --update-env
pm2 logs server --lines 30 --nostream
```

**Kiểm tra toàn diện sau bất kỳ thay đổi nào (verify checklist, theo [vm-server-setup-guide.md §3.10](vm-server-setup-guide.md)):**
```bash
sudo nginx -t
curl -I http://127.0.0.1
pm2 status
sudo iptables -L INPUT -n --line-numbers
sudo systemctl is-enabled nginx
```

---

## Changelog

- **2026-07-05** — Tạo file. Tổng kết toàn bộ session deploy STORAGE node #1 lên Oracle Cloud
  (bắt đầu 2026-07-04): thông tin VM, 9 mục đã hoàn thành theo thứ tự thật, snapshot trạng thái
  hiện tại, và 7 TODO còn treo. Trỏ chéo `vm-server-setup-guide.md`,
  `deployment-hidden-bugs-and-pitfalls.md`, `ffmpeg-presets-reference.md` thay vì lặp nội dung.
- **2026-07-05** — Thêm mục 5: lệnh vận hành nhanh nginx (`test`/`reload`/`restart`/`status`/
  `journalctl`) + PM2 (`start`/`restart --update-env`/`stop`/`delete`/`status`/`logs`/`save`/
  `startup`), kèm 3 combo lệnh theo tình huống thường gặp (sửa nginx, sửa code/env, verify toàn
  diện).
- **2026-08-09** — Audit lại bộ config Ver3 (`nginx_subVer3.conf` + `streamingVer3`, commit
  2026-07-25): bổ sung snapshot §3 liệt kê 5 lỗi đã vá, đính chính path `root` trong TODO §4
  (bỏ đuôi `/videos` — URL contract đã chứa sẵn), thêm TODO verify-trên-VM, cập nhật combo lệnh
  §5 sang cặp file Ver3 kèm bước `ss -tlnp` bắt buộc. Root cause chi tiết:
  [deployment-hidden-bugs-and-pitfalls.md mục 8](deployment-hidden-bugs-and-pitfalls.md).
- **2026-07-05** — Ghi lệnh mục 5 ra file script riêng
  `scripts/oracle-storage-node-nginx-pm2-ops.sh` (dễ copy-từng-dòng/tinh chỉnh) và copy sạch
  `scripts/stream-sub-server-deploy.sh` từ `Stream-Sub-Server/scripts` (bỏ ASCII art không liên
  quan). Cả 2 chỉ để tham khảo, không tự động chạy.
