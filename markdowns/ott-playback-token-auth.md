# Playback Token Auth — nginx `auth_request` ↔ Node `/api/auth/verify`

**Tạo:** 2026-08-09
**Project:** Stream-Central-Server (áp dụng ở `Stream-Sub-Server`)
**Chủ đề:** Sub node xác thực từng request segment như thế nào: nginx hỏi, Node trả lời, và
mã HTTP nào khiến nginx **thật sự ngắt** request.

**Related files:**
- [nginx-config-operations-guide.md](nginx-config-operations-guide.md) §6 — vì sao `nginx -t`
  không bắt được lỗi cấu hình auth.
- [deployment-hidden-bugs-and-pitfalls.md](deployment-hidden-bugs-and-pitfalls.md) §8.3 — ca thật
  `auth_request` trỏ vào `location` đã comment.
- [current-implementation-audit-2026-07.md](current-implementation-audit-2026-07.md) §4 — ghi nhận
  trạng thái cũ "fail-open có chủ đích, chưa phải auth thật".
- Code: `Stream-Sub-Server/services/authService.js`, `controllers/authController.js`,
  `routes/authRoute.js`, `streamingVer3`, `nginx-windows/stream-node-body.conf`,
  `nginx-sites/stream-sub-{linux,windows}.conf`.
- Code (Central, từ 2026-08-15): `Stream-Central-Server/backend/config/playbackToken.js`,
  `services/redirect/playbackRedirectService.js`, `tests/services/playbackToken.test.js`.

---

## 1. Vấn đề: vì sao OTT phải auth ở tầng segment

Với web app thường, kiểm tra quyền một lần lúc mở trang là đủ. Với video thì không:
một phiên xem là **hàng nghìn request độc lập** (segment 2–6 giây), và URL của segment là
URL tĩnh — ai có URL là tải được. Nên bảo vệ phải nằm ở **từng request tới từng file**,
chứ không phải ở màn hình đăng nhập.

Ràng buộc kéo theo, và đây là thứ định hình toàn bộ thiết kế:

| Ràng buộc | Hệ quả thiết kế |
|---|---|
| Gọi ~1800 lần cho một phim 2 tiếng, nhân số người xem | Kiểm tra phải là **CPU thuần**: không DB, không mạng, không `fs.stat` |
| Media byte **không được** đi qua Node (Node chỉ là control plane) | Phải để nginx serve file, chỉ **hỏi** Node quyết định → `auth_request` |
| Player tự retry theo mã lỗi | Trả **đúng** 401 vs 403, sai là player bỏ cuộc hoặc retry vô ích |
| Link bị chia sẻ ra ngoài | Token phải **ngắn hạn** và **gắn với tài nguyên cụ thể** |

Đây cũng là mô hình của CDN thương mại: Akamai *token auth*, CloudFront *signed URL* —
đều là "một chuỗi ký, có hạn, ràng vào path", verify ngay tại edge chứ không hỏi ngược origin.

---

## 2. Hợp đồng của `ngx_http_auth_request_module` (phần hay bị hiểu sai)

```nginx
location / {
    auth_request /__auth;      # nginx tạo SUBREQUEST nội bộ tới /__auth
    try_files $uri =404;       # chỉ chạy nếu subrequest trả 2xx
}
```

Bốn điều bắt buộc phải biết:

1. **Subrequest luôn là `GET` và luôn `header_only`.** Body response bị **vứt bỏ** — trả JSON
   ở endpoint auth là lãng phí thuần tuý. Chỉ **status code** và **header** có tác dụng.
2. **Header của request gốc được kế thừa** sang subrequest → đọc được `X-Player-Token`.
   Nhưng **URI gốc thì không**: subrequest mang URI `/__auth`. Không gửi kèm
   `proxy_set_header X-Original-URI $request_uri;` thì backend **không biết client đang xin
   file nào** → mọi ràng buộc tài nguyên vô hiệu mà không có triệu chứng gì.
3. **Chỉ 3 nhóm status được hiểu**, mọi thứ khác là lỗi:

   | Backend trả | nginx hiểu | Client nhận |
   |---|---|---|
   | `2xx` (200/204) | cho phép | nội dung thật |
   | `401`, `403` | từ chối | **đúng mã đó** |
   | mọi mã khác (400/404/429/500...) | lỗi nội bộ | **`500`** |

   Hệ quả trực tiếp: trả `429 Too Many Requests` cho quá số phiên đồng thời → client nhận
   `500`. Muốn diễn đạt "quá giới hạn" thì phải nén vào `403` + header lý do.
4. **`nginx -t` không kiểm tra URI trong `auth_request` có `location` tương ứng hay không** —
   sai path chỉ lộ ra lúc chạy thật (§8.3 của deployment-hidden-bugs).

---

## 3. Bảng kiểm tra — auth kiểm gì và trả gì

Cột "Mã" chỉ có 401 hoặc 403 vì mục 2. Nguyên tắc phân biệt:
**401 = xin token mới thì qua được · 403 = thử lại vô ích.**

| # | Kiểm tra | Vì sao cần | Mã | `reason` | Trạng thái |
|---|---|---|---|---|---|
| 1 | Có token không (header → query → path) | Không có gì để xác thực | 401 | `no-token` | ✅ đã làm |
| 2 | Chữ ký HMAC hợp lệ | Chặn token tự chế | 401 | `bad-signature` | ✅ |
| 3 | `exp` chưa quá hạn | Link rò rỉ chỉ sống bằng TTL | 401 | `expired` | ✅ |
| 4 | `nbf`/`iat` chưa tới hạn dùng | Chặn token đúc sẵn cho tương lai | 401 | `not-yet-valid` | ✅ |
| 5 | Method là GET/HEAD | Data plane chỉ đọc | 403 | `bad-method` | ✅ |
| 6 | URI sạch (không `..`, không NUL, decode được) | Traversal có thể lách qua so-khớp prefix | 403 | `malformed-uri` | ✅ |
| 7 | **URI nằm trong ACL của token** | **Quan trọng nhất**: không có nó, token phim miễn phí mở được mọi phim | 403 | `resource-mismatch` | ✅ |
| 8 | Phiên chưa bị thu hồi (blacklist) | Bấm "dừng xem", ban tài khoản, vượt giới hạn thiết bị | 403 | `session-revoked` | ⚠️ chỉ in-memory 1 process |
| 9 | IP khớp (so `/24`) | Chống chia sẻ link | 403 | `ip-mismatch` | ✅ nhưng **tắt mặc định** |
| 10 | Số phiên đồng thời / thiết bị | "Quá nhiều thiết bị" kiểu Netflix | 403 | — | ❌ cần store dùng chung (Redis) |
| 11 | Geo-blocking / bản quyền theo lãnh thổ | Ràng buộc hợp đồng nội dung | 403 | — | ❌ chưa làm |
| 12 | DRM license (Widevine/PlayReady) | Bảo vệ nội dung cao cấp | — | — | ❌ dịch vụ riêng, không thuộc `/__auth` |

**Cố tình KHÔNG kiểm tra ở đây:**

- **File có tồn tại không** — việc của `try_files`. Làm lại bằng `fs.existsSync` là nhân đôi
  syscall cho mỗi segment, đổi lại đúng con số 0 giá trị bảo mật.
- **Quyền theo tài khoản / trạng thái thanh toán** — thuộc Central lúc **phát** token.
  Sub node là data plane, không có DB (xem `upload-replication-contract-v2.md`); nó chỉ
  xác minh chữ ký của Central, không tự tra cứu người dùng.

### Vì sao "token không có ràng buộc nào" bị coi là **không hợp lệ**

Token qua được chữ ký nhưng thiếu cả `url` lẫn `acl` sẽ bị trả `resource-mismatch`, thay vì
hiểu là "không giới hạn". Đây là lựa chọn **fail-closed** có chủ đích: claim thiếu gần như
luôn là lỗi phía phát token, và diễn giải nó thành "mở tất cả" biến một bug thành một lỗ hổng.

---

## 4. Ba chế độ — và vì sao `log` là bước bắt buộc

Công tắc nằm ở `AUTH_MODE` trong `config.env` của Node, **không phải** ở nginx:

| Mode | Hành vi | Ý nghĩa vận hành |
|---|---|---|
| `off` | luôn 204 | Chưa có Central phát token. Giữ nguyên hành vi cũ, không làm vỡ gì |
| `log` | **vẫn cho qua**, nhưng đếm + ghi lại lý do | Đo **tỉ lệ chặn nhầm trên traffic thật** trước khi siết |
| `enforce` | chặn thật 401/403 | Bật khi `log` đã sạch |

Bỏ qua `log` mà bật thẳng `enforce` là cách nhanh nhất để cắt sóng người dùng thật: player
đời cũ không gắn được header, đồng hồ VM lệch làm token "hết hạn" sớm, client mobile đổi IP
giữa phiên. Đây đều là thứ **không đoán được**, chỉ đo được. `GET /api/auth/stats` trả về
`wouldDeny` và `byReason` chính là để đọc trước khi quyết định.

Đặt công tắc ở Node (không phải nginx) vì hai lý do: đổi mức siết chỉ cần
`pm2 restart server --update-env`, và bản thân mode `log` là thứ nginx **không diễn đạt được**
— nginx chỉ biết cho qua hoặc chặn.

---

## 5. Fail-open: mở ở đâu, đóng ở đâu

```nginx
error_page 500 502 503 504 = @serve;   # KHÔNG có 401/403 trong danh sách
```

Tách bạch hai loại thất bại:

- **Bị từ chối** (401/403) → chặn thật. Đây là auth làm đúng việc.
- **Auth service không trả lời được** (Node chết/treo → 5xx) → **vẫn serve file**.

Lý do chọn fail-open ở nhánh hạ tầng: khi Node chết, nginx là thứ duy nhất còn sống trên node
đó, và cắt video của người đang xem gây thiệt hại lớn hơn rủi ro cho qua vài request trong
lúc Node restart. Đây là **đánh đổi có ý thức, không phải mặc định** — muốn fail-closed tuyệt
đối thì xoá đúng dòng trên và cả `location @serve`.

So với trạng thái cũ (`error_page 401 403 500 502 503 504 = @serve;`): dòng cũ nuốt cả 401/403,
tức là auth **không bao giờ** chặn được gì.

---

## 6. Nguồn token — 3 đường, và vì sao phải hỗ trợ cả 3

| Nguồn | Ưu | Nhược | Ai dùng được |
|---|---|---|---|
| Header `X-Player-Token` | Không lọt vào `access.log`, không dính vào link chia sẻ | Player phải sửa được request header | dash.js (qua `RequestModifier`), app native |
| Query `?token=` | Chạy với **mọi** player | Ghi vào log, dính vào URL khi copy | `<video src>` thuần, smart TV, VLC |
| Path `/dash-token/<jwt>/...` | Dạng repo đã dùng sẵn ở `videoController` | Phải viết lại manifest để chèn token | luồng hiện có |

Thứ tự ưu tiên: **header > query > path** (cụ thể hơn thì thắng). CDN thương mại chọn query
làm mặc định chính vì lý do tương thích, chấp nhận đánh đổi về log — đó là lý do TTL của
token phát video phải **ngắn** (30s–5 phút), không dùng chung `JWT_EXPIRES_IN=90d` của token
đăng nhập.

### 6.1 [UPDATED 2026-08-15] Cái giá thật của header: preflight trên **mỗi segment**

Bảng trên ghi nhược điểm của header là "player phải sửa được request header". Đó là điều kiện
*đủ điều kiện dùng*, chưa phải cái giá. Cái giá nằm ở CORS:

Thêm một header tuỳ ý (`X-Player-Token`) vào request cross-origin làm nó không còn là
["simple request"](https://fetch.spec.whatwg.org/#cors-preflight-request) → trình duyệt phải gửi
`OPTIONS` preflight trước. Và **CORS-preflight cache được key theo URL**
([Fetch §cors-preflight-cache](https://fetch.spec.whatwg.org/#cors-preflight-cache)) — mà mỗi
segment là một URL khác nhau. Hệ quả: **một OPTIONS phụ cho mỗi segment**, và
`Access-Control-Max-Age: 86400` *không* cứu được, vì nó chỉ kéo dài hiệu lực cho đúng URL đó.

Với phim 2 tiếng segment 4s: ~1800 segment → ~1800 preflight → **gấp đôi số round-trip**.

Cách giảm:

| Cách | Preflight | Ghi chú |
|---|---|---|
| Query `?token=` cho segment, header cho manifest | Không | Lai — được cả tương thích lẫn số request. Đánh đổi: token lọt vào `access.log` |
| Cookie (`Path=/videos/<key>`) | Không | Cookie là "simple", nhưng buộc bỏ `Allow-Origin: *` sang origin cụ thể + `Allow-Credentials: true` |
| Chỉ header | Có, mỗi segment | Sạch nhất về log, đắt nhất về mạng |

`if ($request_method = OPTIONS) { return 204; }` trong config đã làm preflight rẻ **về phía
server** (không chạm auth, không chạm đĩa), nhưng round-trip từ trình duyệt thì không cách nào
bỏ được. Đây là lý do kỹ thuật vì sao Akamai/CloudFront chọn query chứ không chọn header.

---

## 7. Giới hạn đã biết (đừng nhầm là đã xong)

1. **Blacklist nằm trong RAM của đúng 1 process.** `pm2 restart` là mất; node khác không thấy.
   Thu hồi phiên ở quy mô nhiều node cần store dùng chung — `modules/redisAPI.js` đã có khung.
2. **Chưa giới hạn số phiên đồng thời** (#10) vì cùng lý do: cần state chia sẻ.
3. > [SUPERSEDED 2026-08-15] ~~**Central chưa phát token dạng này.** `AUTH_MODE=off` là mặc định
   > đúng cho tới khi Central ký token có `url`/`acl` + `exp` ngắn.~~

   **[UPDATED 2026-08-15] Central đã phát token dạng này** — xem §9.

   **[UPDATED 2026-08-15b] Frontend đã gắn token vào mọi request** — xem §12. Cả ba mắt xích
   (Central ký → FE gắn → Sub verify) đã thông; điều kiện còn lại để bật `enforce` chỉ là đọc
   `/api/auth/stats` ở mode `log` cho tới khi `wouldDeny` về ~0.
4. **Cache kết quả auth ở nginx** (khối `proxy_cache` đã viết sẵn dạng comment) sẽ làm việc
   **thu hồi phiên trễ đúng bằng TTL cache**. Đây là đánh đổi tải-vs-độ-trễ-thu-hồi, phải
   quyết định có ý thức chứ không bật cho vui.
5. **Ghim IP so theo `/24`** là thoả hiệp: chặt hơn thì đá nhầm người dùng di động, lỏng hơn
   thì gần như vô dụng. Mặc định tắt.

---

## 8. Kiểm tra nhanh

```bash
curl -i -H "X-Original-URI: /videos/abc/init.mpd" http://127.0.0.1:9100/api/auth/verify
```

Đọc `X-Auth-Reason` trong response để biết vì sao bị chặn — cột `reason` khớp bảng ở mục 3.
Sau đó xem tổng hợp:

```bash
curl http://127.0.0.1:9100/api/auth/stats
```

Unit test tương ứng: `npm test` (`tests/auth.test.js`, 12 case phủ hết bảng mục 3).

---

## 9. [UPDATED 2026-08-15] Central phát token — đã implement

`Stream-Central-Server/backend/config/playbackToken.js` giờ phát **hai loại token khác hẳn nhau**,
không phải một token hai TTL:

| | `issue()` — legacy | `issuePlayback()` — segment |
|---|---|---|
| Đi trong | path `/dash-token/<jwt>.mpd` | header `X-Player-Token` hoặc `?token=` |
| Ai phục vụ | Node `:9100` tự đọc rồi serve file | nginx `:9150` hỏi Node qua `auth_request` |
| TTL | 90 ngày | 4 giờ (env `PLAYBACK_SEGMENT_TTL_SECONDS`) |
| Claim ràng buộc | `secret` (Sub **không** kiểm) | `url` + `acl` — ràng buộc tài nguyên thật |

Claim của token segment:

```json
{ "url": "videos/<storageKey>",
  "acl": ["videos/<storageKey>"],
  "sessionID": "…", "kind": "playback", "exp": … }
```

Phát **cả `url` lẫn `acl`** vì `authService.aclOf()` đọc cả hai — token dùng được ở cả đường
nginx mới lẫn handler `/dash-token/` cũ. `storageKey` bị validate theo `^[A-Za-z0-9._-]+$`
trước khi ghép vào ACL: một key chứa `/` hoặc `..` sẽ nới quyền của token ra ngoài thư mục
của chính nó, vì ACL so khớp theo prefix.

Token trả về trong response `dash-token` **của v2** (v1 giữ nguyên hình dạng cũ), ở field
`playback: { token, sessionID, expiresIn, expiresAt, headerName, queryName }`.

### Vì sao TTL mặc định là 4 giờ chứ không phải 5 phút

§6 nói TTL nên 30s–5 phút. Con số đó chỉ đúng **khi player biết tự xin token mới giữa chừng**.
Frontend hiện chưa có vòng refresh. Phát token 5 phút ngay bây giờ nghĩa là: hôm nào bật
`AUTH_MODE=enforce`, mọi phim dài hơn 5 phút sẽ chết giữa chừng — và triệu chứng
(`expired` rải rác giữa phiên xem) rất khó quy về nguyên nhân.

4 giờ phủ được một phim dài mà vẫn ngắn hơn token legacy **540 lần**. Hạ xuống 300 ngay sau khi
FE có refresh. `expiresAt`/`expiresIn` đã trả sẵn trong response chính là để FE dựng vòng đó.

### Điều CỐ TÌNH không làm: nhét `?token=` vào `nginxUrl`

Trông thì tiện, nhưng dash.js giải URL segment **tương đối** so với manifest, và query string
**không** được kế thừa sang URL tương đối. Gắn `?token=` vào manifest sẽ auth được đúng
manifest, còn toàn bộ segment vẫn trần — auth nửa vời, tệ hơn không có vì tạo cảm giác an toàn
giả. FE phải gắn token vào **từng** request.

---

## 10. [UPDATED 2026-08-15] Player tự kiểm chứng — hai tầng

Trả lời cho câu "có thể cho player một cách tự kiểm chứng không". Có, và nên làm cả hai tầng —
chúng bắt hai loại lỗi khác nhau:

**Tầng 1 — trước khi play (rẻ, không cần round-trip).** Decode `exp` của JWT ngay tại client;
hết hạn hoặc sắp hết thì xin token mới trước khi nạp manifest. Bắt được trường hợp người dùng
mở lại tab cũ sau nhiều giờ.

**Tầng 2 — trong lúc play (phân biệt theo mã lỗi).** Đây là lý do `authService` phân loại
401/403 cẩn thận thay vì trả bừa một mã:

| Player nhận | Nghĩa | Player nên làm |
|---|---|---|
| `401` | thiếu/hỏng/hết hạn credential | **xin token mới rồi retry** — cứu được phiên xem |
| `403` | đọc được credential nhưng không có quyền | dừng, báo người dùng — retry vô ích |
| `500` | auth service hỏng (hoặc config sai) | không phải lỗi quyền; xem §5 |

Trả `403` cho token hết hạn sẽ khiến player **bỏ cuộc** thay vì đi refresh — đó là hỏng một
phiên xem lẽ ra cứu được. Đây là lỗi thiết kế phổ biến khi tự làm token auth.

Node đã trả `X-Auth-Reason` và nginx đã bắt lại bằng `auth_request_set`, nên player/log có
thể đọc lý do cụ thể (`expired`, `resource-mismatch`, `session-revoked`…) thay vì đoán từ mã
lỗi trần.

---

## 11. [UPDATED 2026-08-15] Config nginx — bản drop-in và cái bẫy module thiếu

Thêm `nginx-sites/stream-sub-linux.conf` và `nginx-sites/stream-sub-windows.conf`: bản tự chứa
dẫn xuất từ `streamingVer3`, thả vào `sites-enabled` là chạy, chỉ sửa một dòng `root`.
`streamingVer3` + `nginx_subVer3.conf` vẫn là bản chuẩn để đọc hiểu lý do từng dòng.

**Bẫy mới ghi nhận — `auth_request` không có sẵn trong mọi bản nginx:**

```bash
nginx -V 2>&1 | grep -o with-http_auth_request_module
```

Không in ra gì = module không được biên dịch. Hậu quả **không phải** "auth không chạy" mà là:

```
nginx: [emerg] unknown directive "auth_request"
```

→ nginx **không khởi động được**, mất luôn cả web server. Đã xác nhận trên
`Working-Window-NGINX-Streaming-Server/NGINX.exe` (nginx 1.17.10) trong repo. Trên
Ubuntu/Debian: `nginx-full`/`nginx-extras` có sẵn, `nginx-light` **không**.

Đây là nhóm lỗi khác với §6 của `nginx-config-operations-guide.md` (`nginx -t` PASS nhưng sai
lúc chạy): ở đây `nginx -t` **fail thẳng**, nên dễ phát hiện hơn — miễn là có chạy `nginx -t`.

**Đã gỡ bẫy ở `nginx.conf` legacy:** file đó có `auth_request /__auth;` trong khi
`location = /__auth` bị comment. Mỗi segment tốn một subrequest chắc chắn 404 → nginx dịch
thành 500 → `error_page` → `@serve`, tức auth trông như bật mà không chặn gì. `error_page` cũ
còn nuốt cả `401 403`. Nay đã gỡ `auth_request` khỏi file legacy và đánh dấu LEGACY ở đầu file;
các file legacy khác (`streamingVer2`, `nginx_sub.conf`, `site-enabled-streaming`) giữ nguyên.

---

## 12. [UPDATED 2026-08-15b] Frontend gắn token — đã implement

`Stream-Central-Server/frontend`:

| Việc | File |
|---|---|
| Lấy URL + token qua connector chung (v1/v2 khác cả path lẫn tên field) | `APIs/playback-api.js` |
| Gắn token vào **mọi** request dash.js phát ra | `components/videoCmp/DashVideoPlayer.jsx` |
| Vòng làm mới token trước hạn | `DashVideoPlayer.jsx` + `pages/PlayerHubPageVer1.jsx` |

### Chọn `modifyRequestURL` (query) chứ không phải `modifyRequestHeader`

dash.js gọi `RequestModifier.modifyRequestURL` trong `HTTPLoader` cho **mọi** request —
manifest, init segment, media segment — nên một chỗ duy nhất phủ hết. Dùng query thay header
là để tránh preflight-mỗi-segment ở §6.1.

Bản cũ gửi `X-Player-Token: 'abcdef123456'` và `X-Player-Session: '1234567890'` — **hằng số
cứng**, khớp với một nhánh kiểm tra đã bị comment ở `videoController.js`. Tức là: trả giá
preflight cho mỗi segment để gửi một chuỗi không ai kiểm. Đã bỏ hẳn hai header đó.

Ba chi tiết nhỏ nhưng cần thiết trong hàm gắn token:

- đọc token qua **ref**, không capture giá trị: `RequestModifier` chỉ đăng ký một lần lúc dựng
  player, capture state là giữ mãi token của lần render đầu;
- không gắn đè nếu URL đã có `token=` (dash.js retry cùng URL);
- chọn `?` hay `&` theo URL sẵn có (CMCD của dash.js cũng ghi query vào cùng URL).

### Làm mới token: sớm hơn hạn, và **không** dựng lại player

Timer xin token mới trước hạn 5 phút. Khi có token mới thì **chỉ ghi vào ref** — không đổi
`dashUrl`, không `setState` gì chạm tới nguồn phát. Đổi `dashUrl` sẽ khiến dash.js dựng lại,
mất buffer và người xem thấy khựng giữa phim.

Chờ 401 rồi mới chữa là lựa chọn tệ hơn: lúc đó dash.js đã tính một lần tải segment thất bại
và có thể tụt bitrate hoặc rebuffer trước khi token mới kịp về.

### Kiểm chứng thật (2026-08-15, nginx 1.28.0 + Node :9100)

Token do Central ký, hỏi thẳng `/api/auth/verify` của Sub:

| Trường hợp | `X-Auth-Reason` |
|---|---|
| token đúng video, xin segment | `ok` |
| token đúng video, xin manifest | `ok` |
| **token của video khác** | `resource-mismatch` |
| không có token | `no-token` |
| token bịa | `bad-signature` |

Kéo thật qua nginx `:9150` với `?token=`: manifest `200 application/dash+xml`, segment
`200 178890 bytes`. `/api/auth/stats` chuyển từ `allowed=0` sang có `ok` trong `byReason` —
trước đó 100% là `no-token`.

Điều kiện tiên quyết đã kiểm: `JWT_SECRET` của Central **trùng** với Sub. Lệch giá trị này thì
mọi segment nhận `bad-signature`, và đó là lỗi cấu hình chứ không phải lỗi code.

---

## References (truy cập 2026-08-09)

- nginx docs — `ngx_http_auth_request_module` — https://nginx.org/en/docs/http/ngx_http_auth_request_module.html
- nginx docs — `error_page` — https://nginx.org/en/docs/http/ngx_http_core_module.html#error_page
- RFC 9110 §15.5.2 (401) và §15.5.4 (403) — phân biệt "chưa xác thực" vs "đã xác thực nhưng không được phép" — https://www.rfc-editor.org/rfc/rfc9110#name-401-unauthorized
- RFC 7519 — JSON Web Token (`exp`, `nbf`, `iat`) — https://www.rfc-editor.org/rfc/rfc7519
- WHATWG Fetch — CORS-preflight request và **CORS-preflight cache key theo URL** (nguồn của §6.1) — https://fetch.spec.whatwg.org/#cors-preflight-cache
- nginx docs — cài đặt/biên dịch, cờ `--with-http_auth_request_module` (nguồn của §11) — https://nginx.org/en/docs/configure.html
- dash.js — `RequestModifier` (`modifyRequestHeader` / `modifyRequestURL`) — https://github.com/Dash-Industry-Forum/dash.js
- hls.js — `xhrSetup` / `fetchSetup` trong config — https://github.com/video-dev/hls.js
- Akamai — Token Auth cho media delivery (mô hình ACL + hạn dùng ở edge) — https://techdocs.akamai.com/download-delivery/docs/token-auth
- AWS CloudFront — signed URLs/cookies (ràng buộc path + expiry + IP tuỳ chọn) — https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html

---

## Changelog

- **2026-08-15b** — Frontend gắn token vào mọi request (§12 mới): `APIs/playback-api.js` đi qua
  connector chung, `DashVideoPlayer` dùng `modifyRequestURL` (query) thay `modifyRequestHeader`
  để tránh preflight-mỗi-segment, bỏ hai header hằng số cứng `X-Player-Token: 'abcdef123456'` /
  `X-Player-Session: '1234567890'`, thêm vòng làm mới token trước hạn 5 phút không dựng lại
  player. Giới hạn #3 ở §7 cập nhật lần hai: cả ba mắt xích đã thông. Kèm bảng kiểm chứng thật
  5 trường hợp (`ok` / `resource-mismatch` / `no-token` / `bad-signature`) trên nginx 1.28.0.
- **2026-08-15** — Central đã phát token segment thật (§9 mới): `issuePlayback()` với claim
  `url`+`acl`, TTL 4 giờ có env override, validate `storageKey` trước khi ghép ACL; giới hạn #3
  ở §7 được đánh dấu SUPERSEDED. Thêm §6.1 — cái giá thật của `X-Player-Token` là **preflight
  trên mỗi segment** (CORS-preflight cache key theo URL), kèm 3 cách giảm. Thêm §10 — mẫu player
  tự kiểm chứng hai tầng và vì sao 401 vs 403 quyết định phiên xem được cứu hay không. Thêm §11 —
  bản config drop-in `nginx-sites/*`, bẫy nginx **thiếu `ngx_http_auth_request_module`** (đã xác
  nhận trên nginx 1.17.10 bản Windows trong repo: `[emerg]`, nginx không khởi động), và việc gỡ
  `auth_request` treo khỏi `nginx.conf` legacy. Giữ nguyên toàn bộ nội dung cũ.
- **2026-08-09** — Tạo file cùng lúc với việc implement `/api/auth/verify` ở `Stream-Sub-Server`
  (trước đó nginx trỏ `auth_request` vào một `location` bị comment, và endpoint tương ứng ở Node
  chưa từng tồn tại). Ghi lại: hợp đồng `auth_request`, bảng 12 kiểm tra kèm mã trả về, 3 chế độ
  `off/log/enforce`, ranh giới fail-open, 3 nguồn token và 5 giới hạn còn treo.
