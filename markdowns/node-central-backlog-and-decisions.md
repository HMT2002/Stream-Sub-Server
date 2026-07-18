# Node ↔ Central — Backlog, Quyết định & Ý tưởng (sổ tay sống)

> **File này là gì:** nhật ký *sống* cho mảng node↔central của Stream-Central-Server. Ghi:
> TODO actionable, **đề xuất/ý tưởng** (kèm cơ chế + pseudo-code), **quyết định đã chốt**, và
> **những thứ đã loại sau khi thử — kèm LÝ DO** để sau này không lặp lại tranh luận cũ.
>
> **Khác với** [central-node-architecture-comparison.md](central-node-architecture-comparison.md):
> file kia là *phân tích kiến trúc đầy đủ* (vì sao); file này là *backlog + log thực thi* (làm gì, tới đâu).
> Phân tích sâu → trỏ về §8.6/§8.7 của file kia.
>
> **Quy tắc cập nhật (theo SKILL §3.1):** chỉ *bổ sung/đánh dấu*, **không xoá đè**. Ý tưởng bị loại
> chuyển xuống §5 kèm lý do + ngày, **không xoá**. Mọi pseudo-code = **ĐỀ XUẤT, chưa kiểm chứng** (SKILL §6).

## Quy ước trạng thái
| Tag | Nghĩa |
|---|---|
| 🟢 ACCEPTED | Đã chốt hướng, đang/sẽ theo |
| ✅ IMPLEMENTED | Đã có trong code dự án |
| 🟡 PROPOSED | Đề xuất, chưa quyết |
| 🔵 TESTING | Đang thử nghiệm, chờ kết quả |
| 🅿️ PARKED | Tạm gác (chưa làm, **chưa** loại) |
| ❌ REJECTED | Đã loại — **bắt buộc kèm lý do** (§5) |

---

## 1. TODO actionable (làm được ngay)

> [UPDATED 2026-07-19] Code audit cho thấy các quyết định ở §2 vẫn là TARGET; implementation
> mới đạt một phần. Xem ma trận §1.1 và
> [current-implementation-audit-2026-07.md](current-implementation-audit-2026-07.md).

### 1.1 Baseline implementation sau code audit 2026-07-19

| Hạng mục | Code hiện có | Việc còn thiếu để đạt quyết định |
|---|---|---|
| Bỏ Redis/BullMQ | Không dependency/import runtime; central module rỗng, sub module dead code. | Xóa dead Redis module ở sub khi sửa code được duyệt. |
| Bỏ Mongo ở sub | `VideoStatus` sub đã comment. | `server.js`, `server_pro.js`, Mongoose dependency, db config, model và replicate V2 vẫn phụ thuộc Mongo. |
| Heartbeat | Recursive loop + jitter + timeout + inventory hash; central stamp `receivedAt` trong RAM. | Bật production, stable node ID, health/jobs/bootId/seq, persist Mongo, liveness query/reconcile. |
| Encode async | Upload trả response trước khi FFmpeg kết thúc. | `202`, `jobId`, `p-queue`, transition validation, completion/heartbeat snapshot. |
| Replicate node↔node | Byte đi source node→destination node. | Bỏ DB lookup ở source, ack 202, checksum/range/resume/atomic finalize/reconcile. |
| Delete | Node trả success khi path đã không tồn tại. | Central không được giảm replica khi node call lỗi; thêm pending/reconcile và retry semantics. |
| nginx static | Port 9150 + sendfile + frontend ưu tiên nginx URL. | Implement `/__auth`, quyết định fail-closed, verify root/path và production config. |

- [ ] **P0 — Hoàn tất bỏ MongoDB khỏi sub code**, không chỉ bỏ `VideoStatus`: central phải gửi
  đủ command context để node không query `Video`/`Server`.
- [ ] **P0 — Không cập nhật placement khi delete/replicate outcome chưa chắc chắn**; dùng pending
  state + inventory reconcile.
- [ ] **P0 — Bật heartbeat trong production bằng config rõ ràng**; hiện điều kiện chỉ cho
  `NODE_ENV === 'development'` làm deploy không tự gửi heartbeat.
- [ ] **P1 — Thêm `p-queue` và job registry in-process**, nhưng persistent truth vẫn ở central.
- [ ] **P1 — Sửa contract manual `/heartbeat`** để bọc payload giống auto loop.

- [ ] **Bổ sung payload heartbeat** chở `health + jobs[] + inventory(checksum)` (hiện heartbeat: "cần bổ sung" — xem [comparison §8.3](central-node-architecture-comparison.md)). Cơ chế: §4.1 dưới.
- [ ] **Central stamp `receivedAt`** bằng đồng hồ central lúc nhận heartbeat; liveness = `now - receivedAt > ngưỡng`. **Không** tin `ts` của node (clock skew đa vendor). → §4.4.
- [ ] **Quyết định cơ chế liveness expiry**: query quét `lastHeartbeatAt < now - threshold` (responsive) thay vì dựa TTL index (TTL monitor ~60s, chỉ để dọn rác). → §4.4.
- [ ] **Delete idempotent + central retry**: xoá cái đã-xoá = success; response rớt → central retry an toàn. → [comparison §8.7.5b](central-node-architecture-comparison.md).
- [ ] **Chuyển replicate sang async (202 + heartbeat)** thay vì giữ sync (né timeout proxy 29–60s). → §3.
- [ ] **Encode async + báo qua heartbeat** (đã rõ là bắt buộc, không "có khi"). → §3.
- [ ] Kiểm chứng cú pháp NGINX `auth_request` trên bản Windows đang dùng *(kế thừa comparison §7)*.
- [ ] Đo overhead heartbeat khi node giữ >1000 video (checksum optimization) *(kế thừa comparison §7)*.

---

## 2. Quyết định đã chốt (link sang phân tích)

- 🟢 **Bỏ Redis & BullMQ** khỏi dự án; MongoDB là hạ tầng chia sẻ duy nhất. → [comparison §8](central-node-architecture-comparison.md).
- 🟢 **Giữ `VideoStatus`, chỉ CENTRAL ghi Mongo; node feed qua HTTP outbound** (node không chạm DB). → [comparison §8.6](central-node-architecture-comparison.md).
- 🟢 **Node→central PUSH** (không central poll node). Lý do thật: trạng thái do node sinh ra + phân tán tải (không phải NAT — node có ingress public). → [comparison §8.7.3](central-node-architecture-comparison.md).
- 🟢 **HTTP heartbeat = kênh authoritative**; Socket.IO (nếu dùng) chỉ là gia tốc cho dữ liệu không-authoritative. → [comparison §8.7.3](central-node-architecture-comparison.md).
- 🟢 **Delete = sync 1 request (idempotent)**; **Encode/Replicate = heartbeat nền (bắt buộc) + completion-POST gia tốc (tùy chọn)**. → [comparison §8.7.5b](central-node-architecture-comparison.md).
- 🟢 **Correlation bằng `jobId`** central phát lúc dispatch; node ack `202` ngay, report out-of-band. → [comparison §8.6.4](central-node-architecture-comparison.md).
- 🟢 **Deploy node cần `CENTRAL_URL` + `NODE_SECRET`** (hub-and-spoke). → [comparison §8.7.6](central-node-architecture-comparison.md).
- ✅ `VideoStatus`, `replicateController`, `deleteController`, `globals/blacklist.js` đã có trong code *(xem PROJECT_SUMMARY_CENTRAL/SUB)*.

---

## 3. Ma trận dispatch theo thời lượng (tóm tắt — chi tiết ở comparison §8.7.5)

| Thao tác | Đo được | Dispatch | Nguồn sự thật |
|---|---|---|---|
| Delete | <1s | 🟢 sync 200 (idempotent) | inventory heartbeat |
| Replicate | local <1s; cross-vendor vid 4′ ~30s+ | 🟡→🟢 chuyển 202 async | inventory(node đích)+jobs |
| Encode | 1 CPU ~10′/vid 4′ | 🟢 202 async bắt buộc | jobs(progress)+inventory |

---

## 4. Ghi chú thực thi (pseudo-code + cơ chế)

### 4.1 🟡 Heartbeat loop ở node — KHÔNG dùng OS cron
**Cơ chế / lý do:**
- **Không OS cron**: cron spawn process mới (cold start) → không thấy `p-queue`/`bootId`/`seq`/progress đang chạy; cron tối thiểu 1 phút. Heartbeat phải chạy **trong daemon node** để đọc state sống.
- **Recursive `setTimeout`, không `setInterval`**: tránh request chồng đống (pile-up) khi central xa/chậm.
- **Jitter ±20%**: 50–100 node không đập cùng mili-giây (thundering herd); central restart không gây bão reconnect.
- **Per-request timeout < interval**: 1 beat treo không kẹt vòng lặp.
- **Best-effort**: heartbeat fail → log, **không crash, không dừng encode**; beat sau tự vá.
- **Event-trigger**: job đổi state → gửi NGAY (giảm trễ đúng cách, **không** phải hạ interval).
- **HTTP keep-alive**: tái dùng connection, khỏi TLS handshake mỗi beat.

```js
// ĐỀ XUẤT — CHƯA KIỂM CHỨNG (SKILL §6). Chạy trong daemon node.
const BASE = 10_000, JITTER = 0.2, REQ_TIMEOUT = 5_000;
const bootId = crypto.randomUUID();        // §4.2 comparison
let seq = 0, timer;
const agent = new http.Agent({ keepAlive: true });

async function sendHeartbeat(reason = 'tick') {
  const body = collectSnapshot();          // p-queue size, health (cache), inventory checksum — PHẢI RẺ
  Object.assign(body, { bootId, seq: ++seq, ts: Date.now(), reason });
  const ac = new AbortController();
  const kill = setTimeout(() => ac.abort(), REQ_TIMEOUT);
  try {
    await fetch(`${CENTRAL_URL}/api/v1/nodes/heartbeat`, {
      method:'POST', agent, signal: ac.signal,
      headers:{ 'content-type':'application/json', 'x-signature': hmac(body) },  // §4.6 comparison
      body: JSON.stringify(body),
    });
  } catch (e) { /* best-effort: log thôi */ }
  finally { clearTimeout(kill); }
}
function scheduleNext() {
  const delay = BASE * (1 + (Math.random()*2 - 1) * JITTER);
  timer = setTimeout(async () => { await sendHeartbeat(); scheduleNext(); }, delay);
}
scheduleNext();
onJobStateChange(() => sendHeartbeat('state-change'));   // encode/replicate xong → gửi ngay
```

### 4.2 🟡 Payload heartbeat (3 nhóm, full snapshot không delta)
```jsonc
// ĐỀ XUẤT — CHƯA KIỂM CHỨNG
POST {CENTRAL_URL}/api/v1/nodes/heartbeat
Headers: X-Node-Id, X-Boot-Id, X-Seq, X-Signature: HMAC-SHA256(body, NODE_SECRET)
Body: { ts, health:{cpuLoad,memFreeMB,diskFreeGB,encodeSlots,encodeActive,netOutMbps},
        jobs:[{jobId,kind,videoId,state,progress,updatedAt}],
        inventory:{ checksum, videos:null } }   // videos chỉ điền khi checksum đổi
200:  { ackSeq, wantFullInventory:false, commands:[...] }
```
- **2 tầng (kiểu K8s/KEP-589)**: liveness+jobs mỗi ~10s; full inventory list chỉ khi checksum lệch.

### 4.3 🟡 Interval: chọn 10–15s (không <10s, không ≥60s)
- Khác biệt thật giữa 10s/30s = **tốc độ phát hiện node chết** (~30s vs ~90s, với 3 beat miss). Traffic 10s↔30s ở 100 node **không đáng kể** (10 vs 3.3 req/s).
- Chuẩn ngành: K8s Lease **10s** + grace **40s**; Prometheus **15s**; Datadog ~15s.
- Traffic chỉ thành vấn đề ở **ngàn–chục ngàn node** (lý do K8s tách Lease khỏi NodeStatus, KEP-589). Ta ở ~100 → chưa chạm.

### 4.4 🟡 Liveness ở central (lưu ý scale 50–100 node)
- **Stamp `receivedAt` bằng đồng hồ central**; đừng tin `ts` node (clock skew).
- **Detect bằng query quét** `lastHeartbeatAt < now - threshold`, **không** dựa TTL deletion (TTL monitor ~60s → chỉ dọn rác).
- **Ghi Mongo nhẹ**: upsert `lastHeartbeatAt` + job state; **inventory chỉ ghi khi checksum đổi**; reconcile nặng → debounce/batch, đừng chạy đồng bộ mỗi beat.
- 100 node @10s ≈ 10 req/s + ~10 Mongo upsert/s → vặt. Nút thắt (nếu có) là **Mongo write**, không phải bandwidth.

### 4.5 🅿️ Progress encode đáng tin (để dành)
- **Không tin `percent` của fluent-ffmpeg** (suy từ duration, hay sai/thiếu).
- Cơ chế đúng: ffprobe lấy `duration` trước → chạy FFmpeg cờ **`-progress`** (`out_time_ms/frame/fps/speed`) → tự tính `% = out_time_ms / duration`.

---

## 5. Đã loại / tạm gác — KÈM LÝ DO (không xoá, để khỏi lặp lại)

- ❌ **[2026-06-20] Redis & BullMQ** — node deploy đa ISP/vendor không chia sẻ được hạ tầng LAN-bound; expose Redis public là cấm kỵ; độ trễ liên-cloud phá giả định atomic của BullMQ. Chi tiết: [comparison §8.2](central-node-architecture-comparison.md).
- ❌ **[2026-06-20] OS cron cho heartbeat** — process spawn mới không thấy state sống (p-queue/bootId/progress); cron tối thiểu 1 phút. Thay bằng in-process recursive setTimeout (§4.1).
- ❌ **[2026-06-20] `setInterval` cho heartbeat** — bắn bất kể lần trước xong chưa → pile-up khi central xa/chậm. Thay bằng recursive setTimeout (§4.1).
- ❌ **[2026-06-20] Completion-POST đơn độc làm đường báo duy nhất** — central restart/rớt đúng lúc job xong → kẹt `encoding` vĩnh viễn. **Case thật:** [GitLab Runner #38017 "Final update lost when job completes while GitLab server is restarting"](https://gitlab.com/gitlab-org/gitlab-runner/-/issues/38017). Thay bằng heartbeat nền + POST gia tốc.
- ❌ **[2026-06-20] Central poll node hỏi trạng thái** — lãng phí request, central giữ N timer; trạng thái vốn do node sinh ra. Thay bằng node push.
- 🅿️ **[2026-06-20] Socket.IO** — tạm gác (chưa loại). Dùng được như gia tốc cho % encode real-time tới frontend, **nhưng không bao giờ là kênh authoritative**. Cân nhắc lại sau khi heartbeat ổn.
- 🅿️ **[2026-06-20] Live encode progress** — defer; chỉ là UX, không phải correctness. Khi làm → §4.5.

---

## 6. Câu hỏi mở / cần nghiên cứu

- [ ] Lệnh `commands[]` "đi nhờ" response heartbeat (trễ ≤10s) vs direct POST central→node — chọn cái nào làm chính cho lệnh không-gấp? *(nghiêng direct POST)*
- [ ] Backoff khi central unreachable lâu (10s→30s→60s rồi snap back) — cần ở 100 node không, hay jitter đủ?
- [ ] Reconcile khi node "sống lại" sau miss heartbeat (mẫu Nomad: alloc `unknown` → so với bản thay thế) — áp cho encode/replicate dang dở thế nào?
- [ ] Ngưỡng "node chết" = bao nhiêu beat miss? (K8s ~4 → grace 40s).

---

## 7. Hệ thống tham khảo (implement tương tự — để đọc code/doc)

| Hệ | Vì sao đáng đọc | Link |
|---|---|---|
| **Buildkite Agent** | Agent poll-only outbound, NAT-friendly, report job result qua HTTP — gần như bản sao mô hình ta | [docs](https://buildkite.com/docs/agent) · [source Go](https://github.com/buildkite/agent) |
| **GitLab Runner** | Báo job qua HTTP (trace incremental + final); **case lỗi #38017** đúng bẫy của ta | [Jobs API](https://docs.gitlab.com/api/jobs/) · [#38017](https://gitlab.com/gitlab-org/gitlab-runner/-/issues/38017) |
| **Kubernetes kubelet** | Chuẩn vàng heartbeat 2 tầng (Lease 10s vs status 5min); apiserver là tiến trình duy nhất ghi etcd | [KEP-589](https://github.com/kubernetes/enhancements/blob/master/keps/sig-node/589-efficient-node-heartbeats/README.md) · [Leases](https://kubernetes.io/docs/concepts/architecture/leases/) |
| **HashiCorp Nomad** | Heartbeat + `Node.UpdateAlloc`; reconcile-sau-reconnect (`unknown`) gọn, dễ đọc | [server/control-plane](https://deepwiki.com/hashicorp/nomad/2-server-(control-plane)) · [PR #15068](https://github.com/hashicorp/nomad/pull/15068) |
| **AWS MediaConvert** | Đúng domain transcode: async job + EventBridge event đổi-state + STATUS_UPDATE ~1 phút + GetJob fallback | [job progress](https://docs.aws.amazon.com/mediaconvert/latest/ug/how-mediaconvert-jobs-progress.html) · [events](https://docs.aws.amazon.com/mediaconvert/latest/ug/cloudwatch_events.html) |
| **Tdarr** (open-source) | Distributed FFmpeg Server+Nodes; đọc decomposition node/worker. ⚠️ transport (HTTP/WS) chưa xác nhận — cần đọc source | [source](https://github.com/HaveAGitGat/Tdarr) · [nodes docs](https://docs.tdarr.io/docs/nodes/nodes/) |
| **Đừng copy:** Celery/Sidekiq/BullMQ | Broker model (Redis/RabbitMQ) = đúng model B đã loại (§5) | — |

---

## Changelog
- **2026-07-19** — Static-audit code Central `tue-alpha@bae83c5` và Sub
  `alpha@0427d60`; thêm §1.1 để tách quyết định TARGET khỏi implementation AS-IS. Phát hiện
  MongoDB chưa được bỏ khỏi sub entrypoint/replicate V2, heartbeat chỉ auto-start ở development,
  chưa có p-queue/jobId/reconcile, central có thể update placement sau delete lỗi, nginx còn
  fail-open. Liên kết audit chi tiết; giữ nguyên backlog/quyết định cũ.
- **2026-06-20** — Tạo file. Seed từ session bàn node↔central: TODO (§1), quyết định chốt (§2), ma trận
  dispatch (§3), ghi chú thực thi + pseudo-code heartbeat/payload/interval/liveness/progress (§4), nhật ký
  loại-bỏ-kèm-lý-do (§5, gồm case GitLab #38017), câu hỏi mở (§6), hệ tham khảo (§7). Trỏ chéo
  [central-node-architecture-comparison.md §8.6/§8.7](central-node-architecture-comparison.md).
