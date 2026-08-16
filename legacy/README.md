# legacy/ — code đã gỡ khỏi đường chạy

> Thư mục này **không được require từ bất kỳ đâu trong runtime**. Nó tồn tại để
> tra cứu lịch sử, không phải để chạy.

## Vì sao MOVE mà không DELETE

Xoá thẳng thì `git log --follow` vẫn tìm lại được, nhưng người đọc phải biết là
có thứ để tìm. Giữ file ở đây làm câu hỏi "trước đây chỗ này làm gì" trả lời
được bằng cách mở file, không phải bằng khảo cổ git.

## Đã chuyển vào đây (2026-08-16, Phase 3)

Tất cả đều có **bằng chứng tĩnh** là không ai require:

| File | Kích thước | Bằng chứng |
|---|---|---|
| `controllers/rtmpType1Controller.js` | 25.8 KB | `grep -rn "rtmpType"` ngoài chính chúng: **0 kết quả** |
| `controllers/rtmpType2Controller.js` | 13.4 KB | như trên |
| `controllers/rtmpType2_5Controller.js` | 24.2 KB | như trên |
| `controllers/rtmpType3Controller.js` | 4.0 KB | như trên |
| `models/mongo/*` (6 file) | — | chỉ `notificationFactory` require, mà nó cũng không ai require |
| `utils/notificationFactory.js` | — | 0 kết quả |
| `modules/redisAPI.js` | — | 0 kết quả |
| `config/db_index.js` | — | 0 kết quả |

Sub đã không dùng MongoDB từ 2026-07
([`upload-replication-contract-v2.md`](../markdowns/upload-replication-contract-v2.md) §1:
"Central là nơi duy nhất đọc/ghi MongoDB"), nhưng model và code kết nối vẫn nằm
trong cây nguồn suốt từ đó — đủ để người đọc mới tưởng Sub có DB.

**Muốn khôi phục** bất kỳ file nào: `npm i mongoose bcryptjs` (đã gỡ khỏi
`package.json`, xem bên dưới) rồi chuyển file về chỗ cũ.

## Dependency đã gỡ khỏi package.json

15 gói có **0 lời gọi `require`** trong toàn bộ cây nguồn, kể cả thư mục này:

```
node-rtsp-stream  connect  body-parser  blessed  cli-progress  request
slugify  bcrypt  iconv-lite  ffmpeg  http-server  tslib  stream-sub-server
```

Cộng `mongoose` và `bcryptjs` — hai gói này **chỉ** còn được `legacy/` dùng, nên
gỡ khỏi `dependencies` là nói đúng sự thật: node đang chạy không cần DB driver.

`stream-sub-server: "file:"` là gói **tự phụ thuộc chính nó** — gần như chắc
chắn do gõ nhầm.

## Cái gì CHƯA chuyển được, và vì sao

Đây là phần quan trọng nhất của tài liệu này.

Điều kiện xoá mà chính dự án đặt ra là **`legacy.route.hit` = 0 trong 30 ngày**
([draft §8](../markdowns/sub-node-code-standardization-draft.md)). Counter đó mới
được thêm ngày 2026-08-16 cùng Phase 0. **Chưa có 30 ngày dữ liệu nào cả.** Vì
vậy không có route v1 nào được chuyển vào đây dựa trên counter — mọi thứ ở trên
đều dựa trên grep, không dựa trên đo lường.

Còn nằm ngoài, và **đang chạy thật**:

| Thành phần | Vì sao chưa gỡ |
|---|---|
| `controllers/replicateController.js` | Central mới **cố tình** hạ cấp xuống `/api/v1/replicate/send-folder-v2` khi gặp Sub cũ (`NEEDS_LEGACY_CONNECTOR` bên Central) |
| `controllers/testController.js` + `routes/testRoute.js` | Vẫn mount ở `/api/test`. Bề mặt legacy lớn nhất còn mở — upload file, chạy FFmpeg, stream theo tên client đưa vào, **không kiểm tra gì**. Từ Phase 3 đã có counter |
| `encodeAPI.encodeIntoDash` | `replicateController.js:393` gọi thật |
| `encodeAPI.encodeIntoDash_test` | `uploadController.js:103` gọi thật |
| `encodeAPI.encodeIntoDashVer2/Ver3` | Không ai gọi, nhưng nằm trong cùng file với hai hàm trên |

> Ghi chú đính chính: draft §8.3 từng viết *"chỉ `Ver4` được gọi"*. Đúng với
> đường v2, **sai** với đường v1 — `encodeIntoDash` và `_test` vẫn đang được
> route v1 gọi.

## Quy trình xoá tiếp (chạy được ngay)

```bash
curl -s localhost:9100/api/default/legacy-usage
```

```bash
pm2 logs server --raw | grep '"event":"legacy.route.hit"' | tail -100
```

Route nào `byRoute` không xuất hiện trong 30 ngày thì đủ điều kiện. Nhớ là bộ
đếm in-memory mất khi `pm2 restart`, nên **log mới là nguồn sự thật**, còn
endpoint chỉ để xem nhanh.

## Changelog

- **2026-08-16** — Tạo thư mục. Chuyển 4 RTMP controller (67 KB), toàn bộ model
  Mongo, `notificationFactory`, `redisAPI`, `db_index`. Gỡ 15 dependency không
  còn ai require. Ghi rõ phần chưa gỡ được và lý do.
