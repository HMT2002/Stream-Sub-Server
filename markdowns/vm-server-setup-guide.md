# VM Server Setup Guide — Provisioning & Deploy Node đa Cloud

**Tạo:** 2026-07-03
**Project:** Stream-Central-Server
**Mục đích:** File **thao tác (how-to)** để dựng một VM thành CENTRAL node hoặc STORAGE/SUB
node của dự án — không phân biệt cloud nào. Có một **khung chuẩn (§3)** áp dụng mọi provider,
rồi mỗi provider điền vào khung đó theo cùng cấu trúc mục con → thêm provider mới = copy khung,
điền, không phải thiết kế lại.
**Related files:**
- [multi-cloud-free-tier-node-deployment.md](multi-cloud-free-tier-node-deployment.md) — file
  **quyết định/so sánh** (WHY chọn provider nào, pricing, rủi ro tính phí ngầm, free-tier policy).
  File đó có sẵn checklist OCI ở §5 nhưng thiên về rationale; file này là bản **operational/
  step-by-step thuần**, tổng quát hoá cho nhiều provider và sẽ là bản cập nhật khi hai file lệch nhau.
- [nginx-config-operations-guide.md](nginx-config-operations-guide.md) — vận hành nginx sau khi
  VM đã có (path resolution, fail-fast, include).
- [NGINX_FFmpeg DASH Streaming.md](NGINX_FFmpeg%20DASH%20Streaming.md) — config DASH/CORS/auth_request.
- [central-node-architecture-comparison.md](central-node-architecture-comparison.md) §8.7.6 —
  quyết định hub-and-spoke (`CENTRAL_URL` + `NODE_SECRET`).
- [node-central-backlog-and-decisions.md](node-central-backlog-and-decisions.md) — trạng thái
  implement heartbeat/deploy thực tế.
- `files/nginx_central.conf`, `files/nginx_sub.conf` — config nguồn thật để copy lên VM (KHÁC với
  ví dụ minh hoạ trong markdown; xem SKILL.md §3.3).
- [deployment-hidden-bugs-and-pitfalls.md](deployment-hidden-bugs-and-pitfalls.md) — tra nhanh
  theo **triệu chứng** khi deploy bị lỗi (dotenv silent fail, PM2 crash-loop, PM2 sudo vs
  non-sudo daemon, nginx `error_page` che giấu 502 thành 404...). File này (vm-server-setup-guide)
  tập trung **thao tác đúng ngay từ đầu**; file kia tập trung **debug khi đã sai**.

**Scope note:** File chỉ dựng **hạ tầng OS + runtime + reverse proxy**. Logic app (Node.js
central/storage code) không nằm trong phạm vi này — xem `PROJECT_SUMMARY_CENTRAL.md` /
`PROJECT_SUMMARY_SUB.md`. Pricing/free-tier limit **không** lặp lại ở đây, luôn trỏ về
`multi-cloud-free-tier-node-deployment.md` để tránh hai nguồn số liệu lệch nhau.

> ⚠️ Console/CLI của mọi provider đổi UI liên tục — bước nào đánh dấu `cần kiểm chứng` nghĩa là
> chưa chạy trên VM thật trong phiên tạo file, đối chiếu docs chính thức trước khi làm theo
> (nguồn: SKILL.md §2.2/§2.6).

---

## 0. TL;DR

- Mọi provider đi qua **cùng 10 bước** ở §3 (instance → network → firewall 2 tầng → SSH →
  OS baseline → runtime stack → nginx theo vai trò → deploy code/PM2 → domain/TLS optional →
  hardening/verify). Khác biệt giữa các cloud chỉ nằm ở **§X.0 Đặc thù riêng** của mỗi provider.
- **Trước khi làm bất cứ gì**, xác định VM này là **CENTRAL** hay **STORAGE/SUB** (§2) — stack
  cài và nginx config khác nhau hẳn.
- **Oracle Cloud (§4)** đã viết đầy đủ theo khung. Các provider khác (§5–§9) mới là **skeleton**
  — cùng khung mục con, chờ điền khi thật sự deploy lên đó.
- Firewall luôn **2 tầng**: cloud security group/NSG **và** OS-level (ufw/iptables) — quên tầng
  OS là lỗi phổ biến nhất ("mở port ở console rồi mà vẫn không vào được").

---

## 1. Cách dùng & mở rộng file này

1. Mỗi **provider mới** = một section cấp `##` mới (sau §9), copy nguyên cấu trúc mục con
   `X.0`–`X.10` của khung ở §3, giữ đúng số thứ tự để dễ so sánh giữa các provider.
2. Nội dung **chung cho mọi cloud** (cách cài Node.js, PM2, nginx theo vai trò, hardening) chỉ
   viết **một lần** ở §3 và §10–§11; section riêng provider chỉ nêu **phần khác biệt** + lệnh cụ
   thể của bước đó, tránh lặp toàn bộ quy trình.
3. Theo quy tắc SKILL.md §3.1: **không xoá đè** — khi một bước bị đổi (VD: Oracle đổi UI console),
   đánh dấu `> [SUPERSEDED yyyy-mm-dd]` trên nội dung cũ, thêm `> [UPDATED yyyy-mm-dd]` bên dưới.
4. Lệnh nào chưa chạy thật trên VM của dự án → giữ nguyên cờ `cần kiểm chứng`, không tự ý bỏ cờ.

---

## 2. Bước 0: xác định vai trò VM trước khi setup

| | **CENTRAL node** | **STORAGE/SUB node** |
|---|---|---|
| Vai trò | Control plane thuần — orchestrator, MongoDB Atlas client | Lưu + serve file HLS/DASH, encode FFmpeg |
| Node.js app port | `127.0.0.1:3000` (nội bộ, sau nginx) | `127.0.0.1:9100` (app) |
| nginx | Reverse proxy `:80` → Node `:3000`. **Không serve file segment.** | `:9100` (proxy tới app) + `:9150` serve file `videos/` trực tiếp qua `sendfile`, có `auth_request` |
| FFmpeg | Không cần | **Bắt buộc** (encode HLS/DASH) |
| DB | Không (chỉ central chạm MongoDB — xem `node-central-backlog-and-decisions.md` §2) | Không (node không chạm DB, feed qua HTTP outbound) |
| Env bắt buộc | `DATABASE`, `DATABASE_PASSWORD`, `JWT_SECRET`, ... (xem `PROJECT_SUMMARY_CENTRAL.md` §5) | `CENTRAL_URL`, `NODE_SECRET` (+ `NODE_ID` nếu không tự register) — pattern hub-and-spoke, xem `central-node-architecture-comparison.md` §8.7.6 |
| Config nguồn | `files/nginx_central.conf` | `files/nginx_sub.conf` + `files/sites-enabled_sub.conf` |

Toàn bộ §3–§9 dưới đây áp dụng cho **cả hai vai trò**, chỉ khác ở bước §X.6 (runtime stack) và
§X.7 (config nginx) — sẽ ghi rõ nhánh CENTRAL/STORAGE ở từng bước.

---

## 3. Khung chuẩn (provider-agnostic) — 10 bước

> Mỗi provider ở §4–§9 điền cụ thể vào các bước này. Bước nào không đổi giữa các provider (VD:
> cài Node.js) chỉ giải thích **một lần** ở đây; section provider chỉ trỏ ngược lại.

### 3.1 Provision compute instance
Chọn shape/size + OS image. Ubuntu LTS (22.04/24.04) là lựa chọn mặc định cho toàn bộ khung này
— cùng họ Debian/apt với hướng dẫn nginx đã có (`nginx-config-operations-guide.md` viết cho
Ubuntu). Ghi chú riêng free-tier/giá mỗi provider → xem `multi-cloud-free-tier-node-deployment.md`.

### 3.2 Networking — Public IP
Gán public IPv4; nếu provider hỗ trợ **static/reserved IP miễn phí trong free tier**, đổi từ
ephemeral → reserved ngay sau khi VM chạy (tránh đổi IP mỗi lần reboot làm hỏng DNS/config).

### 3.3 Firewall — LUÔN 2 tầng
1. **Cloud-level** (Security List/NSG/Security Group tuỳ tên provider): mở inbound
   `22` (SSH), `80`/`443` (HTTP/HTTPS), thêm `9150` nếu là STORAGE node.
2. **OS-level** (ufw hoặc iptables): image một số provider (Oracle — xem §4.3) có iptables
   chặn sẵn dù cloud-level đã mở. Chuẩn tối giản dùng `ufw`:
```bash
sudo apt update
sudo apt install -y ufw
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
# STORAGE node thêm:
sudo ufw allow 9150/tcp
sudo ufw enable
sudo ufw status verbose
```
Nguồn: Ubuntu Server docs — Security/Firewall (`ufw`). — https://ubuntu.com/server/docs/security-firewall

### 3.4 SSH access
Tạo/khai báo SSH key pair lúc provision (đa số provider bắt buộc key auth, không cho password
by default cho image cloud). **Tải private key về ngay lúc tạo** — nhiều provider chỉ cho tải
một lần. Login lần đầu bằng user mặc định của distro/provider (thường `ubuntu`).

### 3.5 OS baseline
```bash
sudo apt update && sudo apt upgrade -y
sudo timedatectl set-timezone Asia/Ho_Chi_Minh   # hoặc UTC tuỳ convention log
```
Nếu RAM ≤ 1 GB (phổ biến ở free tier), thêm swap để tránh OOM-kill khi build native module:
```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
Nguồn: DigitalOcean community — "How To Add Swap Space" (pattern chuẩn, provider-agnostic). —
https://www.digitalocean.com/community/tutorials/how-to-add-swap-space-on-ubuntu-22-04

### 3.6 Cài runtime stack dự án
Chung cho mọi provider (Ubuntu/Debian base):
```bash
# Node.js LTS qua NodeSource (khuyến nghị hơn apt mặc định vì bản apt Ubuntu thường cũ)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs git build-essential
node -v && npm -v

# PM2 — process manager, giữ app sống qua reboot/crash
sudo npm install -g pm2
```
Nguồn: NodeSource distributions — https://github.com/nodesource/distributions

**Nhánh STORAGE/SUB node — thêm FFmpeg:**
```bash
sudo apt install -y ffmpeg
ffmpeg -version
```
⚠️ apt Ubuntu có thể ship FFmpeg cũ hơn build chính thức — nếu cần bản mới nhất/có codec cụ thể,
đối chiếu `ffmpeg.org/download.html` (static build) trước khi thay bản apt. `cần kiểm chứng` với
requirement thật của pipeline (`encode_explain.md`).

**ARM (aarch64, VD Oracle A1 free)**: `apt`/`npm`/`pm2` chạy bình thường trên ARM64 — không phải
distro cắt xén. Một số npm native binding cần build từ source → `build-essential` ở trên đã đủ
phần lớn trường hợp; nếu vẫn fail, `cần kiểm chứng` từng package cụ thể.

### 3.7 Cài nginx theo vai trò
```bash
sudo apt install -y nginx
sudo nginx -t
```
- **CENTRAL**: copy nội dung `files/nginx_central.conf` → `/etc/nginx/nginx.conf` (đọc kỹ + đối
  chiếu SKILL.md §3.3 — đây là config nguồn, chỉ đề xuất, người dùng tự copy/deploy).
- **STORAGE/SUB**: copy `files/nginx_sub.conf` + `files/sites-enabled_sub.conf`. **Đổi `root`
  trong config** từ path dummy (`/home/ubuntu/apps/Stream-Sub-Server/videos`) sang path thật trên
  VM trước khi reload.
- Sau khi copy: `sudo nginx -t && sudo systemctl reload nginx` — validate trước, không reload mù
  (xem `nginx-config-operations-guide.md` §2 — nginx fail-fast, không tự tạo `logs/`/`temp/`).
- Trên Linux, `sendfile`/`aio`/`directio` trong `nginx_sub.conf` **bật được** (config đã ghi chú
  sẵn — chỉ tắt khi test Windows local).

### 3.8 Deploy code + PM2
```bash
git clone <repo-url> ~/apps/<central-or-sub-repo>
cd ~/apps/<repo>/backend   # hoặc thư mục app tương ứng
npm install
cp config.env.example config.env   # điền env theo bảng §2 (CENTRAL vs STORAGE)
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # in ra 1 lệnh sudo — chạy lệnh đó để PM2 tự khởi động lại sau reboot VM
```
Nguồn: PM2 docs — Startup script generator. — https://pm2.keymetrics.io/docs/usage/startup/

> [UPDATED 2026-07-04] Hai gotcha đã gặp thật khi deploy `Stream-Sub-Server` lên VM, verify qua
> `pm2 status`/`pm2 logs`:
> 1. **Repo hiện KHÔNG có `config.env.example`** — lệnh `cp config.env.example config.env` ở
>    trên là giả định file mẫu tồn tại, thực tế phải **tự tạo/copy `config.env` thủ công** (VD
>    `scp` từ máy dev lên VM, vì file này nằm trong `.gitignore` nên `git clone` không mang
>    theo). **Thiếu file này server crash ngay khi start**: `dotenv.config()` không throw khi
>    file không tồn tại, nhưng code đọc `process.env.DATABASE.replace(...)` ở
>    `config/database/db_index.js` sẽ crash với `Cannot read properties of undefined (reading
>    'replace')` vì biến đó `undefined` — `pm2 status` lúc đó thường ra **bảng rỗng** (không có
>    process nào, không phải "errored" rõ ràng) nếu chưa từng `pm2 start` thành công lần nào.
> 2. **`ecosystem.config.js` của `Stream-Sub-Server` có 2 app entry trùng nhau** (`sub-server-0`
>    và `backend`, cùng chạy `./server.js` với cùng `config.env`) → cả 2 tính ra **cùng port**
>    (theo công thức `PORT + SERVERINDEX*SERVERREP`) → app start sau bị `EADDRINUSE`, hiện trong
>    `pm2 status` là 1 online + 1 errored/restart loop liên tục. Không phải lỗi thao tác — đây là
>    cấu hình dư sẵn trong file. Xử lý: `pm2 delete backend` (hoặc app dư) sau khi xác nhận 1 app
>    chạy ổn, HOẶC tự sửa `ecosystem.config.js` nếu có ý định dùng cả 2 (cần khác `SERVERINDEX`
>    mỗi app) — việc sửa code này nằm ngoài phạm vi file operational, tự quyết định theo nhu cầu
>    dự án.

### 3.9 Domain/TLS (optional)
Nếu cần HTTPS thay vì IP trần: trỏ A record về Public/Reserved IP → chạy Certbot:
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.example
```
Nguồn: Certbot official instructions (chọn Nginx + hệ điều hành). — https://certbot.eff.org/instructions
`cần kiểm chứng` khi áp dụng thật — dự án hiện dùng IP trần cho node theo `central-node-architecture-comparison.md`.

### 3.10 Hardening & verify checklist
Xem khung đầy đủ ở §11 (chung mọi provider). Verify tối thiểu trước khi coi VM "xong":
```bash
sudo nginx -t                       # config hợp lệ
curl -I http://127.0.0.1             # nginx trả response
pm2 status                          # app đang chạy, không restart loop
sudo ufw status verbose             # đúng port đã mở
sudo systemctl is-enabled nginx     # tự start sau reboot
```

---

## 4. Oracle Cloud (OCI) Always Free

> Rationale chọn OCI (egress 10 TB, trade-off reclaim/capacity) đã phân tích đầy đủ ở
> `multi-cloud-free-tier-node-deployment.md` §3.1/§4 — không lặp lại ở đây, chỉ thao tác.

### 4.0 Đặc thù riêng
- **Home region cố định vĩnh viễn**, chọn sai phải huỷ account tạo lại — quyết **trước** khi
  qua §4.1. Gợi ý cho VN: Singapore (`ap-singapore-1`) hoặc Tokyo (latency); region đông
  (Frankfurt/Milan) dễ có capacity ARM hơn.
- **"Out of host capacity"** khi tạo shape A1 (ARM) ở region đông — không phải lỗi thao tác.
- Ubuntu image của Oracle **cài sẵn iptables chặn** → tầng OS-level (§3.3) **bắt buộc** làm, kể
  cả khi cloud-level Security List đã mở port.

> [UPDATED 2026-07-04] Đã deploy thật 1 STORAGE node lên Singapore (AD-1), xác nhận thêm:
> - **Cả 2 shape always-free — `E2.1.Micro` (AMD) VÀ `A1.Flex` (ARM) — bị "Out of host
>   capacity" CÙNG LÚC** ở Singapore AD-1. Không phải hiếm gặp riêng ARM như note cũ ở trên
>   giả định — cần chuẩn bị phương án dự phòng cho cả 2 shape.
> - **Thứ tự xử lý đã thử thực tế** (theo mức tốn công tăng dần):
>   1. Đổi Availability Domain (nếu region có AD-2/AD-3 — `cần kiểm chứng` Singapore có mấy AD).
>   2. Thử shape always-free còn lại (2 pool capacity tách biệt, có thể 1 cái còn chỗ).
>   3. Nâng **PAYG** (ưu tiên capacity, vẫn $0 nếu ở trong hạn always-free — xem
>      `multi-cloud-free-tier-node-deployment.md` §5.6).
>   4. **Dùng tạm shape trả phí trong Free Trial** (đã làm thật ở session này: chọn
>      `VM.Standard2.1`, Ubuntu 22.04 Minimal) khi cả 2 always-free đều hết và cần VM chạy
>      ngay. Trial tiêu **credit prepaid ($300/30 ngày, `cần kiểm chứng` điều khoản hiện hành)**,
>      KHÔNG trừ thẻ trực tiếp — miễn là **không bấm "Upgrade to Paid Account"**. Phải đặt lịch
>      migrate về shape always-free (hoặc chủ động upgrade PAYG) **trước khi hết trial**, nếu
>      không instance ngoài always-free sẽ tự bị stop.
> - Ruleset iptables mặc định của Oracle + lệnh fix **đã verify thật** trên VM — xem §4.3 bên
>   dưới (thay thế cờ `cần kiểm chứng` cũ).

### 4.1 Provision compute instance
1. Console → Compute → Instances → **Create instance**.
2. **Edit → Change shape**:
   - AMD x86 `VM.Standard.E2.1.Micro` — ít gặp out-of-capacity hơn, đủ cho test nhẹ.
   - ARM `VM.Standard.A1.Flex` — tick, set ≤ 2 OCPU / 12 GB (giới hạn sau đợt cắt 06/2026,
     `cần kiểm chứng` số hiện hành trên oracle.com/cloud/free).
3. **Image**: Canonical Ubuntu 24.04 (bản `Minimal aarch64` nếu ARM — vẫn full `apt`/systemd,
   không phải distro cắt xén).
4. **Boot volume**: tối thiểu **47 GB** (không tạo nhỏ hơn được), nằm trong 200 GB block free.
5. **SSH key**: chọn "Generate a key pair" → **tải cả private + public key ngay lúc này** —
   không tải là mất quyền SSH vĩnh viễn với instance đó.

> [UPDATED 2026-07-04] Chi tiết các field hay gây rối trong bước tạo instance (verify thật):
>
> **Boot Volume section:**
> - **"Specify a custom boot volume size and performance setting"**: không tick → mặc định
>   ~50GB, performance "Balanced" (10 VPU/GB, nằm trong always-free). Nên **tick** để tăng size
>   trong pool 200GB free (VD 100GB) nếu VM này chứa video — nhưng nhớ **200GB là pool chung cho
>   CẢ TENANCY**, không phải riêng VM này, đừng dùng hết nếu định tạo thêm VM khác. Giữ
>   performance ở **Balanced**, đổi "Higher Performance" sẽ tính phí ngoài free tier.
> - **"Use in-transit encryption"**: mã hoá dữ liệu lúc truyền (khác encryption at rest ở dưới),
>   miễn phí. `cần kiểm chứng`: một số shape nhỏ (VD `E2.1.Micro`) field này có thể bị xám —
>   không phải lỗi thao tác nếu vậy, bỏ qua.
> - **"Encrypt this volume with a key that you manage"**: **không tick**. Mặc định Oracle đã tự
>   mã hoá at-rest bằng Oracle-managed key (miễn phí, tự động). Tick vào đây cần tự dựng OCI
>   Vault trước — chỉ cần cho compliance/enterprise, không cần cho node test.
> - **Block Volumes section**: bỏ qua, không cần thêm — video serve trực tiếp từ path trên boot
>   volume (`root` trong `nginx_sub.conf`), thêm Block Volume riêng chỉ tốn thêm pool 200GB mà
>   không lợi ích, lại phải tự mount thủ công.
>
> **Networking (trong cùng wizard) — xem chi tiết đầy đủ ở §4.2 bên dưới (đã update).**
>
> **Review page trước khi bấm Create — 3 field sai sẽ phải xoá instance làm lại:**
> - **Image** đúng chưa (không đổi được sau khi tạo).
> - **SSH key đã add chưa** (Review phải ghi rõ "SSH key added" / tên public key) — thiếu bước
>   này = tạo xong không SSH được, phải xoá tạo lại.
> - **"Assign a public IPv4 address" = Yes** — xem §4.2, đây là field hay bị bỏ sót nhất.
> - Shape/Boot volume size sai thì sửa được sau (resize/tăng, không giảm được) nhưng phiền hơn.

### 4.2 Networking — Public IP
Networking section lúc tạo: tick **Assign a public IPv4 address**. Sau khi instance `RUNNING`:
Instance → Attached VNICs → Primary VNIC → IP addresses → đổi **Ephemeral → Reserved**
(1 Reserved IP miễn phí trong always-free).

> [UPDATED 2026-07-04] Chi tiết wizard Networking lúc tạo instance (hay gây confusion nhất,
> verify thật):
> - **Primary network (VCN)**: nếu là VM đầu tiên trong compartment/region → mặc định
>   "Create new virtual cloud network" (không có VCN nào để chọn "existing" nếu chưa từng tạo).
>   Đây là đường đi bình thường, không phải lỗi — OCI tự dựng VCN + Public Subnet + Internet
>   Gateway + Route Table + Security List cùng lúc.
> - **Subnet**: phải là **Public Subnet** (không phải Private) — nếu chọn nhầm Private, phần
>   gán Public IP bên dưới sẽ bị disable/ẩn hoàn toàn.
> - **Primary VNIC — Private IPv4 address bị mask/xám**: **bình thường**, do checkbox
>   "Automatically assign private IPv4 address" mặc định tick sẵn → field nhập tay tự xám. Đây
>   là IP nội bộ VCN (10.x.x.x), không dùng để SSH từ ngoài — bỏ qua, không cần sửa.
>   **Đừng nhầm với "Public IPv4 address"** — đây là checkbox riêng, không bị mask, phải tự tick
>   "Assign a public IPv4 address" (IP gán ở đây là **Ephemeral**, đổi Reserved sau khi
>   `RUNNING` như hướng dẫn gốc ở trên).
> - **Nếu checkbox Public IP bị disable/xám hẳn** (không phải chỉ chưa tick) → chắc chắn đang
>   trỏ vào Private Subnet. Cách chắc ăn nhất: huỷ instance creation, vào **Networking → Virtual
>   Cloud Networks → Start VCN Wizard → "Create VCN with Internet Connectivity"** (không chọn
>   "Create VCN Only") — wizard này tự dựng đúng 1 Public Subnet (kèm IGW) + 1 Private Subnet rõ
>   ràng theo tên, tránh lặp lại nhầm lẫn. Quay lại Create Instance, chọn "Select existing VCN"
>   → chọn đúng subnet có chữ "public" trong tên.
> - **Security List mặc định OCI tự tạo chỉ mở sẵn port 22** — chưa mở `80`/`443`/`9150`, phải
>   tự thêm Ingress Rule sau (xem §4.3).

### 4.3 Firewall 2 tầng (chỗ hay kẹt nhất)
1. **Cloud**: VCN → Security List (hoặc NSG) → Ingress Rules → mở `22`, `80`, `443` (+ `9150`
   nếu STORAGE node).
2. **OS**: theo khung §3.3 (`ufw`). Vì Oracle preload iptables rules riêng, có thể cần flush/
   điều chỉnh rule cũ trước khi `ufw` có hiệu lực đúng — `cần kiểm chứng` lệnh chính xác trên
   bản Ubuntu 24.04 hiện hành; tham khảo cộng đồng: rssnyder provisioning gist (đã dẫn ở
   `multi-cloud-free-tier-node-deployment.md` §7).

> [SUPERSEDED 2026-07-04] Note "cần kiểm chứng" ở mục 2 phía trên — đã verify thật trên VM
> (Ubuntu 22.04 Minimal, shape `VM.Standard2.1`; `cần kiểm chứng` xem ruleset có giống hệt trên
> `E2.1.Micro`/`A1.Flex` không, nhiều khả năng có vì đây là default của base cloud image, không
> phụ thuộc shape).
>
> [UPDATED 2026-07-04] **Triệu chứng nhận diện tầng nào đang chặn:**
> - Curl/connect từ ngoài bị **timeout** (không phản hồi gì) → thường là **Security List (cloud)**
>   đang âm thầm drop gói tin (chưa có Ingress Rule cho port đó).
> - Curl/connect bị **"Connection refused" gần như tức thì** → thường là **iptables (OS)** REJECT
>   chủ động (trả `icmp-host-prohibited`).
> - Trong session verify, cả 2 tầng đều đang chặn cùng lúc (Security List chưa mở port do quên
>   bước, VÀ iptables mặc định OCI cũng REJECT) → phải sửa **cả hai** mới thông.
>
> **Ruleset iptables mặc định thật của Oracle Ubuntu image** (`sudo iptables -L INPUT -n
> --line-numbers`):
> ```
> Chain INPUT (policy ACCEPT)
> num  target     prot opt source               destination
> 1    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            state RELATED,ESTABLISHED
> 2    ACCEPT     icmp --  0.0.0.0/0            0.0.0.0/0
> 3    ACCEPT     all  --  0.0.0.0/0            0.0.0.0/0            (loopback, -i lo — cột
>                                                                      interface ẩn nếu không dùng -v)
> 4    ACCEPT     tcp  --  0.0.0.0/0            0.0.0.0/0            state NEW tcp dpt:22
> 5    REJECT     all  --  0.0.0.0/0            0.0.0.0/0            reject-with icmp-host-prohibited
> ```
> Rule 5 REJECT-all chặn **mọi thứ** ngoài loopback/established/ICMP/port22 — đúng khớp cảnh báo
> ở §4.0. `ufw` **chưa cài sẵn** trên image (`ufw: command not found` lúc verify) — nên đây là
> **iptables thuần**, không phải `ufw` bị cấu hình sai.
>
> **Lệnh fix đã chạy thật, xác nhận thông:**
> ```bash
> # Insert ACCEPT cho từng port TRƯỚC rule REJECT (rule 5 lúc verify — kiểm tra lại
> # bằng "iptables -L INPUT -n --line-numbers" trước khi chạy, số rule có thể khác)
> sudo iptables -I INPUT 5 -p tcp --dport 80 -m state --state NEW -j ACCEPT
> sudo iptables -I INPUT 6 -p tcp --dport 443 -m state --state NEW -j ACCEPT
> sudo iptables -I INPUT 7 -p tcp --dport 9150 -m state --state NEW -j ACCEPT
>
> # Verify — REJECT phải nằm CUỐI CÙNG, 3 rule ACCEPT mới nằm trước nó
> sudo iptables -L INPUT -n --line-numbers
> ```
> ⚠️ **Không đụng rule `tcp dpt:22`** — xoá nhầm là mất SSH vĩnh viễn (phải cứu bằng Console
> Serial Console). Không mở port `9100` (Node app nội bộ) — theo kiến trúc dự án, public traffic
> chỉ nên đi qua nginx (`80`/`443`/`9150`), giữ `9100` internal-only dù Node hiện bind `0.0.0.0`
> (code chưa tự giới hạn qua loopback, firewall là lớp chặn thật sự cho việc này).
>
> **Bắt buộc lưu rule để sống sót qua reboot** (nếu không, reboot là mất hết, quay lại y hệt lúc
> đầu — rule iptables chạy tay không tự persist):
> ```bash
> sudo apt install -y iptables-persistent   # hỏi "Save current IPv4 rules?" → chọn Yes
> sudo netfilter-persistent save
> ```
> **Ping (ICMP) không hoạt động dù các port trên đã thông — đây là bình thường, không phải lỗi.**
> Ping dùng ICMP Echo (type 8), khác hẳn TCP — Security List mặc định chỉ mở ICMP type 3 nội bộ,
> không mở Echo từ internet. Không cần thiết cho mục tiêu dự án (verify dùng `curl`, không dùng
> ping — xem §3.10/§4.10). Muốn bật: thêm Ingress Rule Security List, Protocol ICMP, Type `8`,
> Source `0.0.0.0/0`.

### 4.4 SSH access
```bash
chmod 600 ssh-key-*.key
ssh -i ssh-key-*.key ubuntu@<reserved-public-ip>
```

> [UPDATED 2026-07-04] **Client Windows — `chmod` không áp dụng, cần cách khác** (verify thật):
> Lỗi thường gặp: `Load key "...": bad permissions` hoặc `UNPROTECTED PRIVATE KEY FILE`.
> Nguyên nhân: NTFS không dùng POSIX permission bits như `chmod`. Cách sửa phụ thuộc **terminal
> đang chạy `ssh`**, không trộn 2 cách cho cùng 1 file:
>
> **PowerShell** (dùng `ssh.exe` gốc Windows, đọc theo ACL):
> ```powershell
> icacls "C:\path\to\key.key" /inheritance:r
> icacls "C:\path\to\key.key" /grant:r "$($env:USERNAME):(R)"
> ssh -i "C:\path\to\key.key" ubuntu@<public-ip>
> ```
> **Git Bash** (dùng `ssh.exe` riêng của MSYS/MinGW, đọc theo POSIX mode giả lập — KHÔNG đọc ACL
> Windows do `icacls` set, nên nếu đã chạy `icacls` mà vẫn `bad permissions` → đổi sang lệnh này):
> ```bash
> chmod 600 "/d/path/to/key.key"     # path kiểu Git Bash: ổ đĩa viết thường + "/"
> ssh -i "/d/path/to/key.key" ubuntu@<public-ip>
> ```
> Nếu vẫn lỗi sau khi dùng đúng cách theo terminal đang chạy → có thể ổ chứa key không phải NTFS
> (VD FAT32/exFAT không hỗ trợ ACL/permission bits đúng cách) — chuyển key sang ổ NTFS.

### 4.5 OS baseline
Theo khung §3.5 nguyên văn. RAM tối thiểu khuyến nghị: ~1 GB đủ Node+nginx idle (300–500 MB);
nếu dùng AMD Micro (1 GB đúng mức) → thêm swap 1–2 GB theo lệnh §3.5.

### 4.6 Runtime stack
Theo khung §3.6 nguyên văn (Node.js NodeSource + PM2; + FFmpeg nếu STORAGE). Trên A1 ARM, FFmpeg
software-encode chạy được nhưng CPU-only (free tier không GPU → không NVENC) — chỉ hợp
control-plane hoặc serve/relay, không hợp làm node encode chính cho tải nặng.

### 4.7 nginx theo vai trò
Theo khung §3.7 nguyên văn — không có khác biệt riêng Oracle.

### 4.8 Deploy code + PM2
Theo khung §3.8 nguyên văn.

### 4.9 Domain/TLS
Theo khung §3.9 (optional, chưa áp dụng thật cho dự án).

### 4.10 Hardening & verify
Theo khung §3.10 + lưu ý riêng OCI: **giữ heartbeat/cron chạy đều** — Oracle có thể coi
instance/account **idle ≥ 30 ngày** là abandoned và reclaim. Node thiết kế stateless (registry
nằm ở MongoDB Atlas, không nằm trên node) nên mất instance = dựng lại, không mất data — xem
`multi-cloud-free-tier-node-deployment.md` §4.

---

## 5. Hetzner Cloud — 🅿️ skeleton

Chưa deploy thật; ghi trước phần đã biết từ `multi-cloud-free-tier-node-deployment.md` §3.2, còn
lại điền theo khung §3 khi triển khai.

### 5.0 Đặc thù riêng (đã biết)
- Hard price cap thật (không overage bất ngờ) — khác hẳn Big 3/OCI.
- Tắt nguồn server **vẫn tính tiền** (giữ disk+IP); muốn dừng hẳn phải **xoá** instance
  (snapshot trước nếu cần).
- Không có free trial; verify ID bắt buộc.

### 5.1–5.10
`TODO` — điền khi thật sự provision (Hetzner Cloud Console hoặc `hcloud` CLI). Dự kiến §5.3
(firewall) đơn giản hơn Oracle vì Hetzner Cloud Firewall là 1 tầng cloud-level rõ ràng, nhưng vẫn
nên giữ `ufw` OS-level theo khung §3.3 làm defense-in-depth.

---

## 6. AWS EC2 — 🅿️ skeleton

### 6.0 Đặc thù riêng (đã biết)
- EC2 **không nằm trong always-free** — có hạn (12 tháng legacy / cửa sổ 6 tháng account mới).
- Security Group là cloud-level firewall (mặc định deny inbound, phải tự thêm rule) — vẫn cần
  OS-level `ufw` theo khung §3.3.

### 6.1–6.10
`TODO` — điền khi thật sự provision. Ghi chú: AMI Ubuntu chính thức của Canonical trên AWS Marketplace,
user mặc định thường là `ubuntu`.

---

## 7. Azure — 🅿️ skeleton

### 7.0 Đặc thù riêng (đã biết)
- B1S nằm ở tầng **12-month free**, không phải always-free — hết hạn tự chuyển PAYG, **không có
  hard spending cap** sau khi upgrade.
- NSG (Network Security Group) là cloud-level firewall.

### 7.1–7.10
`TODO`.

---

## 8. GCP — 🅿️ skeleton

### 8.0 Đặc thù riêng (đã biết)
- e2-micro **always-free vĩnh viễn** nhưng **chỉ 1 GB egress/tháng** và giới hạn 3 region
  (us-west1/us-central1/us-east1) — không hợp serve video, chỉ hợp control-plane nhẹ.
- **Không có hard spending cap** ở trạng thái Paid — budget alert chỉ gửi email, không tự dừng
  dịch vụ. Xem `multi-cloud-free-tier-node-deployment.md` §2.4 trước khi upgrade Paid.
- VPC Firewall Rules là cloud-level; default image Debian/Ubuntu GCP thường **không** preload
  iptables chặn như Oracle, nhưng vẫn nên set `ufw` theo khung.

### 8.1–8.10
`TODO`.

---

## 9. Vultr — 🅿️ skeleton

### 9.0 Đặc thù riêng (đã biết)
- Không always-free (~$2.5+/th), có $100 credit trial.
- Bandwidth free thấp hơn Hetzner nhiều (~2–3 TB).

### 9.1–9.10
`TODO`.

---

## 10. Sau khi VM sẵn sàng — nối sang cấu hình nginx chi tiết

File này dừng ở mức "nginx chạy, `nginx -t` pass, app PM2 sống". Chi tiết directive-by-directive
(CORS headers, `auth_request` fail-open tạm thời, MIME types cho DASH/HLS, cách A vs cách B cho
site-enabled) **không lặp lại ở đây** — xem:
- `nginx-config-operations-guide.md` — vận hành/troubleshoot chung (path, log, fail-fast).
- `NGINX_FFmpeg DASH Streaming.md` — config DASH/CORS/auth_request cụ thể.
- `files/nginx_central.conf`, `files/nginx_sub.conf`, `files/sites-enabled_sub.conf` — config
  nguồn thật.

---

## 11. Security hardening checklist (chung mọi provider)

> Mức tối thiểu hợp lý cho VM public-facing, không thay thế đánh giá bảo mật đầy đủ. Dự án hiện
> để JWT TTL/admin route lỏng cho giai đoạn test (`SKILL.md` §4) — checklist này chỉ ở tầng OS/VM.

- [ ] Vô hiệu hoá SSH password login, chỉ key-based: `PasswordAuthentication no` trong
      `/etc/ssh/sshd_config`, sau đó `sudo systemctl restart sshd`.
- [ ] `ufw`/Security Group chỉ mở đúng port cần (`22`, `80`, `443`, `9150` nếu STORAGE) —
      không mở dải rộng "để cho chắc".
- [ ] `sudo apt update && sudo apt upgrade -y` định kỳ (hoặc bật `unattended-upgrades` cho
      security patch tự động — `cần kiểm chứng` mức độ phù hợp với node cần uptime ổn định).
- [ ] Không dùng user `root` để chạy app/PM2 — tạo non-root sudo user riêng.
- [ ] `.env`/`config.env` **không** commit vào git (đã có `.gitignore` ở repo backend — kiểm tra
      lại khi setup VM mới).
- [ ] Reserved/static IP thay ephemeral — tránh IP đổi làm gãy `CENTRAL_URL` các node khác đang trỏ tới.
- [ ] `pm2 startup` + `pm2 save` đã chạy — app tự sống lại sau khi VM reboot (bảo trì provider,
      out-of-capacity resize, v.v.).

---

## 12. References

**Chuẩn OS/hardening (provider-agnostic):**
- Ubuntu Server docs, Security/Firewall (`ufw`) — https://ubuntu.com/server/docs/security-firewall
- DigitalOcean community, "How To Add Swap Space on Ubuntu 22.04" — https://www.digitalocean.com/community/tutorials/how-to-add-swap-space-on-ubuntu-22-04
- NodeSource distributions (cài Node.js LTS) — https://github.com/nodesource/distributions
- PM2 docs, Startup script — https://pm2.keymetrics.io/docs/usage/startup/
- Certbot official instructions — https://certbot.eff.org/instructions

**Oracle Cloud (đầy đủ hơn ở `multi-cloud-free-tier-node-deployment.md` §7):**
- OCI Free Tier docs — https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- Community provisioning gist (shape/SSH/firewall thực tế) — https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd

**Nội bộ dự án:**
- `multi-cloud-free-tier-node-deployment.md` — pricing/policy/rationale.
- `nginx-config-operations-guide.md`, `NGINX_FFmpeg DASH Streaming.md` — nginx chi tiết.
- `central-node-architecture-comparison.md` §8.7.6 — hub-and-spoke `CENTRAL_URL`/`NODE_SECRET`.

---

## 13. TODO / cần kiểm chứng

- [x] ~~Chạy thật khung §3 trên 1 Oracle instance mới, xác nhận từng lệnh (đặc biệt §4.3 firewall
      OS-level trên Ubuntu 24.04 hiện hành) rồi gỡ cờ `cần kiểm chứng`.~~ **[DONE 2026-07-04]**
      Đã chạy thật (Ubuntu 22.04, shape `VM.Standard2.1` vì `E2.1.Micro`/`A1.Flex` đều out-of-
      capacity lúc đó) — ruleset iptables + lệnh fix đã verify, xem §4.0/§4.3. `cần kiểm chứng`
      còn lại: xác nhận ruleset giống hệt trên chính `E2.1.Micro`/`A1.Flex` (khả năng cao có vì
      là default của base image) và trên Ubuntu 24.04 (session này dùng 22.04).
- [ ] Điền §5 Hetzner khi thật sự có node trên đó (hcloud CLI hay console, firewall rule cụ thể).
- [ ] Điền §6–§9 (AWS/Azure/GCP/Vultr) khi có nhu cầu deploy thật — hiện chỉ ghi đặc thù đã biết
      từ file so sánh, chưa có bước thao tác.
- [ ] Xác nhận `unattended-upgrades` có an toàn cho node cần uptime heartbeat liên tục hay nên
      tắt (reboot ngoài kế hoạch có thể trigger reclaim-idle theo dõi nhầm ở OCI).
- [ ] Viết `ecosystem.config.js` mẫu cho STORAGE node (biến `CENTRAL_URL`/`NODE_SECRET`) — hiện
      §3.8 chỉ giả định file đã tồn tại trong repo. **[2026-07-04]** Xác nhận thêm: file thật
      trong `Stream-Sub-Server` hiện có 2 app entry trùng port (xem §3.8) và không có
      `config.env.example` — cần dọn khi viết bản mẫu.
- [ ] Migrate VM đang chạy tạm bằng shape Free Trial (`VM.Standard2.1`) về lại shape always-free
      (`E2.1.Micro`/`A1.Flex`) trước khi hết trial (30 ngày/$300) — xem §4.0.
- [ ] Sửa `nginx_sub.conf` root path từ dummy Windows (`D:/gitrepos/...`) sang path thật trên VM
      Linux (`/home/ubuntu/Stream-Sub-Server/videos`) trước khi test serve video thật — session
      2026-07-04 mới verify tới tầng network/API reachability, chưa test serve file qua `:9150`.

---

## Changelog

- **2026-07-03** — Tạo file. Tách khỏi `multi-cloud-free-tier-node-deployment.md` (file đó thiên
  về pricing/rationale) thành file operational thuần, tổng quát hoá cho nhiều cloud thay vì chỉ
  Oracle. Khung chuẩn 10 bước (§3) + vai trò CENTRAL/STORAGE (§2) + Oracle viết đầy đủ (§4) +
  Hetzner/AWS/Azure/GCP/Vultr là skeleton chờ điền (§5–§9) + hardening checklist chung (§11).
  Trỏ chéo `nginx-config-operations-guide.md`, `NGINX_FFmpeg DASH Streaming.md`,
  `central-node-architecture-comparison.md` §8.7.6, `files/nginx_central.conf`/`nginx_sub.conf`.
- **2026-07-04** — Deploy thật 1 STORAGE/SUB node lên Oracle Singapore (từ tạo instance đến gọi
  được Node API qua network) — gỡ nhiều cờ `cần kiểm chứng` ở §4 bằng nội dung verify thật
  (đánh dấu `[UPDATED 2026-07-04]`/`[SUPERSEDED 2026-07-04]`, giữ nguyên nội dung cũ theo quy
  ước §1.3). Tóm tắt các phát hiện chính:
  - **Out-of-capacity**: cả `E2.1.Micro` và `A1.Flex` đều hết cùng lúc ở Singapore AD-1 — dùng
    tạm shape `VM.Standard2.1` qua Free Trial làm phương án dự phòng (§4.0), kèm cảnh báo rủi ro
    tài chính (credit vs card charge) và kế hoạch migrate lại trước khi hết trial.
  - **Networking lúc tạo instance**: giải thích chi tiết VCN/Subnet Public-vs-Private, field
    Private IPv4 bị mask là bình thường, checkbox Public IPv4 mới là thứ cần tick (§4.1/§4.2).
  - **Firewall 2 tầng**: lấy được ruleset iptables mặc định thật của Oracle image + lệnh fix
    chính xác (insert ACCEPT trước rule REJECT, persist bằng `iptables-persistent`) — thay thế
    hoàn toàn cờ `cần kiểm chứng` cũ ở §4.3. Phân biệt triệu chứng timeout (Security List) vs
    connection refused (iptables). Làm rõ ping/ICMP không hoạt động là bình thường, không liên
    quan tới TCP port.
  - **SSH client Windows**: `icacls` (PowerShell) vs `chmod` (Git Bash) là 2 cơ chế permission
    khác nhau, không trộn lẫn cho cùng 1 file key (§4.4) — thông tin mới, trước đây guide chỉ
    viết cho client Unix-like.
  - **PM2/config.env gotcha**: phát hiện thật trên `Stream-Sub-Server` — thiếu
    `config.env.example` khiến phải tự tạo `config.env` thủ công (thiếu file → crash ngay ở
    `db_index.js`), và `ecosystem.config.js` có 2 app entry trùng port gây `EADDRINUSE` (§3.8).
  - Cập nhật §13 TODO: đánh dấu done việc verify khung §3 trên Oracle thật; thêm TODO mới (migrate
    khỏi shape trial, sửa `nginx_sub.conf` root path trước khi test serve video thật).
