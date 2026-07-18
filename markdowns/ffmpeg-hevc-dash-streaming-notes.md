# Tài liệu này tổng hợp kiến thức từ quá trình xây dựng pipeline transcode video sang MPEG-DASH với FFmpeg + NVIDIA NVENC.  
## Tham khảo chính thống: [FFmpeg Documentation](https://ffmpeg.org/ffmpeg.html) | [FFmpeg DASH Muxer](https://ffmpeg.org/ffmpeg-formats.html#dash-2) | [NVENC Guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/nvenc-video-encoder-api-prog-guide/)

---

## 1. Kiến Trúc Pipeline 2 Lệnh (Recommended)

### Tại sao dùng 2 lệnh nối pipe thay vì 1 lệnh?

Khi kết hợp transcode + DASH packaging vào 1 lệnh duy nhất, FFmpeg DASH muxer có thể **không nhận đủ stream** (chỉ nhận audio, mất video streams). Nguyên nhân là FFmpeg xử lý stream mapping theo thứ tự khác nhau giữa muxer trực tiếp và muxer nhận từ pipe.

Dùng 2 lệnh qua MPEG-TS pipe là workaround ổn định nhất:

```
[FFmpeg transcode] --> (MPEG-TS pipe) --> [FFmpeg DASH packager]
```

**Lý do MPEG-TS làm transport format:**
- MPEG-TS là container streaming-friendly, không cần seekable output
- Hỗ trợ nhiều streams (multi-program) trong 1 luồng dữ liệu
- FFmpeg DASH muxer đọc từ MPEG-TS pipe ổn định hơn raw pipe

---

## 2. Lệnh Transcode Tối Ưu

```bat
ffmpeg -hwaccel cuda -i %filename% ^
 -c:v hevc_nvenc ^
 -c:a aac -b:a 128k ^
 -bf 1 -b_strategy 0 -sc_threshold 0 -pix_fmt yuv420p -preset p4 -rc vbr ^
 -g 120 -keyint_min 120 -force_key_frames "expr:gte(t,n_forced*4)" ^
 -map 0:v:0 -map 0:a:0 ^
 -map 0:v:0 ^
 -map 0:v:0 ^
 -map 0:v:0 ^
 -b:v:0 300k  -maxrate:v:0 450k  -s:v:0 720x480   -profile:v:0 1 ^
 -b:v:1 700k  -maxrate:v:1 1050k -s:v:1 1080x720  -profile:v:1 1 ^
 -b:v:2 1300k -maxrate:v:2 1950k -s:v:2 1920x1080 -profile:v:2 2 ^
 -b:v:3 2500k -maxrate:v:3 3750k                  -profile:v:3 2 ^
 -f mpegts - | ^
ffmpeg -f mpegts -i - ^
 -map 0 ^
 -use_timeline 1 -use_template 1 ^
 -adaptation_sets "id=0,streams=v id=1,streams=a" ^
 -seg_duration 4 ^
 -f dash "%basename%/init.mpd"
```

---

## 3. Giải Thích Từng Tham Số Quan Trọng

### 3.1 Hardware Acceleration

| Tham số | Ý nghĩa |
|---|---|
| `-hwaccel cuda` | Dùng GPU NVIDIA để decode input, giảm tải CPU |
| `-c:v hevc_nvenc` | Encode bằng NVENC (hardware encoder trên GPU NVIDIA) |

> Tham khảo: https://trac.ffmpeg.org/wiki/HWAccelIntro

---

### 3.2 Stream Mapping — Cách đúng để duplicate streams

```
-map 0:v:0 -map 0:a:0   ← stream 0: video rendition 0 + audio
-map 0:v:0              ← stream 1: video rendition 1 (no audio)
-map 0:v:0              ← stream 2: video rendition 2
-map 0:v:0              ← stream 3: video rendition 3
```

Cách này **dễ đọc và bảo trì hơn** `filter_complex split` vì:
- Không cần viết filter graph phức tạp
- Thêm/bớt rendition chỉ cần thêm/bớt dòng `-map`
- FFmpeg tự handle việc đọc lại input stream

> Tham khảo: https://trac.ffmpeg.org/wiki/Map

---

### 3.3 Encoding Settings

| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| `-rc vbr` | vbr | Variable Bitrate — chất lượng tốt hơn CBR cho streaming |
| `-preset p4` | p4 | Cân bằng tốc độ/chất lượng (p1=nhanh nhất, p7=chậm nhất) |
| `-bf 1` | 1 | Số B-frames tối đa. Giữ ở 1 để tương thích rộng |
| `-b_strategy 0` | 0 | Tắt adaptive B-frame strategy — đảm bảo keyframe nhất quán |
| `-sc_threshold 0` | 0 | Tắt scene change detection tự động — tránh keyframe lạc |
| `-pix_fmt yuv420p` | yuv420p | Pixel format tương thích rộng nhất |

---

### 3.4 Bitrate & Resolution Ladder

| Rendition | Resolution | Target Bitrate | Max Bitrate | Profile (giá trị dùng) |
|---|---|---|---|---|
| 0 (SD) | 720×480 | 300k | 450k | main (0) |
| 1 (HD) | 1080×720 | 700k | 1050k | main (0) |
| 2 (FHD) | 1920×1080 | 1300k | 1950k | main (0) |
| 3 (Source) | Original | 2500k | 3750k | main (0) |

**⚠️ ĐÍNH CHÍNH QUAN TRỌNG — giá trị `-profile:v` của `hevc_nvenc`:**

Khác với H.264 (baseline/main/high), `hevc_nvenc` dùng số nguyên với ý nghĩa:

> [SUPERSEDED 2026-06-20] Bảng cũ dưới đây ghi `3 = main still picture`, `4 = high throughput`
> — **SAI** so với option enum thực của FFmpeg. Giữ lại để đối chiếu lịch sử; bản đúng ở ngay dưới.
>
> | Giá trị | Profile | Bit depth |
> |---|---|---|
> | `0` | **main** | 8-bit |
> | `1` | **main10** | 10-bit |
> | `2` | **rext** (range extended) | >10-bit / 4:2:2, 4:4:4 |
> | `3` | ~~main still picture~~ | |
> | `4` | ~~high throughput~~ | |

> [UPDATED 2026-06-20] Đã đối chiếu **trực tiếp source FFmpeg**. Enum `-profile` của `hevc_nvenc`
> tự đánh số từ 0, **chỉ có 3–4 giá trị**, KHÔNG có "main still picture / high throughput"
> (hai cái đó là profile của *chuẩn HEVC ITU-T H.265*, không phải option mà encoder nhận):

| Giá trị | Profile (`hevc_nvenc`) | Bit depth / chroma | Web (dash.js) |
|---|---|---|---|
| `0` | **main** | 8-bit 4:2:0 | ❌ (HEVC không phát native, xem §13) |
| `1` | **main10** | 10-bit 4:2:0 | ❌ |
| `2` | **rext** (range extended) | >10-bit / 4:2:2 / 4:4:4 | ❌ |
| `3` | **multiview_main** | 8-bit (chỉ build có `NVENC_HAVE_MVHEVC`) | ❌ |

➡️ Với input 8-bit + `-pix_fmt yuv420p` → dùng `-profile:v:N 0` (main) cho **mọi** rendition.
Lệnh cũ đặt `-profile:v:0 1`/`-profile:v:2 2` thực chất ép **main10 (10-bit)** và **rext** — mâu thuẫn cấu hình.

Nguồn xác minh (2026-06-20): enum `NV_ENC_HEVC_PROFILE_MAIN/MAIN_10/REXT[/MULTIVIEW_MAIN]` tự
đánh số từ 0 trong [libavcodec/nvenc.h](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc.h),
bảng AVOption `-profile` trong [libavcodec/nvenc_hevc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc_hevc.c).
(Cũ: [forum VideoHelp](https://forum.videohelp.com/threads/396188), [GitHub ffmpeg-commander #35](https://github.com/alfg/ffmpeg-commander/issues/35).)

➡️ **Hệ quả:** lệnh đang dùng `-profile:v:0 1` và `-profile:v:2 2` thực chất đang ép **main10 (10-bit)** và **rext**, KHÔNG phải "main/main10" như ý định. Với input 8-bit + `-pix_fmt yuv420p` thì nên dùng `-profile:v:N 0` (main) cho tất cả rendition. Đây là một mâu thuẫn cấu hình tiềm ẩn.

**Công thức maxrate:** `maxrate = target_bitrate × 1.5`  
Đây là quy tắc thực tế để VBR có headroom xử lý các scene phức tạp mà không vượt quá bandwidth quá nhiều.

---

### 3.5 Keyframe Settings — Quan trọng cho Adaptive Streaming

```
-g 120 -keyint_min 120 -force_key_frames "expr:gte(t,n_forced*4)"
```

| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| `-g 120` | 120 frames | GOP size — khoảng cách tối đa giữa 2 keyframe |
| `-keyint_min 120` | 120 frames | Khoảng cách tối thiểu giữa 2 keyframe |
| `-force_key_frames` | expr:gte(t,n_forced*4) | Force keyframe mỗi 4 giây |
| `-sc_threshold 0` | 0 | Tắt scene-change keyframe để keyframe hoàn toàn do `-force_key_frames` kiểm soát |

**Tại sao keyframe phải ở lệnh transcode, không phải lệnh DASH?**

DASH packager chỉ **cắt** video theo segment, không re-encode. Nếu video không có keyframe đúng vị trí, DASH sẽ cắt sai chỗ → segment đầu không phải keyframe → player không thể switch rendition tại điểm đó.

**Quy tắc căn chỉnh keyframe với segment:**
- `seg_duration = 4s` → `force_key_frames mỗi 4s` (hoặc bội số nhỏ hơn như 2s)
- `g = fps × seg_duration` (ví dụ: 30fps × 4s = 120)
- `keyint_min = g` để tránh keyframe dày hơn dự định

> Tham khảo: https://ffmpeg.org/ffmpeg-codecs.html#toc-Codec-Options  
> DASH best practices: https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf

---

## 4. DASH Packaging Settings

```bat
ffmpeg -f mpegts -i - ^
 -map 0 ^
 -use_timeline 1 -use_template 1 ^
 -adaptation_sets "id=0,streams=v id=1,streams=a" ^
 -seg_duration 4 ^
 -f dash "%basename%/init.mpd"
```

| Tham số | Giá trị | Ý nghĩa |
|---|---|---|
| `-map 0` | Tất cả streams | Lấy toàn bộ streams từ input |
| `-use_timeline 1` | 1 | Dùng SegmentTimeline trong MPD — tương thích rộng hơn |
| `-use_template 1` | 1 | Dùng SegmentTemplate — giảm kích thước MPD |
| `-adaptation_sets` | id=0,streams=v id=1,streams=a | Nhóm video streams và audio streams riêng biệt |
| `-seg_duration 4` | 4 giây | Độ dài mỗi segment — 4s là chuẩn phổ biến cho VOD |

**Tại sao `adaptation_sets` phải tách video và audio?**

DASH player (dash.js) cần biết stream nào là video, stream nào là audio để:
1. Chọn đúng video rendition theo bandwidth
2. Giữ audio liên tục khi switch video quality

> Tham khảo: https://ffmpeg.org/ffmpeg-formats.html#dash-2  
> dash.js: https://github.com/Dash-Industry-Forum/dash.js

---

## 5. Output Structure

```
%basename%/
├── init.mpd              ← Manifest file (dash.js đọc file này đầu tiên)
├── init-stream0.m4s      ← Initialization segment cho stream 0
├── init-stream1.m4s
├── ...
├── chunk-stream0-00001.m4s   ← Media segments
├── chunk-stream0-00002.m4s
├── chunk-stream1-00001.m4s
└── ...
```

---

## 6. So Sánh filter_complex vs Stream Mapping

| Tiêu chí | `filter_complex split` | `-map 0:v:0` (nhiều lần) |
|---|---|---|
| Độ dễ đọc | Thấp — phải parse filter graph | Cao — rõ ràng từng stream |
| Dễ chỉnh sửa | Thấp — phải sửa trong chuỗi filter | Cao — thêm/bớt dòng map |
| Hiệu năng | Tương đương | Tương đương |
| Khuyến nghị | Chỉ dùng khi cần filter phức tạp | ✅ Preferred cho multi-bitrate |

---

## 7. Troubleshooting

### Chỉ có audio stream, không có video stream trong DASH
- **Nguyên nhân:** Kết hợp transcode + DASH packaging vào 1 lệnh duy nhất
- **Giải pháp:** Tách thành 2 lệnh qua MPEG-TS pipe như pipeline trên

### Player không switch được quality
- **Nguyên nhân:** Keyframe không đồng bộ giữa các rendition, hoặc không có keyframe ở đầu segment
- **Giải pháp:** Thêm `-g`, `-keyint_min`, `-force_key_frames`, `-sc_threshold 0` vào lệnh transcode

### Encode chậm dù có GPU
- **Nguyên nhân:** `-hwaccel cuda` chỉ decode bằng GPU, nhưng scale filter vẫn chạy trên CPU
- **Giải pháp:** Dùng `scale_cuda` hoặc `scale_npp` filter nếu cần tối ưu thêm

---

## 8. Tài Liệu Tham Khảo

- FFmpeg Official Docs: https://ffmpeg.org/ffmpeg.html
- FFmpeg DASH Muxer: https://ffmpeg.org/ffmpeg-formats.html#dash-2
- FFmpeg HW Accel: https://trac.ffmpeg.org/wiki/HWAccelIntro
- NVENC Programming Guide: https://docs.nvidia.com/video-technologies/video-codec-sdk/nvenc-video-encoder-api-prog-guide/
- DASH-IF Interoperability Points: https://dashif.org/docs/DASH-IF-IOP-v4.3.pdf
- dash.js GitHub: https://github.com/Dash-Industry-Forum/dash.js
- FFmpeg Multi-Bitrate Streaming Wiki: https://trac.ffmpeg.org/wiki/EncodingForStreamingSites
---

## 9. Phân tích lệnh production thực tế (case study)

Lệnh đang chạy trong dự án, các điểm cần lưu ý:

### 9.1 Option thừa / không có tác dụng với NVENC
| Option | Vấn đề |
|---|---|
| `-preset 4` rồi `-preset p4` | Khai báo trùng; `p4` (sau) thắng. Bỏ `-preset 4`. |
| `-b_strategy 0` | Là option của **libx264**, NVENC bỏ qua. Tương đương NVENC: `-strict_gop 1`. |
| `-sc_threshold 0` | Là option của **libx264**, NVENC bỏ qua. Tương đương NVENC: `-no-scenecut 1`. |

### 9.2 Vì sao xuất ra 4 res, có 2 cái 1080?
- Lệnh map `-map 0:v:0` **4 lần** → tạo 4 video rendition (index 0–3), không phải 3.
- Rendition 3 (`-b:v:3 2500k -profile:v:3 2`) **không có `-s:v:3`** → giữ **resolution gốc**. Nếu input là 1080p thì rendition 3 cũng là 1920×1080 → trùng res với rendition 2 (chỉ khác bitrate). Đây là "source/passthrough tier" có chủ đích, nhưng vô nghĩa về độ phân giải khi input ≤ 1080p.
- Muốn đúng 3 mức: bỏ 1 dòng `-map 0:v:0` và block `-b:v:3 ...`.

### 9.3 Lệch keyframe vs segment
- `-force_key_frames "expr:gte(t,n_forced*3)"` → keyframe mỗi **3s**, nhưng `-seg_duration 10` → segment **10s**. 10 không chia hết cho 3 đều → segment boundary không phải lúc nào cũng rơi đúng keyframe.
- Khắc phục: cho `seg_duration` = bội số của khoảng keyframe (vd keyframe 2s + seg 10s, hoặc cả hai = 4s).

---

## 10. 1 lệnh vs pipe 2 lệnh — NGUYÊN NHÂN THẬT (đã xác minh bằng MPD)

**⚠️ ĐÍNH CHÍNH nhận định cũ:** giả thuyết ban đầu "phải dùng pipe MPEG-TS mới ra nhiều res, còn 1 lệnh thì mất video" là **SAI**. Đã chứng minh bằng cách quét các file `init.mpd` thật sinh ra từ 2 cách.

### 10.1 Bằng chứng từ MPD
| | Lệnh pipe (cũ) | Lệnh 1-process filter_complex (HEVC) |
|---|---|---|
| `codecs=` trong MPD | `avc1.64001e/1f/28` = **H.264** | `hev1` = **HEVC** |
| dash.js | Phát được đa res | Chỉ audio (không hình) |
| Số video Representation | 4 (vẫn có 2 cái 1080p trùng) | 3 |

→ Cả hai cách **đều tạo được nhiều video Representation**. Pipe KHÔNG "sắp xếp lại stream cho đẹp" — bằng chứng là bản pipe vẫn dính lỗi 2 stream 1080p trùng (id=3, id=4 cùng 1920×1080).

### 10.2 Nguyên nhân thật: stage 2 RE-ENCODE sang H.264
Lệnh pipe có **2 process**, nhưng **chỉ stage 1 có `-c:v hevc_nvenc`**. Stage 2 (cái thực sự tạo DASH) **KHÔNG có `-c:v`**:
```
... -f mpegts -  |  ffmpeg -i -  -map 0 ... -f dash ...
                              ↑ stage 2: KHÔNG chỉ định codec
```
- Muxer DASH khi thiếu `-c:v` → **mặc định re-encode bằng `libx264` (H.264)**.
  - ✅ [VERIFIED 2026-06-20] Đối chiếu source: `ff_dash_muxer` khai báo `.p.video_codec =
    AV_CODEC_ID_H264`, `.p.audio_codec = AV_CODEC_ID_AAC` → đây chính là codec mặc định khi
    không chỉ định `-c:v`/`-c:a`. Nguồn: [libavformat/dashenc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/dashenc.c).
- Vì vậy HEVC từ stage 1 bị **decode lại + encode lại thành H.264** ở stage 2 → output ra `avc1`.
- MPEG-TS KHÔNG tự đổi codec (nó chứa HEVC bình thường). Việc chuyển H.264 là do **DASH muxer default codec**, không phải do `mpegts`.

### 10.3 Hệ quả: "H.264 trá hình" + double-encode
- Lệnh pipe cũ thực chất là một lệnh **H.264** — HEVC encode ở stage 1 bị vứt đi.
- Nó phát được trên dash.js **vì là H.264**, không phải vì pipe.
- Tệ hơn: nó encode **2 lần** (HEVC GPU vô ích ở stage 1 + H.264 libx264 CPU ở stage 2) → tốn CPU gấp đôi → **góp phần memory spike/giật lag** ở mục 11.

### 10.4 Phép thử khẳng định
Thêm `-c:v copy` vào stage 2 của lệnh pipe → output sẽ ra `hev1` (giữ HEVC) và dash.js lại audio-only. Điều này chứng minh stage 2 đang re-encode chứ không copy.

### 10.5 Kết luận
- dash.js **không phát được hình HEVC** trong điều kiện thường (cần Chrome 105+ hardware decoder + codec string đầy đủ; bản `hev1` cụt còn bị từ chối kể cả khi có decoder — xem mục 13).
- Lệnh pipe cũ = H.264 trá hình + double-encode → **bỏ hẳn pipe**.
- **Stick với bản H.264 1 lệnh (mục 15.1):** encode H.264 một lần trên GPU, ra `avc1` đầy đủ, dash.js phát được mọi trình duyệt, không phí CPU.
- HEVC chỉ quay lại sau dưới dạng dual-codec (HEVC + H.264 fallback) hoặc plugin WASM — việc về sau.

> Nguồn: phân tích trực tiếp file `init.mpd` (codec string `avc1` vs `hev1`); [FFmpeg DASH muxer](https://ffmpeg.org/ffmpeg-formats.html#dash-2); [FFmpeg Wiki – Creating multiple outputs](https://trac.ffmpeg.org/wiki/Creating%20multiple%20outputs)

---

## 11. Memory spike / giật lag khi encode nhiều video — chẩn đoán & sửa

**Xếp theo mức nghiêm trọng:**

| # | Nguyên nhân | Cơ chế |
|---|---|---|
| ① (lớn nhất) | **Không có `-hwaccel cuda`** | Decode bằng CPU + 4 nhánh scale CPU song song. Raw frame YUV420 1080p (~3MB/frame) × 4 nhánh × buffer filtergraph → RAM phình. Nhân nhiều video = memory spike + CPU saturation. |
| ② | Pipe + `seg_duration 10` | DASH muxer gom segment trong RAM trước khi flush; segment dài × 4 rendition → buffer lớn. |
| ③ | NVENC session cap | GPU GeForce giới hạn số encode session đồng thời (tùy driver). Nhiều video × nhiều rendition → vượt cap. Xác minh: `nvidia-smi`, NVENC SDK matrix. |
| ④ | Concurrency tầng app (`p-queue`) | Không giới hạn job → nhiều process FFmpeg đè nhau. |

**Đề xuất sửa (ưu tiên cao → thấp):**
1. **Full GPU pipeline** — `-hwaccel cuda -hwaccel_output_format cuda` + `scale_cuda`/`scale_npp` cho mọi nhánh scale → raw frame không rời VRAM, RAM gần như không phình. *(Mẫu lệnh cần TEST trước khi production.)*
2. Thêm `-maxrate`/`-bufsize` để chặn VBR vọt, giảm buffer.
3. Giới hạn `p-queue` concurrency (1–2 job/GPU), đo bằng `nvidia-smi dmon`.
4. Giảm `seg_duration` xuống 4s (khớp keyframe luôn).
5. Đánh giá lại `-threads` sau khi chuyển GPU pipeline.

> Tham khảo: [FFmpeg HWAccelIntro](https://trac.ffmpeg.org/wiki/HWAccelIntro) (scale_cuda / scale_npp), [NVENC Guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/nvenc-video-encoder-api-prog-guide/)

> TODO chưa kiểm chứng trên hệ thống dự án: (a) mẫu lệnh full-GPU filter_complex; (b) NVENC session cap thực tế của GPU đang dùng; (c) nguyên nhân chính xác của lỗi 1-lệnh.
---

## 12. Đặt nhãn quality khi select (DASH)

- DASH **không** cho gán "tên tùy ý hiển thị trên menu" qua FFmpeg. Player (dash.js/ArtPlayer) sinh nhãn quality từ `width`/`height`/`bandwidth` trong MPD (vd "1080p").
- FFmpeg DASH chỉ phản ánh `id` + `bandwidth` của Representation thành metadata `id`/`variant_bitrate` (nguồn: [ffmpeg-formats DASH](https://ffmpeg.org/ffmpeg-formats.html#dash-2)).
- Có thể gán `role` cho AdaptationSet (main/alternate) nhưng đó là ngữ nghĩa, không phải nhãn quality.
- ➡️ Muốn nhãn tùy ý ("Auto", "Full HD", "Tiết kiệm dữ liệu") → làm ở **tầng player**. ArtPlayer hỗ trợ custom quality config qua JS.
- > TODO chưa kiểm chứng: API ArtPlayer cụ thể để override nhãn quality từ dash.js levels.

---

## 13. HEVC vs H.264 — so sánh & khi nào chuyển

| Tiêu chí | HEVC (hevc_nvenc) | H.264 |
|---|---|---|
| Hiệu quả nén | Tốt hơn ~30-50% | Baseline |
| Browser support | Phân mảnh (Safari 11+, Chrome 107+, Firefox 134+); cần GPU hw decoder | Gần 100% mọi nơi |
| **dash.js / hls.js** | ⚠️ **KHÔNG hỗ trợ** (chỉ mpegts.js, hoặc plugin WASM) | Hỗ trợ đầy đủ |
| Decode software | Tốn 40-60% CPU nhiều hơn H.264 | Nhẹ hơn |
| Encode resource | Cần GPU NVENC HEVC, hoặc libx265 (rất nặng) | libx264 chạy mọi CPU |
| Dung lượng | Nhỏ hơn đáng kể | Lớn hơn |

Nguồn: [testmuai HEVC browser support](https://www.testmuai.com/learning-hub/hevc-compatible-browsers/), [SRS HEVC doc](https://ossrs.net/lts/en-us/docs/v6/doc/hevc), [antmedia H265 guide](https://antmedia.io/h265-hevc-codec-explained/).

**⚠️ Quyết định cho dự án này:** player stack = **ArtPlayer + dash.js**. dash.js KHÔNG decode HEVC native qua MSE → **HEVC + dash.js không chạy trên web** trừ khi thêm WASM transcode plugin. → H.264 là lựa chọn đúng cho stack web hiện tại.

### Chuyển HEVC → H.264, sửa các điểm:
- `-c:v hevc_nvenc` → `-c:v h264_nvenc` (hoặc `libx264` nếu không GPU)
- `-profile:v:N`: đổi giá trị số HEVC (0/1/2) → tên H.264: `baseline`/`main`/`high`
- `-b_strategy`, `-sc_threshold`: chỉ có tác dụng với **libx264** (h264_nvenc vẫn bỏ qua)
- `-pix_fmt yuv420p`: giữ nguyên (8-bit)
- Bitrate ladder: tăng ~30-50% để đạt cùng chất lượng (vd 300k→450k, 700k→1000k, 1300k→1900k)

### 13.1 ⚠️ Rào thứ HAI khi đóng gói HEVC cho DASH: codec string `hev1` cụt
Ngay cả khi trình duyệt có hardware HEVC decoder, vẫn có thể audio-only vì codec string trong MPD sai:
- FFmpeg DASH muxer thường ghi `codecs="hev1"` **cụt — thiếu profile/tier/level** (so với H.264 ghi đầy đủ `avc1.640028`).
- MSE **bắt buộc** codec string đầy đủ (vd `hvc1.1.6.L93.B0`) để `isTypeSupported()` quyết định → string cụt `hev1` → bị từ chối **dù máy có decoder**.
- Nhiều player chỉ chấp nhận tag `hvc1`, không nhận `hev1`. FFmpeg cũng khuyến nghị dùng `hvc1`.
- Nếu bắt buộc đi hướng HEVC: thêm `-tag:v hvc1` và đảm bảo MPD có codec string đầy đủ. Nhưng vẫn phụ thuộc Chrome 105+ + hardware decoder → nhiều rào, không khuyến nghị giai đoạn này.
- Cách kiểm nhanh: `grep codecs= init.mpd` — `avc1.xxxxx` (đầy đủ) = OK cho dash.js; `hev1` (cụt) = sẽ audio-only.
- Nguồn: [hls.js #6086 hev1 vs hvc1](https://github.com/video-dev/hls.js/issues/6086), [W3C MSE hvc1 unsupported](https://lists.w3.org/Archives/Public/public-html-media/2015Feb/0035.html)

---

## 14. Encode trên node heterogeneous — chiến lược codec

(Liên quan kiến trúc: xem `central-node-architecture-comparison.md`)

- Node không đồng nhất (có/không GPU, CPU yếu): **H.264 là mẫu số chung** — `libx264` chạy mọi CPU; libx265 quá nặng cho node yếu.
- Mỗi node encode bằng command khác nhau (GPU node → `h264_nvenc`, CPU node → `libx264`) **OK** miễn output chuẩn hóa giống nhau: cùng codec đích, segment duration, keyframe alignment, bitrate ladder. Player không phân biệt node nào encode.
- **Phải giữ cố định giữa các node:** container, codec profile, GOP/keyframe, segment boundaries.
- Player hỗ trợ HEVC (native app / Safari) → HEVC tiết kiệm băng thông. Player web (dash.js) → bắt buộc H.264.
- Dual-codec (H.265 cho client tương thích + H.264 fallback) là pattern ngành nhưng gấp đôi chi phí encode + storage → chỉ thêm sau, không thay H.264.

---

## 15. Lệnh hoàn chỉnh H.264 & H.265 — 1 lệnh, 3 luồng, để so sánh chất lượng

> [SUPERSEDED 2026-07-11 cho input tổng quát] Hai lệnh §15.1/§15.2 giữ lại để
> đối chiếu lịch sử, nhưng ladder `720x480` + `1280x720` + "giữ res gốc" không
> bảo đảm các Representation có cùng `(width × SAR) / height`. Với video không
> đúng tỷ lệ, DASH muxer có thể dừng bằng lỗi `Conflicting stream aspect ratios`.
> Pipeline chuẩn hóa aspect ratio hiện hành nằm ở §16.

Cả hai bản dùng **CPU scale** (cấu hình ổn định nhất sau lỗi `scale_cuda` ↔ `auto_scale` khi trộn nhánh cuda với nhánh không-scale). Output 2 thư mục riêng để so 2 manifest cạnh nhau.

### 15.1 H.264 (đã sửa "vỡ": bật AQ + lookahead + multipass + B-ref)

```bash
ffmpeg -i videos/IjTyvFk.mp4 \                         # input nguồn (decode CPU — tránh lỗi trộn format cuda)
  -filter_complex "\
    [0:v]split=3[v0][v1][v2]; \                        # tách 3 nhánh có label rõ ràng (tránh mất stream khi 1 lệnh)
    [v0]scale=720:480[s0]; \                            # nhánh 0 → 480p (scale CPU)
    [v1]scale=1280:720[s1]" \                           # nhánh 1 → 720p; v2 KHÔNG scale → giữ res gốc (cùng format CPU nên không lỗi)
  -map "[s0]" -map "[s1]" -map "[v2]" -map 0:a:0 \     # 3 video (480p, 720p, gốc) + 1 audio
  -c:v h264_nvenc \                                     # video codec: H.264 hardware (dash.js phát được)
  -c:a aac -b:a 128k \                                  # audio AAC 128k
  -preset p6 -tune hq \                                 # preset cân bằng chất lượng (p6 gần p7 nhưng nhẹ hơn); tune hq cho VOD
  -rc vbr \                                             # rate control: variable bitrate
  -rc-lookahead 32 \                                    # phân tích 32 frame tới → phân bổ bit tốt hơn, giảm vỡ
  -multipass qres \                                     # 2-pass quarter-res → rate control chính xác hơn ở scene phức tạp
  -spatial-aq 1 -temporal-aq 1 -aq-strength 8 \         # AQ: dồn bit vào vùng chi tiết/tĩnh → giảm blocking (chống vỡ chính)
  -bf 3 -b_ref_mode middle \                            # 3 B-frame + dùng B làm reference → chất lượng tốt hơn
  -pix_fmt yuv420p \                                    # 8-bit 4:2:0, tương thích rộng nhất
  -g 120 -keyint_min 120 \                              # GOP cố định 120 frame (= 4s @30fps)
  -force_key_frames "expr:gte(t,n_forced*2)" \          # ép keyframe mỗi 2s → khớp seg_duration 4s
  -b:v:0 450k  -maxrate:v:0 675k  -bufsize:v:0 900k  -profile:v:0 high \   # rendition 0: 480p ~450k (profile high → bật CABAC)
  -b:v:1 1000k -maxrate:v:1 1500k -bufsize:v:1 2000k -profile:v:1 high \   # rendition 1: 720p ~1000k
  -b:v:2 1900k -maxrate:v:2 2850k -bufsize:v:2 3800k -profile:v:2 high \   # rendition 2: gốc ~1900k
  -use_timeline 1 -use_template 1 -single_file 0 \     # DASH: SegmentTimeline + Template, mỗi segment 1 file
  -seg_duration 4 \                                     # segment 4s (khớp keyframe 2s)
  -adaptation_sets "id=0,streams=v id=1,streams=a" \   # gom video 1 set, audio 1 set riêng
  -init_seg_name init_$RepresentationID$.m4s \          # tên init segment
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \   # tên media segment
  -f dash videos/XXXX_h264/init.mpd                     # xuất ra thư mục riêng cho H.264
```

### 15.2 H.265 / HEVC (cùng bitrate/res/AQ để so công bằng)

```bash
ffmpeg -i videos/IjTyvFk.mp4 \                         # input nguồn (decode CPU)
  -filter_complex "\
    [0:v]split=3[v0][v1][v2]; \                        # tách 3 nhánh có label rõ ràng
    [v0]scale=720:480[s0]; \                            # nhánh 0 → 480p (scale CPU)
    [v1]scale=1280:720[s1]" \                           # nhánh 1 → 720p; v2 giữ res gốc
  -map "[s0]" -map "[s1]" -map "[v2]" -map 0:a:0 \     # 3 video (480p, 720p, gốc) + 1 audio
  -c:v hevc_nvenc \                                     # video codec: HEVC hardware (so với h264_nvenc)
  -c:a aac -b:a 128k \                                  # audio AAC 128k (giữ nguyên để so công bằng)
  -preset p6 -tune hq \                                 # preset + tune giống bản H.264
  -tier high \                                          # HEVC tier high → headroom bitrate cao hơn (riêng HEVC, H.264 không có)
  -rc vbr \                                             # rate control VBR (giống H.264 để so cùng điều kiện)
  -rc-lookahead 32 \                                    # phân tích 32 frame tới
  -multipass qres \                                     # 2-pass quarter-res
  -spatial-aq 1 -temporal-aq 1 -aq-strength 8 \         # AQ giống H.264 (so công bằng)
  -bf 3 -b_ref_mode middle \                            # 3 B-frame + B-ref (nếu lỗi/giảm chất lượng trên HEVC → đổi -b_ref_mode 0)
  -pix_fmt yuv420p \                                    # 8-bit 4:2:0 (KHÔNG dùng main10 để so ngang H.264)
  -profile:v 0 \                                        # profile = main (HEVC dùng SỐ: 0=main, 1=main10, 2=rext)
  -g 120 -keyint_min 120 \                              # GOP cố định 120 frame, giống H.264
  -force_key_frames "expr:gte(t,n_forced*2)" \          # ép keyframe mỗi 2s → khớp seg_duration 4s
  -b:v:0 450k  -maxrate:v:0 675k  -bufsize:v:0 900k \   # rendition 0: 480p ~450k (GIỮ NGUYÊN bitrate như H.264)
  -b:v:1 1000k -maxrate:v:1 1500k -bufsize:v:1 2000k \  # rendition 1: 720p ~1000k
  -b:v:2 1900k -maxrate:v:2 2850k -bufsize:v:2 3800k \  # rendition 2: gốc ~1900k
  -use_timeline 1 -use_template 1 -single_file 0 \     # DASH: SegmentTimeline + Template
  -seg_duration 4 \                                     # segment 4s (khớp keyframe 2s)
  -adaptation_sets "id=0,streams=v id=1,streams=a" \   # gom video 1 set, audio 1 set riêng
  -init_seg_name init_$RepresentationID$.m4s \          # tên init segment
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \   # tên media segment
  -f dash videos/XXXX_hevc/init.mpd                     # xuất ra thư mục RIÊNG để không đè bản H.264
```

### 15.3 Khác biệt giữa 2 bản (tra nhanh khi so)
| Option | H.264 | HEVC |
|---|---|---|
| `-c:v` | `h264_nvenc` | `hevc_nvenc` |
| `-profile:v` | tên: `high` | **số: `0`** (=main; 1=main10, 2=rext) |
| `-tier` | không có | `high` |
| Output dir | `XXXX_h264` | `XXXX_hevc` |
| Bitrate / res / AQ / lookahead / bf / GOP / segment | **giữ y nguyên — điều kiện so công bằng** |

### 15.4 Option chống "vỡ" (giải thích)
- `-spatial-aq 1` + `-aq-strength 8`: dồn bit vào vùng nhiều chi tiết → giảm blocking vùng phẳng/gradient. (Nguồn: [AWS AQ controls](https://docs.aws.amazon.com/elemental-live/latest/ug/vq-quantization.html))
- `-temporal-aq 1`: điều chỉnh QP cho vùng tĩnh nhiều chi tiết để làm reference tốt hơn (AWS khuyến nghị gần như luôn bật).
- `-rc-lookahead 32`: phân tích frame tương lai → phân bổ bit tối ưu ở bitrate thấp.
- `-multipass qres`: 2-pass → rate control chính xác, giảm vỡ scene phức tạp.
- Nếu vẫn vỡ → gốc rễ là bitrate ladder thấp: tăng `-b:v` từng tier, hoặc dùng CQ (`-rc vbr -cq 21 -b:v 0 -maxrate ... -bufsize ...`).

### 15.5 Lưu ý verify trước production
- Cả hai dùng CPU scale (ổn định nhất). Muốn full-GPU chống memory spike: thêm `-hwaccel cuda -hwaccel_output_format cuda`, đổi `scale`→`scale_cuda`, và PHẢI cho `[v2]` qua `scale_cuda=iw:ih` (no-op) để đồng nhất format — nếu không sẽ lặp lỗi `auto_scale`/`Function not implemented`.
- `-temporal-aq`, `-b_ref_mode`, `-multipass` phụ thuộc đời GPU. Lỗi thì bỏ `-b_ref_mode middle` trước (HEVC hay lỗi nhất), rồi tới `-multipass`. Kiểm: `ffmpeg -h encoder=h264_nvenc` / `hevc_nvenc`.
- HEVC + dash.js KHÔNG phát được trên web → bản HEVC chỉ để so chất lượng offline (mpv/VMAF), chưa đưa lên player hiện tại được.
- Chưa test trên hệ thống dự án → chạy thử 1 file, `ffprobe init.mpd` kiểm đủ 3 Representation đúng res.
- Không GPU: đổi `h264_nvenc`→`libx264` (preset đổi sang tên `veryfast`/`medium`, `-b_strategy 0 -sc_threshold 0` lúc này mới có tác dụng); HEVC software dùng `libx265` nhưng rất nặng.

### 15.6 So sánh bằng mpv (trên-dưới hoặc cạnh nhau)
```bash
# Cạnh nhau (hstack) — scale cùng CHIỀU CAO
mpv videos/XXXX_hevc/init.mpd --external-file=videos/XXXX_h264/init.mpd \
  --lavfi-complex="[vid1]scale=-2:720[a];[vid4]scale=-2:720[b];[a][b]hstack[vo]"

# Trên-dưới (vstack) — scale cùng CHIỀU RỘNG
mpv videos/XXXX_hevc/init.mpd --external-file=videos/XXXX_h264/init.mpd \
  --lavfi-complex="[vid1]scale=1280:-2[a];[vid4]scale=1280:-2[b];[a][b]vstack[vo]"
```
- `[vidN]`: index stream trong file (xem log mpv để biết rendition nào là vid mấy); `[vid4]` thường là `--external-file`.
- Frame step: `.` (tiến) / `,` (lùi). Seek cùng mốc: console (`` ` ``) → `seek <giây> absolute exact`.

> **Verify & so sánh đầy đủ** (ffprobe kiểm stream, VMAF/PSNR/SSIM định lượng, mpv side-by-side
> giải thích từng dòng, copy-chạy ngay): xem [init_compare_output.md](init_compare_output.md).

> Nguồn: [NVENC API Guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.0/nvenc-video-encoder-api-prog-guide/index.html), [StreamFX NVENC reference](https://github.com/Vhonowslend/StreamFX-Public/wiki/Encoder-FFmpeg-NVENC), [hevc_nvenc options](https://forums.developer.nvidia.com/t/nvenc-ffmpeg-plugin-cbr-options/81654), [HEVC B-ref quality issue](https://forums.developer.nvidia.com/t/nvenc-quality-degradation-with-hevc-and-b-frames-reference-mode-middle/290304), [FFmpeg FilteringGuide](https://trac.ffmpeg.org/wiki/FilteringGuide)
---

## 16. [UPDATED 2026-07-11] Chuẩn hóa mọi aspect ratio cho DASH ABR

### 16.1 Case thực tế và nguyên nhân chính xác

Input quan sát được:

```json
{
  "width": 640,
  "height": 480,
  "pix_fmt": "yuv420p",
  "field_order": "progressive"
}
```

Nếu `sample_aspect_ratio` (SAR) là `1:1`, Display Aspect Ratio (DAR) của input là
`640 / 480 × 1 = 4:3`. Tuy nhiên, lệnh cũ ép ba nhánh CUDA thành:

| Representation | Kích thước | Tỷ lệ khung khi SAR=1 |
|---|---:|---:|
| 0 | 720×480 | 3:2 |
| 1 | 1080×720 | 3:2 |
| 2 | 1920×1080 | 16:9 |

Ba stream được gom vào cùng `id=0,streams=v`. Trong mã nguồn `dashenc.c`, FFmpeg
tính rational của mỗi stream theo công thức:

```text
PAR kiểm tra = (width × SAR.num) / (height × SAR.den)
```

Sau đó muxer dùng phép so rational chính xác; nếu giá trị đầu tiên đã được lưu và
stream kế tiếp khác nó, `dash_write_header()` trả `EINVAL (-22)`. Vì vậy các dòng
`Could not write header`, `Error sending frames to consumers` và `Nothing was
written` chỉ là **hậu quả dây chuyền**. Gốc lỗi không nằm ở NVENC, audio, segment
hay packet đầu tiên.

Thông báo `Adaptation Set 1` dù CLI khai báo `id=0` là do chỉ số nội bộ `as_idx`
của muxer được lưu theo kiểu 1-based; không có nghĩa audio set là thủ phạm.

Nguồn xác minh:

- [FFmpeg `dashenc.c` — phép tính và so sánh aspect ratio](https://ffmpeg.org/doxygen/trunk/dashenc_8c_source.html)
- [FFmpeg DASH muxer — `adaptation_sets`](https://ffmpeg.org/ffmpeg-formats.html#dash-2)
- [Case tương tự trên ffmpeg-user: nhiều kích thước làm PAR lệch do rounding](https://ffmpeg.org/pipermail/ffmpeg-user/2021-February/051701.html)

### 16.2 Vì sao `720×480` dễ gây hiểu nhầm

`720×480` đến từ raster SD/NTSC lịch sử, nơi pixel thường **không vuông** và SAR
metadata quyết định ảnh hiển thị 4:3 hay 16:9. Nó không phải canvas web 16:9 với
SAR 1:1. Tương tự, `1080×720` là 3:2; kích thước 720p square-pixel thông dụng là
`1280×720`.

Với DASH web hiện tại, cách ít mơ hồ nhất là chuẩn hóa tất cả Representation thành
pixel vuông (`SAR=1`) và dùng canvas có **cùng rational chính xác**, ví dụ:

```text
640×360   = 16:9
1280×720  = 16:9
1920×1080 = 16:9
```

Không thay `640×360` bằng `854×480` nếu vẫn gom chung với hai rung trên và dùng
`setsar=1`: `854/480 = 427/240`, chỉ **xấp xỉ** chứ không bằng `16/9`; DASH muxer
so sánh rational chính xác nên vẫn có thể từ chối.

### 16.3 Chính sách hình ảnh đã chọn: contain + pad

Pipeline cho mỗi nhánh:

```text
scale theo DAR thật, không méo
  → ép kích thước nội dung chia hết cho 2
  → pad vào canvas 16:9 cố định
  → SAR 1:1
```

Đây là chính sách **contain**: giữ toàn bộ nội dung, đổi lại có letterbox/pillarbox.
Không dùng stretch. Chính sách **cover + crop** chỉ phù hợp khi chấp nhận cắt mất
nội dung; không nên dùng làm mặc định VOD.

Với input 640×480, SAR 1:1:

| Canvas | Nội dung sau scale | Padding |
|---|---:|---:|
| 640×360 | 480×360 | trái 80 + phải 80 |
| 1280×720 | 960×720 | trái 160 + phải 160 |
| 1920×1080 | 1440×1080 | trái 240 + phải 240 |

Kết quả của cả ba nhánh là canvas 16:9, SAR 1:1. Player ABR có thể switch mà
không đổi hình học khung.

Các cách né lỗi nhưng **không nên dùng** thay cho normalize hình ảnh:

- Chỉ thêm `setdar=16/9`: filter thay SAR metadata để báo DAR mới, không tự tạo
  padding. Với nguồn 4:3, player sẽ kéo nội dung thành 16:9 nên người/vật bị bè.
- Chỉ thêm `setsar=1` sau ba `scale_cuda` cũ: hai nhánh đầu vẫn 3:2, nhánh cuối
  vẫn 16:9; lỗi rational không biến mất, đồng thời nội dung đã bị stretch.
- Bỏ `-adaptation_sets`: theo docs, DASH muxer mặc định tạo một AdaptationSet cho
  **mỗi stream**. Lệnh có thể ghi MPD nhưng ba rung không còn được mô tả như một
  nhóm lựa chọn ABR duy nhất.
- Đặt stream 3:2 và 16:9 vào các AdaptationSet riêng: chỉ né validation; player
  không có nghĩa vụ coi chúng là các quality có thể switch liền mạch.
- Crop mọi nguồn cho đầy 16:9: kỹ thuật hợp lệ nhưng làm mất nội dung; chỉ dùng
  khi product chọn chính sách `cover`, không phải fix mặc định cho VOD.

### 16.4 Lệnh khuyến nghị — CPU scale, NVENC encode

> **Đề xuất, chưa chạy trong session tài liệu này.** Cần kiểm tra FFmpeg đang cài
> có option `reset_sar` bằng `ffmpeg -h filter=scale`. Option này được thêm vào
> họ scale filter để xử lý đúng cả input anamorphic (`SAR != 1:1`).

Tên `input.mp4` và `output/` dưới đây là **placeholder theo vai trò**, rõ nghĩa hơn
`dummy.mp4` và không gắn tài liệu với một video ID thật. Wrapper phải thay chúng
bằng path thực và tạo `OUTPUT_DIR` trước khi gọi FFmpeg.

Command dùng Bash argument array để mỗi option nằm riêng một dòng và comment không
làm hỏng line-continuation. Khi triển khai bằng Node.js `spawn`, dùng chính các
phần tử trong `FFMPEG_ARGS` làm mảng args; không đưa comment vào process arguments.

```bash
INPUT_FILE="videos/input.mp4"                 # Placeholder: file nguồn cần encode
OUTPUT_DIR="videos/output"                    # Placeholder: thư mục asset đầu ra
OUTPUT_MPD="${OUTPUT_DIR}/init.mpd"           # Manifest DASH chính

FILTER_GRAPH='[0:v]split=3[v0][v1][v2];'      # Tách decoded video thành ba nhánh ABR
FILTER_GRAPH+='[v0]scale=w=640:h=360:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=w=640:h=360:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1[s0];'       # Nhánh 360p: contain + pad vào canvas 16:9
FILTER_GRAPH+='[v1]scale=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=w=1280:h=720:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1[s1];'    # Nhánh 720p: cùng hình học 16:9, SAR 1:1
FILTER_GRAPH+='[v2]scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,pad=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2:color=black,setsar=1[s2]'     # Nhánh 1080p: cùng hình học 16:9, SAR 1:1

FFMPEG_ARGS=(
  -i "$INPUT_FILE"                             # Chọn input media
  -filter_complex "$FILTER_GRAPH"              # Áp dụng split + scale + pad cho ba nhánh

  -map "[s0]"                                  # Output video stream 0: canvas 640x360
  -map "[s1]"                                  # Output video stream 1: canvas 1280x720
  -map "[s2]"                                  # Output video stream 2: canvas 1920x1080
  -map "0:a:0?"                                # Map audio đầu tiên nếu input có audio

  -c:v h264_nvenc                              # Encode mọi video stream bằng NVIDIA H.264
  -pix_fmt yuv420p                             # 8-bit 4:2:0, tương thích player web rộng
  -c:a aac                                     # Encode audio thành AAC
  -b:a 128k                                    # Audio bitrate mục tiêu 128 kbit/s

  -rc vbr                                      # NVENC variable bitrate
  -cq 21                                       # Mục tiêu chất lượng trong chế độ VBR
  -preset p6                                   # Preset ưu tiên chất lượng cho VOD
  -bf 3                                        # Cho phép tối đa ba B-frame
  -b_ref_mode middle                           # Cho B-frame giữa làm reference nếu GPU hỗ trợ
  -spatial-aq 1                                # Bật spatial adaptive quantization
  -aq-strength 8                               # Cường độ spatial AQ
  -temporal-aq 1                               # Bật temporal adaptive quantization
  -rc-lookahead 32                             # Phân tích trước 32 frame cho rate control
  -multipass qres                              # Multipass ở quarter resolution

  -g 120                                       # GOP tối đa 120 frame; cần tính lại theo FPS thật
  -keyint_min 120                              # Khoảng keyframe tối thiểu theo frame
  -force_key_frames "expr:gte(t,n_forced*2)"  # Ép keyframe theo thời gian mỗi hai giây

  -b:v:0 450k                                  # Bitrate mục tiêu rendition 360p
  -maxrate:v:0 675k                            # Peak bitrate rendition 360p
  -bufsize:v:0 900k                            # VBV buffer rendition 360p
  -profile:v:0 main                            # H.264 Main cho rendition 360p

  -b:v:1 1000k                                 # Bitrate mục tiêu rendition 720p
  -maxrate:v:1 1500k                           # Peak bitrate rendition 720p
  -bufsize:v:1 2000k                           # VBV buffer rendition 720p
  -profile:v:1 main                            # H.264 Main cho rendition 720p

  -b:v:2 1900k                                 # Bitrate mục tiêu rendition 1080p
  -maxrate:v:2 2850k                           # Peak bitrate rendition 1080p
  -bufsize:v:2 3800k                           # VBV buffer rendition 1080p
  -profile:v:2 high                            # H.264 High cho rendition 1080p

  -use_timeline 1                              # Ghi SegmentTimeline trong MPD
  -use_template 1                              # Dùng SegmentTemplate cho tên segment
  -single_file 0                               # Mỗi segment là một file riêng
  -seg_duration 4                              # Mục tiêu segment dài bốn giây
  -adaptation_sets "id=0,streams=v id=1,streams=a" # Gom video thành một ABR set, audio thành set riêng
  -init_seg_name 'init_$RepresentationID$.m4s' # Template tên initialization segment
  -media_seg_name 'chunk_$RepresentationID$_$Number%05d$.m4s' # Template tên media segment
  -f dash                                      # Chọn DASH muxer
  "$OUTPUT_MPD"                                # Path manifest đầu ra
)

ffmpeg "${FFMPEG_ARGS[@]}"                    # Thực thi FFmpeg với argument array trên
```

Ý nghĩa các option aspect-ratio:

| Option | Tác động |
|---|---|
| `force_original_aspect_ratio=decrease` | Co/phóng nội dung để nằm trọn trong giới hạn, không stretch |
| `force_divisible_by=2` | Bảo đảm kích thước nội dung chẵn, phù hợp chroma 4:2:0/NVENC |
| `reset_sar=1` | Tính kích thước theo DAR thật của input anamorphic và xuất SAR 1:1 |
| `pad=w:h:x:y` | Tạo canvas cố định; phần trống mặc định/ở đây chỉ rõ màu đen |
| `(ow-iw)/2`, `(oh-ih)/2` | Căn nội dung giữa canvas |
| `setsar=1` | Chốt metadata pixel vuông sau chuỗi filter; thừa về logic khi `reset_sar=1` hoạt động nhưng giúp ý định rõ ràng |

FFmpeg docs xác nhận `force_original_aspect_ratio`, `force_divisible_by`,
`reset_sar` và công thức `DAR = width / height × SAR`:
[scale/pad/setsar filters](https://ffmpeg.org/ffmpeg-filters.html#scale).

### 16.5 Fallback cho FFmpeg cũ chưa có `reset_sar`

Chuỗi ban đầu của case:

```text
scale=...:force_original_aspect_ratio=decrease,pad=...,setsar=1
```

đủ cho input square-pixel thông thường, bao gồm video 640×480 đang gặp lỗi. Nhưng
với nguồn anamorphic, việc xóa SAR ở cuối có thể làm sai DAR nếu scaler cũ giữ DAR
bằng cách truyền SAR khác 1. Fallback tương thích rộng là chuẩn hóa input thành
hình học square-pixel trước, rồi mới fit vào canvas:

```text
scale='trunc(ih*dar/2)*2':'trunc(ih/2)*2',setsar=1,
scale=w=TARGET_W:h=TARGET_H:force_original_aspect_ratio=decrease:force_divisible_by=2,
pad=w=TARGET_W:h=TARGET_H:x=(ow-iw)/2:y=(oh-ih)/2,
setsar=1
```

Thay `TARGET_W/TARGET_H` lần lượt bằng `640/360`, `1280/720`, `1920/1080` ở
ba nhánh. Cách này có thêm một bước scale và kém hiệu quả hơn `reset_sar=1`, nhưng
biểu thức dùng `dar` nên không vứt bỏ thông tin anamorphic một cách mù quáng.

### 16.6 Bản full-GPU cho FFmpeg mới

FFmpeg hiện hành có `pad_cuda`; `scale_cuda` mới cũng hỗ trợ
`force_original_aspect_ratio`, `force_divisible_by` và `reset_sar`. Khi build đang
dùng có đủ các option này, filter graph có thể giữ frame trong VRAM:

```bash
INPUT_FILE="videos/input.mp4"                 # Placeholder: file nguồn cần encode
OUTPUT_DIR="videos/output"                    # Placeholder: thư mục asset đầu ra
OUTPUT_MPD="${OUTPUT_DIR}/init.mpd"           # Manifest DASH chính

CUDA_FILTER_GRAPH='[0:v]split=3[v0][v1][v2];' # Tách CUDA frames thành ba nhánh ABR
CUDA_FILTER_GRAPH+='[v0]scale_cuda=w=640:h=360:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:format=yuv420p,pad_cuda=w=640:h=360:x=(ow-iw)/2:y=(oh-ih)/2:color=black[s0];'       # Nhánh GPU 360p: contain + pad
CUDA_FILTER_GRAPH+='[v1]scale_cuda=w=1280:h=720:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:format=yuv420p,pad_cuda=w=1280:h=720:x=(ow-iw)/2:y=(oh-ih)/2:color=black[s1];'    # Nhánh GPU 720p: contain + pad
CUDA_FILTER_GRAPH+='[v2]scale_cuda=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1:format=yuv420p,pad_cuda=w=1920:h=1080:x=(ow-iw)/2:y=(oh-ih)/2:color=black[s2]'     # Nhánh GPU 1080p: contain + pad

CUDA_ARGS=(
  -hwaccel cuda                                 # Yêu cầu hardware-accelerated decode khi codec hỗ trợ
  -hwaccel_output_format cuda                   # Giữ decoded frame trong CUDA hardware frames
  -i "$INPUT_FILE"                             # Chọn input media
  -filter_complex "$CUDA_FILTER_GRAPH"         # Chạy split + scale_cuda + pad_cuda trong VRAM

  -map "[s0]"                                  # Output video stream 0: canvas 640x360
  -map "[s1]"                                  # Output video stream 1: canvas 1280x720
  -map "[s2]"                                  # Output video stream 2: canvas 1920x1080
  -map "0:a:0?"                                # Map audio đầu tiên nếu có

  -c:v h264_nvenc                              # Encode ba video stream bằng NVIDIA H.264
  -c:a aac                                     # Encode audio thành AAC
  -b:a 128k                                    # Audio bitrate mục tiêu
  -rc vbr                                      # NVENC variable bitrate
  -cq 21                                       # Mục tiêu chất lượng VBR
  -preset p6                                   # Preset ưu tiên chất lượng VOD
  -bf 3                                        # Cho phép tối đa ba B-frame
  -b_ref_mode middle                           # Cho B-frame giữa làm reference nếu được hỗ trợ
  -spatial-aq 1                                # Bật spatial AQ
  -aq-strength 8                               # Cường độ spatial AQ
  -temporal-aq 1                               # Bật temporal AQ
  -rc-lookahead 32                             # Lookahead 32 frame
  -multipass qres                              # Multipass quarter-resolution

  -g 120                                       # GOP tối đa; wrapper nên tính lại theo FPS
  -keyint_min 120                              # Khoảng keyframe tối thiểu theo frame
  -force_key_frames "expr:gte(t,n_forced*2)"  # Ép keyframe mỗi hai giây

  -b:v:0 450k                                  # Bitrate mục tiêu rendition 360p
  -maxrate:v:0 675k                            # Peak bitrate rendition 360p
  -bufsize:v:0 900k                            # VBV buffer rendition 360p
  -profile:v:0 main                            # H.264 Main cho rendition 360p
  -b:v:1 1000k                                 # Bitrate mục tiêu rendition 720p
  -maxrate:v:1 1500k                           # Peak bitrate rendition 720p
  -bufsize:v:1 2000k                           # VBV buffer rendition 720p
  -profile:v:1 main                            # H.264 Main cho rendition 720p
  -b:v:2 1900k                                 # Bitrate mục tiêu rendition 1080p
  -maxrate:v:2 2850k                           # Peak bitrate rendition 1080p
  -bufsize:v:2 3800k                           # VBV buffer rendition 1080p
  -profile:v:2 high                            # H.264 High cho rendition 1080p

  -use_timeline 1                              # Ghi SegmentTimeline trong MPD
  -use_template 1                              # Dùng SegmentTemplate
  -single_file 0                               # Ghi từng segment thành file riêng
  -seg_duration 4                              # Mục tiêu segment bốn giây
  -adaptation_sets "id=0,streams=v id=1,streams=a" # Một video ABR set và một audio set
  -init_seg_name 'init_$RepresentationID$.m4s' # Template initialization segment
  -media_seg_name 'chunk_$RepresentationID$_$Number%05d$.m4s' # Template media segment
  -f dash                                      # Chọn DASH muxer
  "$OUTPUT_MPD"                                # Path manifest đầu ra
)

ffmpeg "${CUDA_ARGS[@]}"                      # Thực thi pipeline full-GPU đề xuất
```

> **Chưa kiểm chứng trên FFmpeg/GPU của dự án.** Trước khi áp dụng, kiểm tra
> `ffmpeg -h filter=scale_cuda` và `ffmpeg -h filter=pad_cuda`. Build cũ có thể
> không biết `pad_cuda`/`reset_sar`; khi đó dùng bản CPU §16.4 hoặc fallback §16.5.
> `scale_cuda` không chuyển đổi giữa họ màu RGB và YUV; HDR/10-bit cần pipeline
> colorspace/tone-map riêng, không được coi lệnh này là universal HDR.

Nguồn:

- [FFmpeg CUDA filters: `pad_cuda`, `scale_cuda`](https://ffmpeg.org/ffmpeg-filters.html#CUDA-Video-Filters)
- [FFmpeg patch thêm `reset_sar` cho scale/scale_cuda](https://ffmpeg.org/pipermail/ffmpeg-devel/2025-January/339114.html)
- [NVIDIA: Using FFmpeg with NVIDIA GPU Hardware Acceleration (PDF)](https://docs.nvidia.com/video-technologies/video-codec-sdk/12.1/pdf/Using_FFmpeg_with_NVIDIA_GPU_Hardware_Acceleration.pdf)

### 16.7 Có thật sự tồn tại một lệnh universal không?

**Có**, nếu "universal" chỉ có nghĩa: mọi DAR phổ biến (4:3, 16:9, 21:9, 9:16,
SAR anamorphic) đều được đặt không méo vào ba canvas 16:9. §16.4 đáp ứng mục tiêu
đó trên FFmpeg có `reset_sar`; §16.6 là biến thể full-GPU.

**Không**, nếu "universal" nghĩa là một chuỗi CLI tĩnh tối ưu cho mọi file upload.
Production vẫn phải `ffprobe` trước và sinh command theo metadata vì:

1. `-map 0:a:0?` làm audio mapping optional, nhưng chuỗi tĩnh
   `id=1,streams=a` vẫn có thể tạo AdaptationSet audio rỗng khi file không có audio.
   Nếu không có audio, phải bỏ cả audio map/options và dùng
   `-adaptation_sets "id=0,streams=v"`.
2. Input 640×480 không có thêm chi tiết để tạo 720p/1080p. Lệnh cố định vẫn chạy
   nhưng chỉ upscale, tốn GPU, storage và bandwidth. Orchestrator nên chỉ giữ rung
   không vượt độ phân giải hiển thị nguồn, hoặc cho phép tối đa một rung upscale có
   chủ đích.
3. HDR/SDR, 8/10-bit, RGB/YUV, interlaced/progressive, rotation metadata, nhiều
   audio language và codec input khác nhau cần policy riêng.
4. `-g 120` là frame-based: đúng 4 giây chỉ ở 30 fps. `-force_key_frames` theo thời
   gian giúp căn mốc, nhưng production vẫn nên tính GOP từ frame rate đã probe.

Do đó thiết kế đúng là **một template filter universal về hình học + wrapper
ffprobe sinh ladder/audio/GOP**, không phải một command string bất biến.

#### 16.7.1 Preflight đúng nghĩa: probe và lập kế hoạch, không double-encode

Không tạo một file `normalized.mp4` trung gian rồi encode DASH lần hai. Cách đó
decode/encode hai lần, tốn thời gian và gây generation loss. "Xử lý trước" ở đây
là bước **read-only metadata preflight**; normalize hình ảnh vẫn diễn ra trong
chính filter graph của lần transcode DASH duy nhất.

Luồng đề xuất:

```text
input gốc
  → ffprobe metadata (không đổi file)
  → resolve display geometry + rotation + SAR/DAR
  → chọn policy canvas
  → chọn ladder không upscale
  → chọn nhánh audio / SDR-HDR / progressive-interlaced / CPU-GPU
  → sinh FFmpeg args
  → transcode + package DASH đúng một lần
  → ffprobe/validate output
```

**Bước 1 — Probe đủ metadata để ra quyết định:**

```bash
INPUT_FILE="videos/input.mp4"                  # Placeholder: file cần probe

FFPROBE_ARGS=(
  -v error                                     # Chỉ in lỗi và dữ liệu được yêu cầu
  -show_entries format=duration:stream=index,codec_type,codec_name,width,height,coded_width,coded_height,sample_aspect_ratio,display_aspect_ratio,pix_fmt,bits_per_raw_sample,field_order,avg_frame_rate,r_frame_rate,color_range,color_space,color_transfer,color_primaries,sample_rate,channels,channel_layout:stream_tags=language:stream_side_data=rotation # Lấy video, audio, geometry, FPS, color và rotation
  -of json                                     # Xuất metadata dạng JSON
  "$INPUT_FILE"                                # Path input
)

ffprobe "${FFPROBE_ARGS[@]}"                   # Thực thi probe
```

Không dùng chỉ `width/height`. Wrapper cần lấy video stream đầu tiên theo policy
của dự án và tính display geometry:

```text
SAR = sample_aspect_ratio; nếu metadata không có/N/A thì policy fallback 1:1
DAR = width / height × SAR
rotation 90° hoặc 270° → đổi trục display width/height (DAR hiệu dụng đảo lại)
```

FFmpeg bật `-autorotate` mặc định khi transcode, nghĩa là rotation metadata được
áp ở filtering stage. Tuy nhiên full-GPU build phải được kiểm chứng với file quay
dọc thật; nếu hardware graph không tự xử lý được, wrapper phải thêm
`transpose_cuda` phù hợp hoặc fallback về CPU filter. Không được vừa để autorotate
vừa tự transpose lần nữa.

**Bước 2 — Chọn policy hình học một lần cho toàn hệ thống:**

- Mặc định hiện tại: canvas 16:9, `contain + pad`, SAR 1:1. Đây là template
  universal về aspect ratio ở §16.4/§16.6.
- Nếu sản phẩm muốn video dọc chiếm toàn bộ player, phải định nghĩa thêm ladder
  portrait riêng; đó là policy sản phẩm khác, không nên tự động thay đổi theo từng
  file mà frontend không biết.
- Black bars đã "baked into" pixel nguồn không thể nhận biết chắc chắn bằng
  metadata. `cropdetect` chỉ là heuristic và có thể đoán sai cảnh mở đầu tối; không
  đưa auto-crop vào default universal pipeline.

**Bước 3 — Chọn ladder theo scale factor, không chỉ theo tên 360p/720p/1080p:**

Với display size nguồn `SW×SH` và canvas ứng viên `W×H`, contain scale factor là:

```text
s = min(W / SW, H / SH)
```

- Giữ rung nếu `s <= 1`: chỉ downscale hoặc giữ nguyên, không bịa thêm chi tiết.
- Nếu không rung nào đạt điều kiện, giữ rung nhỏ nhất làm fallback có chủ đích.
- Nếu business muốn upscale, phải là policy explicit (ví dụ tối đa 1.25×), không
  phải side effect của command tĩnh.

Ví dụ nguồn 640×480:

| Canvas | Scale factor | Quyết định mặc định |
|---|---:|---|
| 640×360 | `min(640/640, 360/480) = 0.75` | Giữ |
| 1280×720 | `1.5` | Bỏ, tránh 720p giả |
| 1920×1080 | `2.25` | Bỏ, tránh 1080p giả |

Khi chỉ còn một video rung, nó vẫn là DASH hợp lệ; ABR chỉ thực sự có ý nghĩa từ
hai video Representation trở lên.

**Bước 4 — Sinh các nhánh command theo metadata:**

- Có audio: thêm audio map/codec và `id=1,streams=a`.
- Không audio: bỏ toàn bộ audio options và chỉ dùng `id=0,streams=v`.
- Nhiều audio language: map từng track theo policy và giữ metadata language; không
  âm thầm vứt tất cả ngoài `a:0` nếu product cần multilingual.
- Interlaced: deinterlace trước scale; progressive thì không thêm filter thừa.
- HDR/10-bit: đi pipeline HDR riêng hoặc tone-map có chủ đích; không ép thẳng về
  `yuv420p` 8-bit rồi coi là SDR đúng màu.
- GOP: tính từ FPS đã probe cho CFR; với VFR vẫn dùng keyframe theo timestamp và
  kiểm chứng segment alignment sau encode.
- CUDA filter chỉ được chọn khi codec decoder, pixel format, GPU và FFmpeg build
  đều hỗ trợ; nếu không, dùng CPU scale + NVENC encode thay vì fail cả job.

Pseudo-code orchestration (**đề xuất, chưa phải source có sẵn của dự án**):

```javascript
const metadata = await ffprobe(input);
const plan = resolveInputPlan(metadata);        // geometry, rotation, audio, color, FPS
const candidates = [canvas360, canvas720, canvas1080];

let ladder = candidates.filter(canvas =>
  containScaleFactor(plan.displaySize, canvas) <= 1
);

if (ladder.length === 0) ladder = [candidates[0]];

const filterGraph = buildContainPadGraph(ladder, { resetSar: true });
const args = buildDashArgs({ plan, ladder, filterGraph });

await spawnFfmpegOnce(args);                    // Một lần transcode, không intermediate encode
await validateDashOutput(outputMpd, plan, ladder);
```

Nguồn hành vi công cụ:

- [ffprobe `-show_entries`](https://ffmpeg.org/ffprobe.html#Main-options)
- [FFmpeg `-autorotate` và `-autoscale`](https://ffmpeg.org/ffmpeg.html#Advanced-Video-options)
- [FFmpeg scale: `force_original_aspect_ratio`, `force_divisible_by`, `reset_sar`](https://ffmpeg.org/ffmpeg-filters.html#scale)
- [FFmpeg DASH `adaptation_sets`](https://ffmpeg.org/ffmpeg-formats.html#dash-2)

> Lệnh probe và hai pipeline trên là đề xuất; session tài liệu không tự thực thi.

### 16.8 Lưu ý orchestration ngoài lệnh encode

- Không dùng `thumbnail-command | encode-command`: lệnh thumbnail ghi PNG ra file,
  không xuất media sang stdout, còn lệnh thứ hai cũng không đọc `pipe:0`. Dấu `|`
  chỉ nối stdout/stdin và có thể cho hai process chạy đồng thời. Chạy hai job riêng;
  nếu cần tuần tự, wrapper chỉ bắt đầu encode sau khi thumbnail exit code 0.
- `-ss 10` không tạo thumbnail nếu video ngắn hơn mốc đó. Wrapper nên chọn timestamp
  dựa trên duration đã probe. PNG là lossless; `-qscale:v 2` không mang cùng ý nghĩa
  như với JPEG.
- `$RepresentationID$`/`$Number...$` phải được quote theo shell: single quote phù
  hợp Bash/PowerShell; `cmd.exe` và Node `spawn(args)` có parser khác nên phải truyền
  template dưới dạng một argument literal theo đúng môi trường.
- Wrapper phải tạo thư mục `OUTPUT_DIR` trước khi DASH muxer mở output.

### 16.9 Checklist verify sau encode

1. Mỗi Representation được giữ phải đúng canvas mà preflight đã chọn; nếu plan có
   đủ ba rung thì lần lượt là `640×360`, `1280×720`, `1920×1080`.
2. Mỗi Representation phải báo `sample_aspect_ratio=1:1` và DAR `16:9`.
3. MPD phải gom đúng số video stream đã chọn vào một video AdaptationSet; audio set
   chỉ tồn tại nếu input có audio.
4. Segment đầu của mỗi rung phải bắt đầu bằng keyframe; timeline/keyframe phải align.
5. Xem thử ít nhất một nguồn 4:3, 16:9, portrait, ultrawide và anamorphic.
6. So visual để chắc chắn không stretch/crop; viền đen là kết quả chủ ý của contain.
7. Không Representation nào được vượt ngưỡng upscale mà policy cho phép; không
   publish rung 720p/1080p giả từ nguồn thấp.

---

## Changelog
- **2026-07-11** — Thêm §16 phân tích lỗi DASH `Conflicting stream aspect ratios`
  từ case input 640×480: đối chiếu `dashenc.c`, chỉ ra ladder cũ trộn 3:2 và 16:9,
  giải thích nguồn gốc 720×480 non-square-pixel, và chuẩn hóa canvas 16:9 bằng
  `scale + pad + reset_sar/setsar`. Thêm command CPU tương thích, command full-GPU
  `scale_cuda + pad_cuda` (đánh dấu chưa kiểm chứng), fallback FFmpeg cũ, giới hạn
  của khái niệm "một lệnh universal", optional audio, tránh upscale và probe/verify
  checklist. Dùng placeholder `INPUT_FILE`/`OUTPUT_DIR`, tách mỗi option thành một
  Bash array entry có comment và giữ lưu ý orchestration `|`. Đánh dấu lệnh §15 cũ
  superseded cho input tổng quát; giữ nguyên nội dung lịch sử. Bổ sung §16.7.1:
  preflight read-only thay vì intermediate transcode, resolve rotation/SAR/DAR,
  chọn ladder bằng contain scale factor để tránh upscale giả, rẽ nhánh audio,
  HDR/interlace/CPU-GPU và pseudo-code orchestration một lần encode.
- **2026-06-20** — Đối chiếu trực tiếp source FFmpeg để đính chính/khẳng định:
  - §3.4: sửa bảng `-profile` của `hevc_nvenc` — `3/4` cũ ("main still picture / high
    throughput") là SAI; đúng là enum tự đánh số 0=main,1=main10,2=rext,3=multiview_main
    (nguồn [nvenc.h](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc.h) +
    [nvenc_hevc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/nvenc_hevc.c)).
    Giữ bảng cũ dưới marker `[SUPERSEDED]`.
  - §10.2: thêm `[VERIFIED]` cho khẳng định DASH muxer mặc định re-encode H.264 — xác nhận bằng
    `.p.video_codec = AV_CODEC_ID_H264` trong [dashenc.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/dashenc.c).
  - §15.6: thêm liên kết tới [init_compare_output.md](init_compare_output.md) (verify + đo chất lượng).
