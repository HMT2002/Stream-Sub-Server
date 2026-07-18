# Multi-Cloud Free Tier & Test-Node Deployment

**Created:** 2026-07-03
**Project:** Stream-Central-Server
**Topic:** So sánh free tier VM của 5 nền tảng cloud cho mục đích chạy **test node** (nhẹ, luôn-on, ~2–3 GB egress/tháng), phân tích rủi ro tính phí ngầm / reclaim, checklist provisioning Oracle Cloud (OCI) always-free, và migration MongoDB local → Atlas.
**Related files:** `central-node-architecture-comparison.md` (topology & egress trade-off), `ott-engineer-career-roadmap.md` (Linux + 1 cloud), `PROJECT_SUMMARY.md`
**Scope note:** Đây là phân tích cho **môi trường test/dev**, KHÔNG phải production edge. Với production, egress là chi phí thống trị — xem mục 8.

> ⚠️ **Cảnh báo tính thời sự:** Toàn bộ số liệu pricing/policy trong file này thay đổi rất nhanh (Hetzner tăng giá 04/2026, Oracle cắt free A1 06/2026, AWS đổi model free tier 07/2025). Mọi con số phải **verify lại trên trang chính thức** trước khi commit. Đây không phải tư vấn tài chính.

---

## 1. Tóm tắt quyết định (TL;DR)

| Nhu cầu | Lựa chọn | Lý do |
|---|---|---|
| Test node $0 **vĩnh viễn**, egress rộng | **Oracle OCI always-free** | 10 TB egress/tháng, không hết hạn; đổi lại rủi ro capacity + reclaim |
| Control-plane node nhẹ $0 vĩnh viễn, traffic cực nhỏ | **GCP e2-micro** (always-free) | Vĩnh viễn nhưng chỉ 1 GB egress → không serve video được |
| "Không bao giờ phí ngầm" + chấp nhận ~$4–8/th | **Hetzner** | Hard price cap thật + 20 TB egress (EU) |
| Chỉ test 6–12 tháng rồi bỏ | Azure B1S / AWS | Có hạn, cần ghi lịch nhắc |

**Kết luận cho dự án:** node của Stream-Central-Server vốn **stateless + lightweight + có heartbeat** (xem `central-node-architecture-comparison.md`) → hợp OCI always-free nhất, vì thiết kế này *miễn nhiễm* với nhược điểm tệ nhất của OCI (mất data khi reclaim). State thật (registry) nằm ở MongoDB Atlas, không nằm trên node.

---

## 2. So sánh free tier — Big 3 (AWS / Azure / GCP)

### 2.1 Bảng cấu hình VM free

| | **AWS** | **Azure** | **GCP** |
|---|---|---|---|
| VM free | (legacy) t3.micro 750h/th; account mới rút từ credit | B1S 750h/th | e2-micro 1 instance/th |
| vCPU / RAM | t3.micro: 2 vCPU / 1 GB | B1S: 1 vCPU / 1 GB | e2-micro: 0.25–2 vCPU shared / 1 GB |
| Thời hạn | 12 th (legacy) / 6 th credit (account mới sau 15/07/2025) | 12 th | **Always Free (vĩnh viễn)** |
| Region giới hạn | không | bất kỳ | **chỉ us-west1, us-central1, us-east1** |
| Storage kèm | 30 GB EBS (legacy) | 64 GB managed disk | 30 GB standard PD |
| **Egress free** | 100 GB/th | 15 GB outbound | **chỉ 1 GB/th từ Bắc Mỹ** |
| GPU (cho NVENC) | ❌ không | ❌ không | ❌ không |

**Điểm quan trọng cho dự án:** không nền tảng free nào có GPU → **không transcode NVENC được** trên free tier. Free node chỉ làm control-plane hoặc serve/relay segment, không encode.

### 2.2 Reset & hết hạn — phân biệt "monthly reset" vs "annual expiration"

Không nền tảng nào có "annual reset" (quota tự làm mới mỗi năm). Cái cần để ý là **anniversary expiration**:

| | Monthly reset | Mốc theo năm |
|---|---|---|
| **GCP** | Có (Always Free) | Không — chỉ trial 90 ngày |
| **Azure** | Có | **Anniversary 12 th → 12-month services hết hạn, chuyển paid âm thầm** |
| **AWS legacy** | Có (trong 12 th) | **Anniversary 12 th → tự động billing on-demand, không cảnh báo rõ** |
| **AWS mới** | Không (chuyển model credit) | Không — cửa sổ 6 th rồi đóng account |

**Hai tầng cần phân biệt (điểm dễ hiểu nhầm):**
- **Tầng trial**: one-shot, qua là qua hẳn, năm mới KHÔNG làm mới. Một identity chỉ trial một lần.
- **Tầng Always Free**: reset hàng tháng, KHÔNG hết hạn, tồn tại *sau khi* trial chết. Đây là thứ giữ node $0 lâu dài.
  - GCP: e2-micro nằm ở tầng always-free → sống vĩnh viễn.
  - Azure: B1S nằm ở tầng **12-month**, KHÔNG phải always-free → hết năm là tính tiền. Always-free của Azure chủ yếu là Functions/Cosmos/App Service F1, không phải VM.
  - AWS: EC2 **không bao giờ** nằm trong always-free.

### 2.3 Thẻ tín dụng & rủi ro charge

Cả ba **đều yêu cầu thẻ** để verify danh tính (không charge ngay):
- **GCP**: thẻ hoặc payment method hợp lệ; trial có **hard stop** (hết $300 hoặc 90 ngày → workload shutdown, không charge nếu không tự upgrade).
- **Azure**: cần SĐT + thẻ credit/debit (non-prepaid); **KHÔNG có spend cap tự động** — sau khi upgrade PAYG, vượt free là charge ngay. *Ngoại lệ:* Azure for Students — không cần thẻ, $100 credit/12 th.
- **AWS**: yêu cầu thẻ; account mới Free Plan không charge khi vượt (chỉ đóng account), nhưng Paid Plan thì billing on-demand ngay khi hết credit.

### 2.4 Điểm chết người: GCP không có hard spending cap (ở trạng thái Paid)

Sau khi upgrade Paid (nhập thẻ), **GCP âm thầm tính phí, KHÔNG shutdown** khi vượt free quota. **Budget alert ≠ budget cap** — budget chỉ gửi email cảnh báo, KHÔNG tự dừng dịch vụ.

- e2-micro compute vẫn always-free ($0).
- Egress vượt 1 GB → mỗi GB dư ~$0.085–0.12 tùy đích. 100 GB serve video ≈ $8.5–12; 1 TB ≈ $85–120.
- Muốn auto-shutdown thật: phải tự dựng **Budget → Pub/Sub → Cloud Function** gọi API disable billing.
  - `TODO: cần kiểm chứng` — chưa fetch tài liệu chính thức trong phiên tạo file. Nguồn cần đối chiếu: `cloud.google.com/billing/docs/how-to/notify` và `.../disable-billing-with-notifications`. Chưa đưa code vì chưa verify.

### 2.5 Điều kiện để e2-micro thực sự $0

Chỉ miễn phí khi thỏa **TẤT CẢ**: đúng region (us-west1/us-central1/us-east1) + đúng máy (e2-micro) + disk ≤ 30 GB **standard** (không SSD/balanced) + egress ≤ 1 GB/th + **không reserve static IP rảnh** + không snapshot + không traffic xuyên region. Các khoản phí ngầm phổ biến: external IPv4 tĩnh khi VM tắt, snapshot, disk loại sai, egress xuyên region.

---

## 3. Lựa chọn ngoài Big 3

### 3.1 Oracle Cloud (OCI) Always Free — ứng viên $0 mạnh nhất cho serve traffic

**Cấu hình always-free (cập nhật 06/2026):**
- ⚠️ **Thay đổi 06/2026**: giới hạn Ampere A1 free giảm còn **2 OCPU / 12 GB RAM** tổng (trước 4 OCPU / 24 GB). Free-tier users bị shutdown instance tới khi resize về giới hạn mới; PAYG users vẫn giữ 4 OCPU / 24 GB free. `TODO: verify` con số này trên oracle.com/cloud/free trước khi dựa vào.
- Egress: **tới 10 TB/tháng** across all services; ingress miễn phí. (Gấp ~10.000× GCP.)
- Storage: 200 GB block; 2 AMD Micro VM (1/8 OCPU, 1 GB mỗi cái).
- **Không hết hạn** — khác AWS/GCP trial.

**Nhược điểm thực tế (có nguồn, mục 7):**
- "Out of host capacity" — thiếu shape always-free ở home region, phổ biến với A1 ARM ở region đông; có thể mất vài ngày mới có thêm capacity (Oracle FAQ xác nhận).
- **Home region cố định vĩnh viễn** — không đổi được sau khi tạo.
- **Reclaim khi idle ≥ 30 ngày** — account/instance idle có thể bị coi là abandoned → suspend/terminate.
- Rủi ro **termination không cảnh báo, mất data** — có case thật (mục 7).
- Không SLA cho Free Tier.

### 3.2 VPS giá cố định (Hetzner / Vultr) — "hard cap thật"

**Hetzner Cloud:**
- Hóa đơn server **không vượt quá monthly price cap**; xóa server giữa tháng chỉ tính theo giờ. Không overage bất ngờ cho compute, không phí termination. → đây là **hard cap** mà Big 3 không có.
- Bandwidth: **20 TB outbound** mọi plan (EU); region US giảm còn 1 TB.
- Giá: CAX11 ARM từ ~$3.79/th; CX22 x86 từ ~$4.59/th. ⚠️ Hetzner tăng giá từ 01/04/2026.
- Bẫy: tắt nguồn server vẫn giữ disk + IP và **vẫn tính tiền**; muốn dừng hẳn phải **xóa** instance (snapshot trước nếu cần). (Giống bài học `az vm deallocate` của Azure.)
- Nhược: không free trial, Linux-only, verify ID.

**Vultr:** từ ~$2.50/th, có $100 credit trial; bandwidth ít hơn Hetzner nhiều (~2–3 TB).

### 3.3 Bảng quyết định mở rộng

| | $0 vĩnh viễn | Egress | Hard cap chống phí ngầm | Rủi ro "chết đột ngột" | Hợp serve video? |
|---|---|---|---|---|---|
| GCP e2-micro | ✅ | ❌ 1 GB | ❌ (Paid không cap) | Thấp | ❌ |
| **Oracle A1 free** | ✅ | ✅✅ 10 TB | ⚠️ (free shutdown nếu vượt) | Trung-Cao (capacity, reclaim, cắt 06/2026) | ✅ nhỏ–vừa |
| **Hetzner** | ❌ (~$4–8/th) | ✅✅ 20 TB EU | ✅✅ cap thật | Rất thấp | ✅✅ |
| Vultr | ❌ ($2.5+/th) | ⚠️ 2–3 TB | ✅ | Thấp | ⚠️ |
| Azure B1S | ❌ 12 th | ❌ 15 GB | ❌ | Trung (mốc 12 th) | ❌ |
| AWS EC2 | ❌ | ❌ 100 GB | ⚠️ | Cao (6 th đóng) | ❌ |

---

## 4. Tại sao OCI ưu đãi rộng mà ít người nhắc? (phân tích by-design)

1. **Path dependence lịch sử:** AWS (2006), GCP (2008), Azure (2010) đi trước; OCI hiện đại mãi 2016, always-free mãi 09/2019. Hệ sinh thái developer (tutorial, SO, CI/CD) đã đóng khuôn quanh Big 3 một thập kỷ. Cộng định kiến văn hóa "tránh Oracle" (kiện Java, culture license audit).
2. **Trade-off có chủ đích — free = ưu tiên thấp nhất:** Always Free là capacity thừa. Khi region cần chỗ cho khách trả tiền, tài nguyên free bị từ chối cấp (out of capacity) hoặc thu hồi (reclaim) trước. Đây là gốc chung của cả hai nhược điểm.
3. **Rào cản kỹ thuật đầu vào cao hơn:** firewall hai tầng, ARM/aarch64 vướng package, verify thẻ đôi khi bị reject → "activation energy" cao, người viết tutorial ngại.

**Không phải bẫy phí ẩn:** về mặt tiền OCI *an toàn hơn* nhờ egress 10 TB. "Uẩn khúc" đúng bản chất là **đánh đổi độ tin cậy để lấy tài nguyên rộng**, không phải mưu tính tính phí.

**Ảnh hưởng đến case test streaming:** nhược điểm thật sự chạm vào dự án chỉ là **reclaim-idle-30-ngày** (node test hay idle theo đợt). Phòng bằng: (a) không đặt state không thể mất trên OCI (đã đúng — node stateless, registry ở Atlas), (b) giữ heartbeat/cron chạy để không bị coi abandoned, (c) coi node là cattle — script dựng lại, backup config ra Git.

---

## 5. Checklist provisioning OCI Always Free (từng bước)

> **[2026-07-03]** Checklist thao tác chi tiết hơn (kèm khung chuẩn dùng chung cho Hetzner/AWS/
> Azure/GCP/Vultr, không chỉ Oracle) đã tách sang
> [`vm-server-setup-guide.md`](vm-server-setup-guide.md) §4. Mục dưới đây **giữ nguyên** làm bản
> gốc/rationale; khi hai file lệch nhau, tin file kia (bản operational cập nhật hơn).
>
> Nguồn: tài liệu chính thức Oracle (mục 7). UI console có thể đổi — mở song song docs khi làm.

### 5.1 🔴 Ba thứ KHÔNG sửa được sau khi tạo
1. **Home region** — nơi account + IAM resource được tạo; **không đổi được**. Always-free compute + Autonomous DB **chỉ chạy ở home region**. Chọn sai = phải hủy account tạo lại.
2. **Một account / email** — Oracle chỉ cho một cloud account mỗi email.
3. **Cloud Account Name (tenancy)** — cố định; đặt tên trung tính.

### 5.2 Chọn Home Region (cân hai yếu tố ngược nhau)
- **Capacity ARM**: region đông (Frankfurt, Milan) hay "out of capacity". Region có **3 Availability Domain** dễ có chỗ hơn (thử AD-1/2/3).
- **Latency tới VN**: gần nhất là **Singapore (ap-singapore-1)**, rồi Tokyo/Osaka/Seoul.
- Gợi ý cân bằng cho VN: **Singapore** hoặc **Tokyo**. Nhưng cách giảm rủi ro capacity mạnh nhất là **nâng PAYG** (mục 5.6), không phải chọn region.

### 5.3 Các bước đăng ký (nguồn: docs Oracle Sign_Up)
1. Vào `https://signup.cloud.oracle.com/` (hoặc "Start for free" ở oracle.com/cloud/free).
2. Chọn Country/Territory → nhập tên → **email hợp lệ** (dùng lâu dài, 1 account/email).
3. CAPTCHA → "Verify my email" → mở mail bấm link **trong 30 phút**.
4. Tạo password (8–40 ký tự, đủ hoa/thường/số/ký tự đặc biệt; không chứa tên/email/space và không chứa `` ` ~ < > \ ``) → nhập **Cloud Account Name**.
5. 🔴 **Chọn HOME REGION** — dừng kiểm tra kỹ, không có nút sửa sau bước này.
6. Terms of Use → địa chỉ + SĐT di động.
7. Thẻ xác minh: **chỉ credit/debit thật** (không prepaid/virtual); hold tạm ~$1, không charge trừ khi tự upgrade.

### 5.4 Provision instance always-free (nguồn: GitHub community guide + docs)
1. Hamburger → **Compute → Instances → Create instance**; đặt tên.
2. **Edit → Change shape**: cho test nhẹ chọn **AMD x86 VM.Standard.E2.1.Micro** (đơn giản, ít out-of-capacity hơn ARM). (ARM: Ampere → tick `VM.Standard.A1.Flex`, set ≤ 2 OCPU / 12 GB.)
3. **Image**: Canonical Ubuntu 24.04. (Bản Minimal **aarch64** chỉ cần nếu chọn ARM; AMD dùng x86 thường.)
4. **SSH key**: "Generate a key pair" → **tải cả private + public key về ngay** (không tải là mất quyền SSH).

### 5.5 Public IP + firewall (chỗ 90% người mới kẹt)
- Networking: tick **Assign a public IPv4 address** (không có thì SSH không vào được).
- Sau khi chạy: Instance → Attached VNICs → Primary VNIC → IP addresses → đổi public IP **Ephemeral → Reserved** (IP tĩnh, miễn phí trong always-free, 1 reserved IP).
- **Mở firewall HAI tầng:**
  1. **Cloud**: VCN → Security List (hoặc NSG) → Ingress Rule mở port 80/443 (+22 SSH).
  2. **OS**: Ubuntu image của Oracle cài sẵn iptables chặn → phải mở trong OS nữa (iptables rule hoặc ufw). Mở security list mà quên tầng OS = "port mở rồi mà vẫn không vào được".

### 5.6 Chống "out of host capacity"
1. Đổi Availability Domain (AD-1/2/3) trong Placement.
2. **Nâng PAYG** — đáng tin cậy nhất; cho ưu tiên hardware, **vẫn $0 miễn ở trong giới hạn always-free**. Nhiều report cộng đồng: "phải qua PAYG mới tạo được ARM". Lưu ý: mất hard-stop → đặt budget alert $1.
3. Thử lại Create sau vài phút (capacity mở khi user khác release).

### 5.7 "Minimal aarch64" — vẫn dùng apt/Node/NGINX bình thường?
- **Có.** "Minimal" = image cài sẵn ít package, KHÔNG phải distro cắt xén kiểu Alpine. `apt`/`apt-get`/`dpkg`/systemd còn nguyên. Lệnh đầu tiên: `sudo apt update && sudo apt upgrade -y`.
- Node.js + NGINX có bản ARM64 chính thức → OK. Lưu ý ARM: một số npm native binding cần build từ source (chuẩn bị `build-essential`); FFmpeg software-only trên ARM chạy được nhưng CPU-encode chậm (free tier không có GPU nên không NVENC).
- IP tĩnh: always-free có 1 Reserved Public IP (mục 5.5).

### 5.8 Giới hạn tối thiểu (cho Node + NGINX serve vài GB/th)
| Tài nguyên | Tối thiểu | Free cho | Ghi chú |
|---|---|---|---|
| RAM | ~1 GB | 12 GB (A1) / 1 GB (AMD micro) | Node+NGINX idle ~300–500 MB; 1 GB sát → thêm swap 1–2 GB |
| Boot volume | **min 47 GB** (không tạo nhỏ hơn được) | 200 GB block tổng | dùng thật ~3–5 GB, dư thoải mái |
| OCPU | 1 (hoặc 1/8 AMD) | 2 OCPU A1 | test nhẹ chỉ cần 1 |
| Egress | ~3 GB/th (nhu cầu) | 10 TB | không bao giờ chạm |

---

## 6. MongoDB Atlas free tier & migration local → cloud

### 6.1 M0 free — chính sách hiện tại (cập nhật 06/2026)
| | Trước | Hiện tại |
|---|---|---|
| Storage free | 512 MB | **512 MB — không đổi** |
| "Free forever" | Có | **Vẫn còn** |
| Pause khi idle | 60 ngày | **30 ngày** (email báo trước 7 ngày) |
| Shared tier M2/M5 | Có | **Bỏ → thay bằng Flex ($8–30, hard cap tháng, không overage)** |
| Egress free/Flex | Free | **Vẫn free** (không tính data đi ra) |
| Ops/giây | 100 | 100 |
| Connections | 500 | 500 |

- Storage 512 MB là **hard limit** — chạm là write bị chặn, không charge âm thầm (đúng tinh thần "không phí ngầm").
- 1 free cluster / project; không backup ở tier free.

### 6.2 Liên hệ dự án
Trong Stream-Central-Server, MongoDB làm **node registry ở central** (dữ liệu nhỏ: node list, metadata, checksum) — **không chứa video**. 512 MB quá dư (vài nghìn node record ~ vài MB). Node edge không có DB (đã chốt). Lưu ý:
- **Pause 30 ngày**: nếu central nghỉ lâu → vào resume thủ công. Heartbeat/registry chạy đều thì không chạm.
- **100 ops/s**: heartbeat ~10s/node rất thấp, không chạm; chỉ để ý nếu test vài trăm node giả lập đẩy đồng thời.
- **500 connections**: để ý connection pool khi nhiều process Node (Express + BullMQ + registry) nhân lên.

### 6.3 Migration local → Atlas: dùng `mongodump`/`mongorestore`, KHÔNG export JSON từng collection
**Lý do nhanh hơn:** BSON binary (không serialize JSON), **giữ nguyên type** (ObjectId, Date, Decimal128), **mang theo index definitions** (không phải tạo lại index tay).

Lệnh chuẩn (nguồn: MongoDB Database Tools docs — mục 7):
```bash
# Bước 1: dump ra BSON
mongodump --uri="mongodb://localhost:27017" --db=your_db_name --out=./dump

# Bước 2: restore lên Atlas (lấy connection string ở Atlas → Connect → Drivers)
mongorestore --uri="mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net" ./dump
```

Nhanh hơn nữa — pipe thẳng, không file trung gian, nén khi upload:
```bash
mongodump --uri="mongodb://localhost:27017" --db=your_db_name --archive --gzip | \
  mongorestore --uri="mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net" --archive --gzip
```
- `--archive` (không path) → xuất một stream ra stdout; restore đọc từ stdin.
- `--gzip` hai đầu → nén luồng, giảm byte upload lên cloud.

> ⚠️ Các lệnh trên theo cú pháp tài liệu chính thức MongoDB Database Tools nhưng **chưa chạy trong môi trường dự án** → `cần kiểm chứng` với DB thật (đặc biệt nếu có nhiều DB hoặc cần lọc collection). Đối chiếu `mongodb.com/docs/database-tools` trước khi chạy.

### 6.4 Ba lỗi migration phổ biến cần phòng
1. **Vượt 512 MB**: `mongorestore` build lại index, **index cũng tính vào 512 MB**. Kiểm trước bằng `db.stats()` ở local (xem `dataSize` + `indexSize`).
2. **Version mismatch**: Atlas chạy MongoDB 8.0; dùng Database Tools mới (tách riêng khỏi server) để tránh lỗi tương thích. Tải: `mongodb.com/try/download/database-tools`.
3. **IP Access List**: Atlas chặn mọi IP mặc định → Network Access thêm IP local (hoặc tạm `0.0.0.0/0` khi test rồi gỡ). Quên bước này = "connection timeout" khi restore.

---

## 7. References (nguồn uy tín)

**Oracle Cloud (chính thức):**
- Free Tier docs: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier.htm
- Sign-up guide (home region không đổi được, thẻ): https://docs.oracle.com/en-us/iaas/Content/GSG/Tasks/signingup_topic-Sign_Up_for_Free_Oracle_Cloud_Promotion.htm
- Managing Regions (home region = nơi IAM resource): https://docs.oracle.com/en-us/iaas/Content/Identity/Tasks/managingregions.htm
- Free Tier FAQ (idle 30 ngày, out-of-capacity, reclaim, PAYG advantage): https://www.oracle.com/cloud/free/faq/

**Oracle — case thực tế (cộng đồng):**
- Provision guide (Compute → Instances, chọn shape x86/ARM): https://gist.github.com/rssnyder/51e3cfedd730e7dd5f4a816143b25dbd
- Termination không cảnh báo, mất data MySQL (05/2025): https://community.oracle.com/customerconnect/discussion/875400/
- Kẹt home region vì out-of-capacity: https://forums.oracle.com/ords/apexds/post/please-change-my-oracle-cloud-free-tier-home-region-from-fr-2198
- Trải nghiệm trái chiều (uptime 631 ngày vs random shutdown): https://news.ycombinator.com/item?id=36008957

**MongoDB:**
- Database Tools (mongodump/mongorestore, --archive/--gzip): https://www.mongodb.com/docs/database-tools/
- Atlas pricing/tiers: https://www.mongodb.com/pricing

**GCP / Azure / AWS (cần đối chiếu khi verify):**
- GCP Free Tier: https://cloud.google.com/free
- GCP disable billing on budget (`TODO` chưa verify): https://cloud.google.com/billing/docs/how-to/disable-billing-with-notifications
- Azure Free: https://azure.microsoft.com/free
- AWS Free: https://aws.amazon.com/free

**Hetzner / Vultr:**
- Hetzner Cloud pricing: https://www.hetzner.com/cloud
- Vultr pricing: https://www.vultr.com/pricing

---

## 8. Nối với kiến trúc dự án (cross-reference)

- **Egress là chi phí thống trị, không phải compute** — khớp learning trong `central-node-architecture-comparison.md` (mục "Scale băng thông egress" + "Chi phí ẩn: egress liên cloud khi replicate"). Free tier chỉ dùng test/dev; production edge phải tính egress theo lượt xem.
- **Node stateless + heartbeat** khiến OCI reclaim ít đau: mất node = dựng lại, không mất data. Registry ở Atlas (state bền tách khỏi node) là quyết định đúng cho cả bài toán reclaim.
- **Không GPU trên free tier** → free node không encode NVENC; chỉ control-plane hoặc serve/relay segment. Encode vẫn phải ở máy có GPU (xem `ffmpeg-presets-reference.md`, `central-node-performance-checklist.md`).
- **Pattern replication pull qua HTTP Range** hợp với việc node đặt trên nhiều nền tảng khác nhau (OCI + Hetzner + local) — mỗi node chỉ cần NGINX public + IP tĩnh.

---

## 9. TODO / cần kiểm chứng

- [ ] Verify con số Oracle A1 free sau cắt giảm 06/2026 (2 OCPU/12 GB?) trên oracle.com/cloud/free — hiện lấy từ search, chưa fetch trang chính thức.
- [ ] Fetch + kiểm chứng tài liệu GCP `disable-billing-with-notifications` và đưa code mẫu Budget→Pub/Sub→Function có nguồn (mục 2.4).
- [ ] Verify giá Hetzner hiện tại sau đợt tăng 01/04/2026 (CX22/CAX11) trên hetzner.com/cloud.
- [ ] Verify chính sách AWS Free Plan cho account tạo sau 15/07/2025 (cửa sổ 6 tháng, credit $100–200) trên aws.amazon.com/free.
- [ ] Test thực tế `mongodump | mongorestore --archive --gzip` với registry DB thật; đo size bằng `db.stats()` xem có lọt 512 MB.
- [ ] Đo latency thực tế từ VN tới OCI Singapore vs Tokyo trước khi chốt home region (không đổi được sau khi tạo).

---

## Changelog

- **2026-07-03** — Tạo file. Tổng hợp từ chuỗi hội thoại: so sánh free tier Big 3 + reset/expiration; GCP no-hard-cap; lựa chọn ngoài Big 3 (OCI 10 TB egress, Hetzner hard cap); phân tích by-design "tại sao OCI ít được nhắc"; checklist provisioning OCI (home region không đổi được, firewall 2 tầng, out-of-capacity → PAYG); MongoDB Atlas M0 (pause 30 ngày, M2/M5 → Flex) + migration mongodump/mongorestore. Mọi số liệu pricing đánh dấu cần verify; các lệnh kèm nguồn docs chính thức + cờ `cần kiểm chứng`.
- **2026-07-03** — Thêm note ở đầu §5 trỏ sang file mới `vm-server-setup-guide.md` (checklist thao tác tổng quát hoá cho nhiều cloud, không chỉ Oracle). Không xoá/đổi nội dung §5 cũ.
