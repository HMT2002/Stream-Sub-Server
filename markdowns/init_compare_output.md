# Kiểm tra & So sánh Stream đã Encode (DASH/MP4) — Verify + Quality Compare

> **Mục đích:** sau khi encode ra DASH (`init.mpd` + các `.m4s`), làm sao để (1) **kiểm tra**
> stream đã đúng chưa, (2) **phát thử** đúng rendition muốn soi, (3) **so sánh trực quan**
> bản H.264 vs HEVC / bản encode vs gốc, (4) **so sánh định lượng** bằng VMAF/PSNR/SSIM.
>
> Mọi lệnh dưới đây **copy là chạy được ngay** — chỉ cần thay đường dẫn file. Mỗi lệnh có
> bản "dán-chạy" (1 dòng) + giải thích từng option. Các điểm phụ thuộc **player có hỗ trợ
> codec hay không** được chú thích rõ (dash.js / VLC / mpv / ffplay khác nhau).
>
> **Nguồn chính thống:** [ffmpeg.org filters (libvmaf/psnr/ssim)](https://ffmpeg.org/ffmpeg-filters.html) ·
> [Netflix/vmaf — ffmpeg.md](https://github.com/Netflix/vmaf/blob/master/resource/doc/ffmpeg.md) ·
> [mpv manual (--lavfi-complex)](https://mpv.io/manual/master/#options-lavfi-complex) ·
> [VLC adaptive options](https://wiki.videolan.org/Documentation:Modules/adaptive/) ·
> [ffprobe docs](https://ffmpeg.org/ffprobe.html)
>
> Liên quan: [ffmpeg-hevc-dash-streaming-notes.md](ffmpeg-hevc-dash-streaming-notes.md) (§13 HEVC vs H.264,
> §15 lệnh encode H.264/HEVC để so), [encode_explain.md](encode_explain.md) (annotate lệnh encode).

---

## 0. Công cụ nào phát/đọc được gì? (đọc trước khi chọn lệnh verify)

Đây là điểm gây nhầm nhất: **công cụ verify khác với player thật của người dùng.** Một bản
HEVC có thể mở ngon trong VLC/mpv nhưng **chết trên web dash.js**. Đừng kết luận "encode OK"
chỉ vì VLC phát được.

| Công cụ | Vai trò | H.264 (avc1) | HEVC (hev1/hvc1) | Đọc `.mpd` đa rendition | Ghi chú |
|---|---|---|---|---|---|
| **dash.js** (web player thật) | Player production của dự án | ✅ | ❌ native (cần WASM) | ✅ chọn theo bandwidth | Đây mới là "khách hàng" thật. Xem [notes §13](ffmpeg-hevc-dash-streaming-notes.md) |
| **VLC** | Verify nhanh trên desktop | ✅ | ✅ | ⚠️ chọn 1 rendition (xem §2) | Khoan dung lỗi cao → **dễ "phát được" cả file mà web từ chối** |
| **mpv** (dùng libav) | Verify + so sánh side-by-side | ✅ | ✅ | ✅ mỗi rendition = 1 track | Mạnh nhất để soi pixel + frame-step |
| **ffprobe / ffmpeg** | Đọc metadata + đo VMAF/PSNR | ✅ | ✅ | ✅ liệt kê hết stream | Không "phát", chỉ phân tích |

> **Kết luận thực dụng:** đo chất lượng/đọc metadata → ffprobe/ffmpeg/mpv. Còn muốn biết
> **web có chạy không → bắt buộc test bằng dash.js thật**, vì VLC/mpv khoan dung hơn MSE nhiều.

---

## 1. Kiểm tra stream đã encode đúng chưa (ffprobe)

### 1.1 Liệt kê tất cả Representation trong MPD

**Dán-chạy:**
```bash
ffprobe -hide_banner init.mpd
```
- `-hide_banner` — bỏ phần in version/config dài dòng của ffprobe, log gọn hơn.
- `init.mpd` — ffprobe parse manifest DASH, in ra **từng Program/Stream** (mỗi video
  Representation là 1 stream): codec, resolution, bitrate, fps.

➡️ Mục đích: xác nhận **đủ số rendition** mong muốn (vd 3 video + 1 audio) và **đúng độ phân
giải** từng mức. Nếu thấy 2 stream cùng `1920x1080` → trùng res (lỗi map thừa, xem
[notes §9.2](ffmpeg-hevc-dash-streaming-notes.md)).

### 1.2 Bảng gọn: index / codec / res / bitrate

**Dán-chạy:**
```bash
ffprobe -v error -show_entries stream=index,codec_name,width,height,bit_rate -of csv=p=0 init.mpd
```
- `-v error` — chỉ in lỗi, bỏ hết log info → output sạch để đọc/parse.
- `-show_entries stream=index,codec_name,width,height,bit_rate` — chỉ lấy đúng 5 trường cần.
- `-of csv=p=0` — xuất CSV, `p=0` = bỏ tiền tố tên section → mỗi dòng `0,h264,854,480,...`.

➡️ Dùng để **đối chiếu nhanh ladder** với cấu hình encode (`-b:v:N`, `-s:v:N`).

### 1.3 Codec string trong MPD — yếu tố quyết định dash.js phát được hay không

**Dán-chạy (Windows PowerShell / cmd):**
```powershell
findstr "codecs=" init.mpd
```
**Dán-chạy (Linux/macOS):**
```bash
grep "codecs=" init.mpd
```
- Lọc các dòng `<Representation ... codecs="...">` trong MPD.

➡️ **Đọc kết quả thế nào:**
- `codecs="avc1.640028"` (đầy đủ profile/level) → **H.264 OK, dash.js phát được mọi trình duyệt.**
- `codecs="hev1"` (cụt, thiếu profile/tier/level) → **dash.js audio-only** dù máy có HW
  decoder, vì MSE `isTypeSupported()` cần string đầy đủ (`hvc1.1.6.L93.B0`). Chi tiết rào này:
  [notes §13.1](ffmpeg-hevc-dash-streaming-notes.md).

### 1.4 Kiểm keyframe có align với segment không

Player chỉ switch quality được nếu **mỗi segment bắt đầu bằng keyframe (IDR)**. Lệnh sau in
loại frame + mốc thời gian của 1 rendition (trỏ vào init segment của rendition đó):

**Dán-chạy:**
```bash
ffprobe -v error -select_streams v -skip_frame nokey -show_entries frame=pts_time,pict_type -of csv=p=0 init.mpd
```
- `-select_streams v` — chỉ xét stream video.
- `-skip_frame nokey` — **bỏ qua mọi frame không phải keyframe** → chỉ liệt kê keyframe.
- `-show_entries frame=pts_time,pict_type` — lấy mốc thời gian + loại frame (`I`).

➡️ Các mốc keyframe nên rơi đúng bội số `seg_duration` (vd 0, 2, 4, 6… với seg 4s + keyframe
2s). Nếu lệch → segment cắt sai chỗ. Xem quy tắc align: [notes §3.5](ffmpeg-hevc-dash-streaming-notes.md).

> ⚠️ Một số bản ffprobe đọc keyframe từ `.mpd` không ổn định → có thể trỏ thẳng vào 1 media
> segment đã ghép, hoặc vào file mp4 nguồn rendition, để chắc chắn.

---

## 2. Phát thử đúng rendition muốn soi

`.mpd` chứa nhiều rendition; mặc định player tự chọn → muốn soi **đúng một mức** phải ép.

### 2.1 mpv — liệt kê rồi chọn track

**Liệt kê track (xem rendition nào là `vid` mấy):**
```bash
mpv --msg-level=all=v init.mpd
```
- `--msg-level=all=v` — log verbose; phần `Video --vid=N (...)` cho biết index từng rendition.

**Phát đúng 1 rendition (thay N bằng index thật ở trên):**
```bash
mpv --vid=2 init.mpd
```
- `--vid=2` — ép mpv chỉ phát video track số 2 (vd mức 480p), không auto-switch.

### 2.2 VLC — chọn theo logic adaptive

**Dán-chạy:**
```bash
vlc --adaptive-logic=highest --adaptive-maxheight=480 init.mpd
```
- `--adaptive-logic=highest` — trong các mức **thỏa ràng buộc**, chọn mức cao nhất (thay vì
  để VLC tự đoán theo băng thông).
- `--adaptive-maxheight=480` — chặn trần ở 480p → kết hợp với `highest` = **lấy đúng mức 480p**.

➡️ Mẹo này để "khóa" VLC vào đúng 1 rendition mà soi, tránh nó nhảy mức giữa chừng.

### 2.3 Trích 1 frame ra PNG để soi pixel (không upscale)

**Dán-chạy:**
```bash
ffmpeg -i init.mpd -map 0:v:0 -vf "select=eq(n\,500)" -vframes 1 -y frame_480.png
```
- `-map 0:v:0` — chọn **rendition video đầu tiên** (đổi `0:v:1`, `0:v:2`… cho mức khác).
- `-vf "select=eq(n\,500)"` — lọc đúng **frame số 500** (`\,` để escape dấu phẩy trong filter).
- `-vframes 1` — chỉ ghi 1 frame rồi dừng.
- `-y` — ghi đè file PNG nếu đã có (để copy-chạy lại không bị hỏi).

➡️ Mở PNG zoom 100% để soi blocking/banding ở đúng pixel, **không bị player upscale đánh lừa**.

---

## 3. So sánh trực quan side-by-side (mpv) — H.264 vs HEVC, hoặc encode vs gốc

`mpv --lavfi-complex` ghép 2 nguồn vào **một cửa sổ**, frame-step đồng bộ để soi khác biệt.

### 3.1 Cạnh nhau (hstack) — scale cùng CHIỀU CAO

**Dán-chạy (thay 2 đường dẫn .mpd):**
```bash
mpv videos/XXXX_hevc/init.mpd --external-file=videos/XXXX_h264/init.mpd --lavfi-complex="[vid1]scale=-2:720[a];[vid2]scale=-2:720[b];[a][b]hstack[vo]"
```
**Giải thích từng phần:**
- `videos/XXXX_hevc/init.mpd` — file **chính** (nguồn `[vid1]`).
- `--external-file=videos/XXXX_h264/init.mpd` — nạp thêm file **thứ 2** (nguồn `[vid2]`,
  một số bản mpv đánh số cao hơn như `[vid4]` — xem log `--msg-level` để biết chính xác).
- `[vid1]scale=-2:720[a]` — scale nguồn 1 về **cao 720**, rộng `-2` = tự tính giữ tỉ lệ (chia hết 2).
- `[vid2]scale=-2:720[b]` — scale nguồn 2 cùng chiều cao 720 (bắt buộc cùng cao để hstack được).
- `[a][b]hstack[vo]` — ghép **ngang** a|b thành 1 khung `[vo]` mpv hiển thị.

### 3.2 Trên–dưới (vstack) — scale cùng CHIỀU RỘNG

**Dán-chạy:**
```bash
mpv videos/XXXX_hevc/init.mpd --external-file=videos/XXXX_h264/init.mpd --lavfi-complex="[vid1]scale=1280:-2[a];[vid2]scale=1280:-2[b];[a][b]vstack[vo]"
```
- `scale=1280:-2` — ép **rộng 1280**, cao tự tính (vstack cần cùng chiều rộng).
- `[a][b]vstack[vo]` — ghép **dọc** (trên/dưới).

### 3.3 Điều khiển khi soi
- **Frame-step:** `.` (tiến 1 frame) / `,` (lùi 1 frame) — soi từng khung.
- **Seek về cùng mốc 2 nguồn:** mở console bằng `` ` `` rồi gõ `seek <giây> absolute exact`.
- `[vidN]` sai → mpv báo "label not found"; chạy `mpv --msg-level=all=v` để lấy đúng index.

> **Lưu ý player support:** mpv giải mã HEVC tốt nên so H.264↔HEVC offline thoải mái. Nhưng
> **bản HEVC dù đẹp ở mpv vẫn KHÔNG lên được web dash.js** — đây chỉ là so chất lượng offline,
> không phải nghiệm thu cho player production.

---

## 4. So sánh ĐỊNH LƯỢNG — VMAF / PSNR / SSIM

Số liệu khách quan thay cho "nhìn bằng mắt". **Quy tắc bắt buộc:** hai input phải **cùng độ
phân giải và cùng fps**. Bản encode 480p phải **upscale về đúng res của bản gốc** (bicubic)
trước khi đo, vì model VMAF tính ở **độ phân giải hiển thị**.

> **Thứ tự input của `libvmaf` / `psnr` / `ssim`:** **`[distorted][reference]`** — nhánh
> **bị nén (cần chấm điểm) đứng TRƯỚC**, nhánh **gốc (tham chiếu) đứng SAU**. Ngược thứ tự →
> điểm sai. (Nguồn: [Netflix/vmaf ffmpeg.md](https://github.com/Netflix/vmaf/blob/master/resource/doc/ffmpeg.md))

### 4.1 Chuẩn bị: tách 1 rendition khỏi DASH ra MP4 (robust nhất)

Đo thẳng từ `.mpd` hay nhầm rendition (ffmpeg lấy mức mặc định). An toàn hơn: **rút đúng
rendition** ra file rồi mới đo.

**Dán-chạy:**
```bash
ffmpeg -i init.mpd -map 0:v:0 -c copy -y rendition0.mp4
```
- `-map 0:v:0` — chọn rendition video 0 (đổi `:1`,`:2` cho mức khác).
- `-c copy` — **copy bitstream, KHÔNG re-encode** → giữ nguyên chất lượng đã encode để chấm đúng.
- `-y` — ghi đè.

### 4.2 VMAF (thang 0–100, càng cao càng giống gốc)

**Dán-chạy (distorted = rendition0 480p, reference = source 1080p):**
```bash
ffmpeg -i rendition0.mp4 -i videos/IjTyvFk.mp4 -lavfi "[0:v]scale=1920:1080:flags=bicubic[dist];[dist][1:v]libvmaf=log_path=vmaf.json:log_fmt=json" -f null -
```
**Giải thích:**
- `-i rendition0.mp4` (input 0 = **distorted**) · `-i videos/IjTyvFk.mp4` (input 1 = **reference/gốc**).
- `[0:v]scale=1920:1080:flags=bicubic[dist]` — **upscale bản nén** lên đúng res gốc bằng
  bicubic (chuẩn khuyến nghị của Netflix), đặt nhãn `[dist]`.
- `[dist][1:v]libvmaf=...` — đưa **distorted trước, reference sau** vào filter VMAF.
- `log_path=vmaf.json:log_fmt=json` — ghi điểm chi tiết từng frame ra `vmaf.json`.
- `-f null -` — không ghi video output (chỉ cần điểm), bỏ kết quả vào "null".

➡️ Điểm VMAF trung bình in ở cuối log (dòng `VMAF score: ...`). >90 ≈ gần như không phân biệt;
70–90 = chấp nhận được; <70 = thấy rõ vỡ.

**Đo nhiều metric một lần (VMAF + PSNR + SSIM):**
```bash
ffmpeg -i rendition0.mp4 -i videos/IjTyvFk.mp4 -lavfi "[0:v]scale=1920:1080:flags=bicubic[dist];[dist][1:v]libvmaf=feature='name=psnr|name=float_ssim':log_path=vmaf.json:log_fmt=json" -f null -
```
- `feature='name=psnr|name=float_ssim'` — bật thêm PSNR và SSIM **ngay trong libvmaf**, khỏi
  chạy 3 lần. (Một số bản cũ dùng `psnr=1:ssim=1` — nếu lỗi cú pháp, đổi sang dạng `feature=`.)

> ⚠️ `libvmaf` chỉ chạy khi ffmpeg được build có `--enable-libvmaf`. Kiểm:
> `ffmpeg -filters | findstr vmaf` (Windows) / `ffmpeg -filters | grep vmaf` (Unix). Không có
> → cài bản ffmpeg full (gyan.dev/BtbN build) hoặc dùng PSNR/SSIM (luôn có sẵn).

### 4.3 PSNR (dB, càng cao càng tốt; ~>40dB rất tốt)

**Dán-chạy:**
```bash
ffmpeg -i rendition0.mp4 -i videos/IjTyvFk.mp4 -lavfi "[0:v]scale=1920:1080:flags=bicubic[dist];[dist][1:v]psnr=stats_file=psnr.log" -f null -
```
- `psnr=stats_file=psnr.log` — tính PSNR per-frame, ghi log; điểm trung bình in ở cuối
  (`PSNR ... average:..`).
- PSNR đơn giản/nhanh nhưng **không sát cảm nhận mắt** bằng VMAF (nên ưu tiên VMAF nếu có).

### 4.4 SSIM (0–1, càng gần 1 càng giống)

**Dán-chạy:**
```bash
ffmpeg -i rendition0.mp4 -i videos/IjTyvFk.mp4 -lavfi "[0:v]scale=1920:1080:flags=bicubic[dist];[dist][1:v]ssim=stats_file=ssim.log" -f null -
```
- `ssim=stats_file=ssim.log` — đo cấu trúc ảnh (sát mắt hơn PSNR, nhẹ hơn VMAF).

> **Khi nào dùng cái nào:** VMAF = chuẩn vàng sát mắt người (ưu tiên) → SSIM (nhẹ, sát mắt vừa)
> → PSNR (nhanh, thô). So 2 codec cùng bitrate (H.264 vs HEVC §15) thì đọc **chênh VMAF** là rõ nhất.

---

## 5. Checklist nghiệm thu nhanh (sau mỗi lần encode)

1. `ffprobe -hide_banner init.mpd` → đủ số rendition, đúng res, không trùng mức.
2. `findstr codecs= init.mpd` → `avc1.xxxx` đầy đủ (web OK), **không** phải `hev1` cụt.
3. Keyframe align (§1.4) → mốc IDR rơi đúng biên segment.
4. **Mở bằng dash.js thật** (không chỉ VLC) → xác nhận web phát + switch quality được.
5. (Nếu so codec/bitrate) VMAF §4.2 giữa các bản, đọc chênh điểm.

---

## Changelog
- **2026-06-20** — Viết lại toàn bộ từ file lệnh thô thành tài liệu verify/so sánh có giải
  thích từng dòng + bản dán-chạy. Sửa lệnh VMAF sai trong bản gốc (`scale=1` không hợp lệ →
  thay bằng upscale `scale=WxH:flags=bicubic` đúng res gốc). Bổ sung: ma trận hỗ trợ
  player/tool (§0), kiểm codec string + keyframe align (§1), tách rendition trước khi đo
  VMAF (§4.1), thứ tự input `[distorted][reference]` (§4), checklist nghiệm thu (§5).
  Đối chiếu nguồn: ffmpeg-filters, Netflix/vmaf ffmpeg.md, mpv manual, VLC adaptive docs.

---

## Phụ lục A — Nội dung lệnh GỐC (giữ nguyên để reference)

> [SUPERSEDED 2026-06-20] Đây là các lệnh thô ban đầu của file, **giữ lại nguyên trạng**. Một
> số lệnh VMAF bên dưới có lỗi (`scale=1`) — bản đúng đã đưa lên §4. Không xoá để đối chiếu lịch sử.

```text
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:480[a];[vid4]scale=-2:480[b];[a][b]hstack[vo]"
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:720[a];[vid4]scale=-2:720[b];[a][b]hstack[vo]"
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid3]scale=-2:1080[a];[vid4]scale=-2:1080[b];[a][b]hstack[vo]"

mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:480[a];[vid4]scale=-2:480[b];[a][b]vstack[vo]"
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid1]scale=-2:720[a];[vid4]scale=-2:720[b];[a][b]vstack[vo]"
mpv init.mpd --external-file=init.mp4 --lavfi-complex="[vid3]scale=-2:1080[a];[vid4]scale=-2:1080[b];[a][b]vstack[vo]"

ffmpeg -i init.mpd -i init.mp4 -lavfi "[0:v]scale=1[enc];[enc][1:v]libvmaf" -f null -
ffmpeg -i init.mpd -i init.mp4 -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]psnr=stats_file=psnr.log" -f null -
ffmpeg -i init.mpd -i init.mp4 -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]libvmaf=feature=name=psnr|name=float_ssim|name=ciede:log_path=vmaf.json:log_fmt=json" -f null -

# Trong các mức ≤480p, chọn mức cao nhất = đúng 480p
vlc --adaptive-logic=highest --adaptive-maxheight=480 master.mpd

# Trích 1 frame 480p để soi pixel-true, không upscale
ffmpeg -i 480p/index.mpd -vf "select=eq(n\,500)" -vframes 1 frame_480.png

ffprobe -hide_banner init.mpd
# hoặc xem trong mpv: mở rồi bấm phím để liệt kê, hoặc:
mpv --msg-level=all=v init.mpd 2>&1 | findstr "Video"

mpv --vid=2 init.mpd      # số 2 = ví dụ, thay bằng index track 480p thực tế
```
