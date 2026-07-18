# HTTP Header Non-ASCII Encoding — Lưu ý khi truyền tên file tiếng Nhật / Unicode qua header

## Bối cảnh

Khi upload video có tên file chứa ký tự ngoài Latin (tiếng Nhật, tiếng Việt có dấu, emoji…),
gặp lỗi sau ở browser:

```
TypeError: Failed to execute 'setRequestHeader' on 'XMLHttpRequest':
String contains non ISO-8859-1 code point.
```

---

## Nguyên nhân

HTTP/1.1 spec (RFC 7230) quy định giá trị header chỉ được chứa byte trong bảng mã **ISO-8859-1**
(byte `0x00`–`0xFF`, tức Latin-1). Ký tự Unicode ngoài range này (kanji, kana, tiếng Việt
có dấu đa số rơi vào vùng này) bị **browser enforce ở tầng `setRequestHeader()`**, không phải
lỗi network — request không bao giờ được gửi đi.

Ví dụ ký tự gây lỗi:

| Ký tự | UTF-8 bytes | Nằm trong ISO-8859-1? |
|-------|-------------|----------------------|
| `映`  | `E6 98 A0`  | Không                |
| `画`  | `E7 94 BB`  | Không                |
| `é`   | `C3 A9`     | `é` = `0xE9` → Có   |
| `a`   | `61`        | Có                   |

---

## Chỗ xảy ra lỗi trong project

File: `frontend/src/Utils.js` — hàm `processVideoUploadToDashV2`

```js
// TRƯỚC (gây lỗi khi title chứa ký tự Nhật/Unicode ngoài Latin)
headers: {
  title,          // "映画.mp4" → crash ngay tại setRequestHeader
  ...
}
```

---

## Fix

### Frontend — `Utils.js`

Encode bằng `encodeURIComponent()` trước khi đưa vào header:

```js
// SAU
headers: {
  title: encodeURIComponent(title),
  // "映画.mp4" → "%E6%98%A0%E7%94%BB.mp4"  ← toàn ASCII, hợp lệ
  ...
}
```

`encodeURIComponent` chuyển mọi ký tự non-ASCII thành dạng `%XX` chỉ gồm ASCII,
nên luôn hợp lệ với ISO-8859-1.

---

### Backend — Sub-server (storage server)

Ở chỗ đọc header `title` (thường trong handler nhận chunk upload), decode ngược lại:

```js
// TRƯỚC
let title = req.headers.title;

// SAU
let title = decodeURIComponent(req.headers.title || '');
```

Nếu sub-server dùng hàm `sumUp(req)` (tương tự central server), sửa đúng 1 dòng trong hàm đó,
`title` sẽ đúng xuyên suốt flow.

---

## Luồng hoàn chỉnh sau khi fix

```
Frontend
  title = "映画.mp4"
  encodeURIComponent(title) → "%E6%98%A0%E7%94%BB.mp4"
  → set vào request header: title: "%E6%98%A0%E7%94%BB.mp4"

Sub-server nhận request
  req.headers.title = "%E6%98%A0%E7%94%BB.mp4"
  decodeURIComponent(req.headers.title) → "映画.mp4"  ✓
  lưu vào DB / dùng trong upload flow bình thường
```

---

## Nguyên tắc chung

Bất cứ khi nào cần truyền **chuỗi do người dùng nhập** (tên file, title, description…)
qua **HTTP header**, luôn encode trước:

```js
// Frontend — set header
headers: { 'x-custom': encodeURIComponent(userInput) }

// Backend — đọc header
const value = decodeURIComponent(req.headers['x-custom'] || '');
```

Ngược lại nếu truyền qua **JSON body** (`Content-Type: application/json`),
không cần encode vì JSON xử lý Unicode đầy đủ.

---

## Các header khác trong upload flow cần kiểm tra

| Header     | Nguồn                     | Có thể chứa Unicode? | Đã fix? |
|------------|---------------------------|----------------------|---------|
| `title`    | tên video do user nhập    | Có                   | ✓       |
| `ext`      | đuôi file (`.mp4`, `.mkv`)| Không                | Không cần |
| `chunkname`| random ASCII string       | Không                | Không cần |
| `filename` | random ASCII string       | Không                | Không cần |
| `infoId`   | MongoDB ObjectId          | Không                | Không cần |

---

## Tham khảo

- RFC 7230 §3.2.6 — Field value components
- MDN: [`XMLHttpRequest.setRequestHeader()`](https://developer.mozilla.org/en-US/docs/Web/API/XMLHttpRequest/setRequestHeader)
- RFC 5987 — Character Set and Language Encoding for HTTP Header Field Parameters (cách chuẩn hơn nhưng phức tạp hơn, dùng khi cần interop với HTTP clients bên ngoài)
