# Node Network Reachability — Ngoại lệ localhost khi test đa node

**Created:** 2026-07-10
**Project:** Stream-Central-Server
**Topic:** Vì sao node chạy localhost không thể là target của request đến từ VPS (inbound), dù chiều outbound (localhost → VPS) hoạt động bình thường. Đây KHÔNG phải lỗi thiết kế.
**Related files:** `central-node-architecture-comparison.md` (ràng buộc gốc "node deploy độc lập trên cloud, có địa chỉ HTTP public"), `PROJECT_SUMMARY.md`

---

## 1. Kết luận ngay từ đầu

**Đây không phải bug, không phải lỗi cấu hình NGINX/Node, và không phải lỗi thiết kế của Stream-Central-Server.** Đây là hệ quả tất yếu của cách địa chỉ private/localhost hoạt động trên internet — một ràng buộc mạng ở tầng dưới kiến trúc, tồn tại trước và độc lập với thiết kế của dự án.

Quan trọng hơn: hiện tượng này **đang xác nhận đúng** một ràng buộc kiến trúc đã chốt từ trước trong `central-node-architecture-comparison.md` mục 1:

> "Node deploy **độc lập trên cloud bất kỳ** (AWS/Azure/GCP), có địa chỉ HTTP public."

Node chạy trên localhost đang tự đặt mình ra ngoài ràng buộc đó — nó không đại diện cho một node hợp lệ trong topology production, mà là một trường hợp test-only, không đầy đủ điều kiện.

---

## 2. Hiện tượng quan sát được

| Chiều | Kết quả | 
|---|---|
| localhost → VPS (upload API) | **Hoạt động** |
| VPS → localhost (replication/pull) | **Không hoạt động — "không tồn tại localhost của VPS"** |

Đây là sự bất đối xứng có thể dự đoán trước, không phải hiện tượng lạ.

---

## 3. Vì sao bất đối xứng — giải thích tầng mạng

### 3.1 Chiều outbound (localhost → VPS) hoạt động vì NAT là stateful

Máy dev đứng sau NAT (router nhà/văn phòng). Khi máy dev **chủ động mở kết nối** đến VPS:
1. NAT tạo một mapping tạm thời (source port nội bộ ↔ source port public) trong bảng NAT translation table.
2. VPS thấy request đến từ IP public của router, xử lý và trả lời.
3. NAT khớp response về đúng port đã ánh xạ, đưa ngược vào máy dev.

Đây là hành vi NAT tiêu chuẩn (RFC 3022 — Traditional IP Network Address Translator) — outbound-initiated connections được cho phép mặc định; NAT không cần biết máy dev là ai trước đó.

### 3.2 Chiều inbound (VPS → localhost) thất bại vì không có route

Khi VPS cố gắng chủ động kết nối tới `localhost` hoặc một IP LAN (`192.168.x.x`, `10.x.x.x`):
- `localhost` (`127.0.0.1`) chỉ có nghĩa **trong phạm vi chính máy đó** — theo định nghĩa, nó luôn trỏ về chính thiết bị đang thực thi request (RFC 1122 §3.2.1.3). Từ VPS, "localhost" trỏ về chính VPS, không phải máy dev.
- IP dải private (RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`) **không được route trên internet public** theo thiết kế — router backbone loại bỏ các gói tin có đích là địa chỉ private.
- Không tồn tại NAT mapping nào cho hướng ngược lại trừ khi router nhà bạn có port forwarding tĩnh trỏ vào máy dev — điều gần như không ai bật mặc định vì lý do bảo mật.

**Kết luận kỹ thuật:** đây không phải "VPS không hiểu localhost nằm ở đâu" theo nghĩa lỗi — mà là **theo đúng thiết kế của giao thức IP và NAT, không tồn tại đường đi (route) hợp lệ từ một host public đến một địa chỉ private phía sau NAT, trừ khi có cơ chế traversal bổ sung.**

---

## 4. Vì sao đây KHÔNG phải lỗi thiết kế của dự án

Đối chiếu với ràng buộc đã chốt trong `central-node-architecture-comparison.md`:

- Toàn bộ kiến trúc pull-replication (mục 4.3 của file đó — "Central ra lệnh cho node đích tự kéo từ node nguồn qua NGINX Range") **giả định mọi node trong mesh reachable lẫn nhau hai chiều qua HTTP public**, không chỉ với central.
- Tham chiếu thực tế gần nhất — Netflix Open Connect (mục 6.3): mỗi OCA (Open Connect Appliance) đều có địa chỉ routable trong mạng ISP. Đây là **ràng buộc cứng không thương lượng** của mô hình agent-based/hub-and-spoke, không phải điểm có thể tối ưu.
- Node localhost đơn giản là chưa/không thỏa điều kiện tiên quyết đó. Test case này đang hoạt động đúng như một hệ thống được thiết kế cho topology public-IP sẽ phản ứng khi gặp một node không có public IP — tức là **fail đúng cách, đúng lúc**, thay vì fail âm thầm ở production.

So sánh: đây cùng họ vấn đề với WebRTC NAT traversal — lý do STUN/TURN/ICE (RFC 8445) ra đời không phải vì WebRTC "thiết kế sai", mà vì **kết nối peer-to-peer qua NAT vốn dĩ cần cơ chế traversal bổ sung**, nó không tự nhiên mà có.

---

## 5. Hướng xử lý — không phải "sửa lỗi" mà là chọn phạm vi test phù hợp

### 5.1 Khuyến nghị chính: giới hạn vai trò của node localhost trong test

Coi node localhost là **source-only / leaf node** — không bao giờ là target của pull-replication. Test đầy đủ chiều hai-chiều (pull qua NGINX Range, bootId re-push, reconcile loop) chỉ nên chạy giữa ≥2 node có public IP thật (VPS/OCI/Hetzner). Cách này **tái hiện đúng 100% topology production**, không cần giả lập hay workaround NAT traversal.

> `TODO: cần xác minh` — nên dựng thêm 1 node public thứ hai (vd OCI Always Free) để có tối thiểu 2-node public-IP cho test pull-replication đầy đủ, thay vì phụ thuộc vào localhost.

### 5.2 Nếu vẫn cần localhost làm target tạm thời (debug nhanh trước khi deploy)

Các phương án dưới đây đều là công cụ **traversal/tunnel**, không sửa gì trong Stream-Central-Server — chỉ cấp cho máy local một địa chỉ public tạm thời để NAT có route hợp lệ:

| Công cụ | Cơ chế | Giới hạn cần biết | Nguồn |
|---|---|---|---|
| **ngrok** | Reverse tunnel qua relay server của ngrok | Free tier: URL đổi mỗi lần restart, giới hạn kết nối đồng thời — không phù hợp test heartbeat dài hạn | https://ngrok.com/docs |
| **Cloudflare Tunnel** | Outbound-only tunnel (`cloudflared`), không cần mở port trên router | Free, URL ổn định nếu gắn domain riêng | https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/ |
| **frp** (self-hosted) | Client trên máy local + server relay tự host trên VPS | Cần tự vận hành relay, nhưng kiểm soát hoàn toàn | https://github.com/fatedier/frp |

Đây chỉ nên dùng cho vòng lặp dev nhanh, **không phải giải pháp lâu dài** — vì production node vốn dĩ đã có public IP, không cần tunnel.

### 5.3 Không khuyến nghị cho use case này: mesh VPN (Tailscale/WireGuard)

Có thể cấp overlay IP ổn định bất kể NAT (Tailscale tự làm NAT traversal, fallback qua DERP relay khi không traverse trực tiếp được — https://tailscale.com/kb/1257/tailscale-vs-vpn), nhưng đòi hỏi **agent chạy thêm trên node**, xung đột trực tiếp với ràng buộc đã chốt "node tối giản: chỉ Node.js + FFmpeg, không thêm dependency". Chỉ cân nhắc nếu chấp nhận nó là infra-level sidecar tách biệt khỏi app code — nhưng vì production node vốn có public IP sẵn, lợi ích không rõ ràng so với chi phí phá vỡ ràng buộc tối giản.

---

### 5.4 Trường hợp đối xứng: Central chạy localhost khi debug

Ràng buộc reachability ở trên không chỉ áp dụng khi **storage node** chạy localhost. Nó cũng áp dụng đối xứng khi **Central** chạy trên máy developer (`127.0.0.1`, `localhost` hoặc IP LAN phía sau NAT), còn storage node chạy trên VPS/public cloud.

Trong topology debug này:

| Chiều | Kết quả | Giải thích |
|---|---|---|
| Central localhost → VPS node | **Hoạt động** | Central chủ động mở kết nối outbound tới endpoint public của VPS; NAT tạo state mapping và cho phép response quay về. |
| VPS node → Central localhost | **Không hoạt động mặc định** | VPS không có route tới loopback/IP private của máy dev và không thể tự mở kết nối inbound xuyên qua NAT/firewall. |

Vì vậy, khi Central đang chạy local, nó vẫn có thể **đẩy request và nhận response trên cùng kết nối HTTP** tới node VPS, ví dụ:

- ra lệnh upload/encode/delete;
- polling trạng thái job;
- gọi API health/status của node;
- yêu cầu node thực hiện replication.

Nhưng node VPS không thể tự động gửi các request mới về Central local, ví dụ:

- `POST /heartbeat`;
- callback tiến độ encode;
- webhook `encoding-completed`;
- chủ động đăng ký lại sau restart (`bootId` re-register/re-push);
- event callback hoặc Socket.IO/WebSocket connection do node khởi tạo về Central.

Điểm cần phân biệt: **response của VPS cho request do Central đã mở không phải là một kết nối inbound mới**. Response đó đi trong state NAT đã được tạo bởi kết nối outbound ban đầu, nên vẫn quay về được. Ngược lại, heartbeat/callback là một TCP connection mới do VPS chủ động khởi tạo; không có NAT mapping hoặc public route tương ứng nên thất bại.

#### Hệ quả đối với debug

Khi chạy Central trên localhost, có ba lựa chọn rõ ràng:

1. **Chấp nhận chế độ debug một chiều:** Central chủ động gọi/poll node; tạm thời không kiểm thử heartbeat/callback do node khởi tạo.
2. **Expose Central qua tunnel public:** dùng Cloudflare Tunnel, ngrok hoặc frp để node có endpoint callback routable.
3. **Deploy Central integration-test lên endpoint public:** đây là cách phản ánh production chính xác nhất khi cần kiểm thử push heartbeat, reconnect, bootId re-push và callback tiến độ.

Đây là **constraint của môi trường debug**, không phải lý do để thay đổi control-plane production từ push sang polling. Trong production, Central phải có endpoint public hoặc private-routable phù hợp để các node đa cloud có thể chủ động gửi heartbeat và state update như kiến trúc đã chốt.

## 6. Bài học chung — nguyên lý để nhớ

- **"Không reachable" không đồng nghĩa "lỗi".** Trước khi debug ở tầng ứng dụng (NGINX config, auth token, code Node.js), luôn loại trừ giả thuyết tầng mạng trước khi rơi vào case này — đặc biệt khi triệu chứng là "một chiều hoạt động, chiều kia không".
- **Test environment nên phản ánh đúng ràng buộc production**, không nên cố gắng làm cho môi trường không đủ điều kiện (localhost) hoạt động y hệt môi trường đủ điều kiện (public IP) bằng cách vá kỹ thuật — vì điều đó có thể che giấu vấn đề thật sự cần test (VD: NGINX Range request qua internet thật, latency liên cloud thật).
- Ràng buộc "mọi node phải public-IP reachable" là **thiết kế đúng cho bài toán multi-cloud** (đã lập luận trong `central-node-architecture-comparison.md` mục 6.2 — mô hình A thống trị hạ tầng phân tán địa lý, CDN & OTT delivery); localhost đơn thuần nằm ngoài phạm vi bài toán đó.

---

## 7. References

- RFC 3022 — Traditional IP Network Address Translator (NAT): https://datatracker.ietf.org/doc/html/rfc3022
- RFC 1918 — Address Allocation for Private Internets: https://datatracker.ietf.org/doc/html/rfc1918
- RFC 1122 §3.2.1.3 — Host Requirements (định nghĩa loopback): https://datatracker.ietf.org/doc/html/rfc1122
- RFC 8445 — Interactive Connectivity Establishment (ICE), tham chiếu về NAT traversal cùng họ vấn đề: https://datatracker.ietf.org/doc/html/rfc8445
- Cloudflare Tunnel docs: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- frp (self-hosted reverse proxy): https://github.com/fatedier/frp
- Tailscale — How it works (NAT traversal, DERP relay): https://tailscale.com/kb/1257/tailscale-vs-vpn
- Netflix Open Connect (tham chiếu kiến trúc node public-IP): https://openconnect.netflix.com

---

## Changelog

| Ngày | Thay đổi |
|---|---|
| 2026-07-10 | Tạo file mới. Ghi nhận ngoại lệ localhost-vs-VPS reachability là ràng buộc mạng được kỳ vọng sẵn (by-design), không phải lỗi. Đối chiếu với ràng buộc gốc trong `central-node-architecture-comparison.md`. Đề xuất hướng xử lý: giới hạn vai trò node localhost trong test (khuyến nghị chính) + các tùy chọn tunnel nếu cần debug nhanh. |
| 2026-07-11 | Bổ sung trường hợp đối xứng khi **Central chạy localhost** trong lúc debug: Central có thể chủ động gửi request tới VPS và nhận response, nhưng VPS không thể tự mở request mới về Central local cho heartbeat/callback nếu chưa có tunnel, public endpoint hoặc route riêng. Phân biệt response trên kết nối outbound với callback là kết nối inbound mới. |
