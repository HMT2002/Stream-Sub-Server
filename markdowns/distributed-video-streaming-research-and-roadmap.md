# Distributed Video Streaming Research & Architecture Roadmap

**Created:** 2026-07-11  
**Project:** Stream-Central-Server  
**Topic:** Literature review và hướng phát triển từ kiến trúc distributed adaptive video streaming, inter-server data distribution, content placement, QoE-aware routing và edge-assisted delivery.

> **Track chủ đề:** File này là tài liệu literature review + roadmap nghiên cứu.  
> Không thay thế `central-node-architecture-comparison.md` (quyết định kiến trúc), `node-central-backlog-and-decisions.md` (backlog thực thi), hoặc `ott-architecture-components.md` (kiến trúc OTT tổng thể).

---

## 1. Bối cảnh dự án hiện tại

Stream-Central-Server đã phát triển từ ý tưởng trong bài:

> *Distributed Adaptive Video Streaming using Inter-Server Data Distribution and Agent-based Adaptive Load Balancing* (2020)

Kiến trúc hiện tại có các đặc điểm chính:

- Central là **control plane**, không trung chuyển byte video.
- Storage node tự upload, encode, replicate và serve HLS/DASH qua nginx.
- Client stream trực tiếp từ storage node sau khi central handoff URL + token.
- Node-to-node replication đi thẳng giữa các node.
- MongoDB là source of truth duy nhất cho topology và trạng thái bền.
- Node push heartbeat về central; local encode queue dùng `p-queue`.
- ABR decision chủ yếu nằm ở hls.js/dash.js phía client.

Do đó, hướng nghiên cứu sát nhất không còn chỉ là “load balancing giữa server”, mà là tổ hợp của:

1. content placement và replica placement;
2. request routing/content steering;
3. telemetry và QoE-aware orchestration;
4. multi-tier caching/edge delivery;
5. network-assisted ABR;
6. desired-state reconciliation cho hệ thống phân tán.

---

## 2. Các paper và report đáng tham khảo

### 2.1 PLVER: Joint Stable Allocation and Content Replication for Edge-assisted Live Video Delivery

**Mức độ liên quan:** Rất cao.

Paper này kết hợp đồng thời:

- phân bổ nhóm người xem tới edge cluster;
- proactive replication giữa edge server;
- cân bằng giữa load, locality và chi phí sao chép.

**Ý nghĩa cho dự án:**

Central không nên chỉ chọn node theo CPU hoặc số active stream. Placement planner và request router nên dùng một cost tổng hợp như:

```text
score =
    health
  + available egress
  + storage headroom
  + video locality
  + network proximity
  - replication cost
  - recent error rate
```

**Khả năng triển khai:**

- Bổ sung module `placement planner`.
- Bổ sung module `request router` độc lập với placement.
- Lưu desired replica count và actual placement trong MongoDB.

**Reference:** https://arxiv.org/abs/2006.07505

---

### 2.2 Multi-tier Caching Analysis in CDN-based OTT Video Streaming Systems

**Mức độ liên quan:** Rất cao.

Nghiên cứu mô hình nhiều tầng gồm origin, CDN site và cache gần người dùng; tối ưu server/path selection, bandwidth và cache capacity.

Điểm quan trọng là paper tập trung cả **tail QoE**, không chỉ average latency. Một hệ thống có trung bình tốt nhưng p95/p99 xấu vẫn tạo trải nghiệm tệ cho một nhóm người xem đáng kể.

**Khả năng triển khai:**

Node telemetry nên lưu ít nhất:

```text
segment_response_p50
segment_response_p95
segment_response_p99
startup_delay_p95
rebuffer_ratio_p95
node_egress_utilization
http_error_rate
```

Central chọn node theo delivery QoE thực tế, không chỉ theo CPU hoặc trạng thái alive/dead.

**Reference:** https://arxiv.org/abs/1902.04067

---

### 2.3 Joint Optimization of QoE and Fairness Through Network-Assisted Adaptive Mobile Video Streaming

**Mức độ liên quan:** Cao.

Nghiên cứu dựa trên hướng SAND-DASH, kết hợp server/network assistance với client ABR để cải thiện QoE và fairness khi nhiều client tranh chấp cùng tài nguyên.

**Ý nghĩa cho dự án:**

Không nên đưa quyết định bitrate từng segment lên central vì sẽ tăng RTT, signaling và biến central thành bottleneck. Thay vào đó, node có thể gửi policy hint cho player:

```json
{
  "recommendedMaxBitrate": 4500000,
  "nodeLoadClass": "high",
  "estimatedAvailablePerSession": 5200000
}
```

hls.js/dash.js vẫn quyết định cuối cùng.

**Reference:** https://arxiv.org/abs/1708.02859

---

### 2.4 Cache-Aware QoE–Traffic Optimization in Mobile Edge Assisted Adaptive Video Streaming

**Mức độ liên quan:** Cao.

Paper chỉ ra rằng tối ưu cache-hit không đồng nghĩa tối ưu QoE. Cache nhiều representation bitrate thấp có thể tăng hit rate nhưng làm giảm chất lượng tổng thể.

**Khả năng triển khai:**

Nghiên cứu `partial ladder replication`:

```text
Minimal replica:
- 360p
- 720p
- audio
- subtitle
- manifest phù hợp với rendition thực có

Full replica:
- toàn bộ ABR ladder
```

Policy chọn rendition nên dựa trên:

- popularity;
- watch time/completion ratio;
- device distribution;
- bandwidth distribution;
- storage cost;
- inter-node transfer cost.

**Reference:** https://arxiv.org/abs/1805.09255

---

### 2.5 Understanding Content Placement Strategies in Smartrouter-based Peer CDN for Video Streaming

**Mức độ liên quan:** Cao.

Đây là measurement study về peer-CDN video quy mô lớn. Điểm đáng chú ý là delivery node vừa có thể phục vụ nội dung, vừa đóng vai trò measurement agent cho QoS và routing.

**Khả năng triển khai:**

Heartbeat có thể mở rộng thành telemetry envelope:

```json
{
  "cpuLoad": 0.30,
  "freeStorageBytes": 500000000000,
  "activeStreams": 42,
  "egressMbps": 420,
  "segmentP95Ms": 380,
  "errorRate5m": 0.003,
  "replicationQueueDepth": 2,
  "encodeQueueDepth": 1
}
```

Node.js service hiện tại chính là “agent” theo nghĩa distributed-system agent: đo local state, báo central, nhận command và thực thi.

**Reference:** https://arxiv.org/abs/1605.07705

---

### 2.6 A Survey on Replica Server Placement Algorithms for Content Delivery Networks

**Mức độ liên quan:** Cao.

Survey phân loại:

- static placement;
- dynamic placement;
- topology-aware placement;
- workload-aware placement;
- cost-aware placement;
- QoS-constrained placement.

**Khả năng triển khai ngắn hạn:**

Dùng heuristic giải thích được trước khi thử optimizer phức tạp:

```text
1. Loại node unhealthy.
2. Loại node không đủ storage.
3. Loại node không đủ encode profile/capability.
4. Ưu tiên node đã có video.
5. Nếu chưa có replica, chọn node có replication cost thấp.
6. Tie-break bằng active streams, egress và error rate.
```

**Reference:** https://arxiv.org/abs/1611.01729

---

### 2.7 BOLA: Near-Optimal Bitrate Adaptation for Online Videos

**Mức độ liên quan:** Cao cho player/QoE telemetry.

BOLA là buffer-based ABR algorithm dùng Lyapunov optimization để cân bằng chất lượng và rebuffer risk. Nó có giá trị thực tế vì dash.js hỗ trợ nhánh ABR kiểu BOLA.

**Khả năng triển khai:**

Player nên ghi nhận:

```text
representation switch
buffer level
segment download time
throughput estimate
startup delay
dropped frames
stall start/end
fatal/recoverable error
source node
```

Nên gửi session summary, không gửi từng event realtime lên central.

**Reference:** https://arxiv.org/abs/1601.06748

---

### 2.8 Pensieve và RL-based ABR

**Mức độ liên quan:** Trung bình, dài hạn.

Pensieve đại diện cho hướng reinforcement-learning ABR. Tuy nhiên chưa phù hợp triển khai sớm vì:

- cần network traces đủ đại diện;
- reward function dễ sai;
- model dễ overfit môi trường;
- khó debug hơn BOLA/throughput-based ABR;
- chi phí vận hành lớn hơn lợi ích hiện tại.

**Khuyến nghị:**

- chỉ lưu QoE/network trace trước;
- benchmark BOLA và throughput-based;
- chưa đưa ML vào production.

**Reference bổ sung:** https://arxiv.org/abs/2212.14479

---

## 3. Roadmap kiến trúc đề xuất

### Ưu tiên 1 — Node telemetry và QoE observability

Không có telemetry thì adaptive load balancing chỉ là heuristic mù.

Node nên báo:

- active streams;
- egress throughput;
- segment response p50/p95/p99;
- HTTP 4xx/5xx rate;
- disk read throughput;
- free storage;
- encode queue depth;
- replication queue depth.

Player nên báo session summary:

- startup delay;
- total rebuffer duration;
- average bitrate;
- quality switches;
- completion ratio;
- fatal/recoverable errors;
- source node.

---

### Ưu tiên 2 — Placement score thay cho node selection đơn giản

Đề xuất weighted score ban đầu:

```text
score =
    w1 * health
  + w2 * availableEgress
  + w3 * storageHeadroom
  + w4 * networkLocality
  + w5 * existingReplica
  - w6 * replicationCost
  - w7 * errorRate
  - w8 * segmentP95
```

Các trọng số phải cấu hình được và audit được; chưa cần ML.

---

### Ưu tiên 3 — Desired-state reconciliation

MongoDB giữ:

```text
desired placement
actual placement
replication state
last verified timestamp
```

Central định kỳ reconcile:

```text
Desired: video X có 3 replica
Actual: A, B có; C mất
Action: chọn D và yêu cầu D pull từ A/B
```

Đây là hướng resilient hơn callback ad hoc và phù hợp với quyết định MongoDB là source of truth.

---

### Ưu tiên 4 — Partial ladder replication

Không mặc định replicate toàn bộ output cho mọi node.

Cần bảo đảm manifest chỉ quảng cáo các rendition thực sự tồn tại trên node, hoặc có cơ chế fallback rõ ràng. Nếu master playlist/MPD trỏ tới rendition không có thì player sẽ lỗi ở thời điểm ABR switch.

---

### Ưu tiên 5 — QoE-aware content steering

Khi nhiều node cùng chứa một video, central chọn dựa trên:

```text
network proximity
node egress
active viewers
segment p95
recent error rate
content locality
```

Điều này biến central từ server registry thành content steering controller.

---

## 4. Những hướng chưa nên triển khai

### 4.1 Chưa nên dùng multi-agent AI

“Agent-based” trong bài gốc không bắt buộc nghĩa là autonomous AI agent. Node service hiện tại đã là agent theo nghĩa kiến trúc phân tán.

Consensus giữa agent, RL scheduling hoặc decentralized negotiation hiện chưa giải quyết bottleneck rõ ràng và sẽ làm tăng độ phức tạp.

### 4.2 Không đưa ABR decision lên central

ABR cần phản ứng theo từng client và từng segment. Central chỉ nên cung cấp policy hint hoặc server-side telemetry.

### 4.3 Không replicate chỉ dựa trên view count

Nên kết hợp:

- watch time;
- completion ratio;
- concurrent viewers;
- geographic concentration;
- representation distribution;
- cost của storage và transfer.

---

## 5. Thứ tự đọc đề xuất

1. PLVER — placement + proactive replication.
2. Multi-tier Caching Analysis — cache/path/bandwidth và tail QoE.
3. Network-Assisted Adaptive Streaming — QoE/fairness và SAND-DASH.
4. Peer-CDN content placement study — measurement thực tế.
5. Cache-Aware QoE–Traffic Optimization — partial representation caching.
6. Replica Server Placement Survey — taxonomy thuật toán.
7. BOLA — player-side ABR.
8. Pensieve/RL ABR — dài hạn, chưa triển khai.

---

## 6. Kết luận

Bài gốc cung cấp nền tảng đúng: inter-server data distribution và agent-based load balancing. Bước trưởng thành tiếp theo của Stream-Central-Server không phải thêm nhiều “agent” hơn, mà là phát triển central thành một:

> **QoE-aware content placement, replication reconciliation và content steering control plane**

Ba đầu việc có giá trị nhất hiện tại:

1. telemetry thực tế từ node và player;
2. desired-state replication/reconciliation;
3. placement/routing score kết hợp content locality, egress và QoE.

Các hướng này giữ nguyên các constraint đã chốt: không Redis/BullMQ, central không nằm trên data path, node đa cloud và MongoDB là source of truth duy nhất.

---

## Changelog

| Ngày | Thay đổi |
|---|---|
| 2026-07-11 | Tạo file literature review và roadmap nghiên cứu. Tổng hợp các nhánh: content/replica placement, QoE-aware routing, multi-tier caching, network-assisted ABR, partial ladder replication và desired-state reconciliation. |
