# FFmpeg Preset Options Reference

**Last updated:** 2026-06-20  
**Source:** FFmpeg official documentation  
**Scope:** preset của **libx264/libx265** (named) **và NVENC** (`h264_nvenc`/`hevc_nvenc`, p1–p7)

> ⚠️ **Đọc trước:** có **HAI hệ preset hoàn toàn khác nhau**, đừng trộn:
> - **Software (`libx264`/`libx265`)** → preset **bằng tên**: `ultrafast … placebo` (mục bên dưới).
> - **Hardware NVENC (`h264_nvenc`/`hevc_nvenc`)** → preset **`p1`–`p7`** (xem mục "NVENC Presets").
>
> Pipeline production của dự án chạy **NVENC** (`-preset p4`/`p6`) → phần libx264 chỉ áp dụng khi
> fallback encode bằng CPU. Đặt tên preset libx264 (vd `medium`) cho NVENC sẽ bị bỏ qua hoặc map
> sang preset cũ deprecated. Liên quan: [ffmpeg-hevc-dash-streaming-notes.md §15](ffmpeg-hevc-dash-streaming-notes.md).

---

## Overview

The `-preset` option controls the trade-off between encoding speed and compression efficiency when using FFmpeg with the H.264 video codec (`libx264`). It affects the quality of compression relative to the time spent encoding.

**Key principle:** Faster presets = larger file sizes but quicker encoding. Slower presets = smaller file sizes but longer encoding times.

---

## Preset Tiers (Ordered: Fastest → Slowest)

### 1. ultrafast
**Speed:** Extreme (~10x faster than medium)  
**File size:** Very large (~50% larger than medium)  
**Use case:** Real-time streaming, live broadcasts, situations where encoding speed is critical  
**Details:** 
- Minimal compression techniques
- Few reference frames
- Least CPU-intensive
- Not recommended for archival

### 2. superfast
**Speed:** Very fast (~4-5x faster than medium)  
**File size:** Large (~30% larger than medium)  
**Use case:** Real-time applications, when speed matters more than quality  
**Details:**
- Still minimal compression
- Slightly better than ultrafast
- Practical for some streaming scenarios

### 3. veryfast
**Speed:** Fast (~2-3x faster than medium)  
**File size:** Moderate (~15% larger than medium)  
**Use case:** Quick transcoding, preview encoding, situations where balanced speed is needed  
**Details:**
- Reasonable compression efficiency
- Good for quick iterations

### 4. faster
**Speed:** Moderately fast (~1.5x faster than medium)  
**File size:** Slightly larger (~8% larger than medium)  
**Use case:** Faster encoding with minor quality compromise  

### 5. fast
**Speed:** Balanced, slightly faster than medium  
**File size:** Slightly larger than medium (~3-5%)  
**Use case:** Quick encoding for distribution without extreme speed requirements  

### 6. medium ⭐ (DEFAULT)
**Speed:** Baseline reference point  
**File size:** Baseline reference point  
**Use case:** General purpose encoding, recommended starting point  
**Details:**
- Good balance of speed and compression
- Suitable for most use cases
- Official default preset
- Recommended unless you have specific needs

### 7. slow
**Speed:** Slower (~2x slower than medium)  
**File size:** Smaller (~10% smaller than medium)  
**Use case:** Final distribution, archival, when file size matters  
**Details:**
- Better compression quality
- Longer encoding times
- Good for end products

### 8. slower
**Speed:** Much slower (~3-4x slower than medium)  
**File size:** Much smaller (~15-20% smaller than medium)  
**Use case:** Archival, premium distribution, final masters  
**Details:**
- Significantly better compression
- Very long encoding times
- Professional quality output

### 9. veryslow
**Speed:** Very slow (~5-6x slower than medium)  
**File size:** Very small (~25-30% smaller than medium)  
**Use case:** Maximum compression, when file size is critical  
**Details:**
- Advanced motion prediction
- Most compression techniques enabled
- Practical for archival

### 10. placebo
**Speed:** Extremely slow (10-20x slower than medium)  
**File size:** Marginally smaller than veryslow (< 5% difference)  
**Use case:** ⚠️ **Not recommended for practical use**  
**Details:**
- Minimal compression benefit vs. veryslow
- Extreme time investment
- Primarily theoretical/demonstration value
- Time/benefit ratio not worth it in real scenarios

---

## Command Line Usage

### Basic syntax
```bash
ffmpeg -i input.mp4 -preset medium -c:v libx264 output.mp4
```

### Common examples

**Fast encoding for preview/streaming:**
```bash
ffmpeg -i input.mp4 -preset faster -c:v libx264 -crf 23 output.mp4
```

**Balanced quality/speed (default):**
```bash
ffmpeg -i input.mp4 -preset medium -c:v libx264 -crf 23 output.mp4
```

**High quality archival:**
```bash
ffmpeg -i input.mp4 -preset slower -c:v libx264 -crf 18 output.mp4
```

**Maximum compression:**
```bash
ffmpeg -i input.mp4 -preset veryslow -c:v libx264 -crf 15 output.mp4
```

---

## Parameters That Work With Preset

### CRF (Constant Rate Factor)
- **Range:** 0-51 (default: 23)
- **Lower = better quality, larger file**
- **Higher = lower quality, smaller file**
- Presets affect how efficiently CRF is applied

### CRF Examples at Different Presets
For the same input with `-crf 23`:
- **preset ultrafast:** Larger file, visible compression artifacts
- **preset medium:** Balanced quality
- **preset veryslow:** Better quality with same CRF value due to superior compression techniques

---

## Decision Matrix

| Goal | Preset | Notes |
|------|--------|-------|
| Real-time streaming | ultrafast, superfast | Accept larger files for speed |
| Quick testing | veryfast, faster | Reasonable speed/quality balance |
| General distribution | **medium** | Safe default, recommended starting point |
| Premium delivery | slow, slower | Longer encoding time worth it |
| Archival/storage | slower, veryslow | Minimize long-term storage costs |
| Do NOT use | placebo | Marginal benefit, extreme time cost |

---

## Performance Benchmarks (Reference)

Typical encoding speeds on modern hardware (varies by CPU):

| Preset | Relative Speed | Typical Files/Hour |
|--------|----------------|-------------------|
| ultrafast | 10x baseline | ~400+ MB files |
| superfast | 4-5x baseline | ~100-150 MB files |
| medium | 1x (baseline) | ~20-40 MB files |
| slower | 0.33x baseline | ~10-20 MB files |
| veryslow | 0.16x baseline | ~5-10 MB files |

*Actual results depend heavily on source resolution, bitrate, CPU cores, and system load.*

---

## Tips & Best Practices

1. **Start with `medium`** unless you have a specific reason not to
2. **Use `CRF` with presets** to control quality independently
3. **For streaming:** Choose faster presets to reduce buffering/latency
4. **For archival:** Choose slower presets to minimize long-term storage
5. **Test locally first** with a small file segment before batch processing
6. **Consider workflow:**
   - Fast ingest/transcoding: `veryfast` → `faster`
   - Distribution: `medium`
   - Archival: `slow` → `slower`
7. **Avoid `placebo`** — time investment doesn't justify marginal quality gains

---

---

## NVENC Presets (`h264_nvenc` / `hevc_nvenc`) — p1–p7

**Đây là hệ preset cho encode bằng GPU NVIDIA** — KHÁC hoàn toàn tên preset libx264 ở trên.

### Bảng p-preset (mới, khuyến nghị)

| Preset | Tốc độ | Chất lượng / nén | Dùng khi |
|---|---|---|---|
| `p1` | Nhanh nhất | Thấp nhất | Live latency cực thấp, chấp nhận xấu |
| `p2` | Rất nhanh | Thấp | Live |
| `p3` | Nhanh | Khá | Real-time nhẹ |
| `p4` ⭐ | Cân bằng (**default**) | Trung bình | Mặc định; transcode nhanh |
| `p5` | Chậm hơn | Tốt | VOD cân bằng |
| `p6` | Chậm | Tốt hơn | **VOD chất lượng** (dự án dùng cho bản so chất lượng) |
| `p7` | Chậm nhất | Cao nhất | VOD tối đa chất lượng, encode 1 lần để lưu |

**Nguyên tắc:** `p1` → `p7` đổi **tốc độ lấy chất lượng** (giống ultrafast→veryslow của x264, nhưng
GPU nên chênh tốc độ tuyệt đối nhỏ hơn nhiều). NVENC luôn nhanh hơn libx264 ở cùng "đẳng cấp" chất lượng.

### Preset cũ (deprecated — chỉ để tương thích ngược)

`default, slow, medium, fast, hp, hq, bd, ll, llhq, llhp, lossless, losslesshp` — **đã lỗi thời**;
FFmpeg map ngầm về p-preset. Tránh dùng. (Ví dụ lệnh production cũ ghi `-preset 4` = `hp` rồi bị
`-preset p4` ghi đè — xem [encode_explain.md](encode_explain.md) / [notes §9.1](ffmpeg-hevc-dash-streaming-notes.md).)

### `-tune` đi kèm preset (NVENC)

| `-tune` | Ý nghĩa | Dùng cho |
|---|---|---|
| `hq` | High Quality (**mặc định**) | **VOD** — đây là tune dự án dùng |
| `ll` | Low Latency | Live thường |
| `ull` | Ultra Low Latency | Live realtime (game/WebRTC) |
| `lossless` | Không mất dữ liệu | Master/archive |

### Khác biệt cốt lõi so với CRF của libx264

- NVENC **không có CRF** đúng nghĩa. Chất lượng-không-đổi của NVENC là **`-rc vbr -cq N`**
  (`cq` 0–51, thấp = đẹp; ~19–23 cho VOD) — đặt `cq` thay vì target bitrate.
- p-preset của NVENC **không** ảnh hưởng nhiều tới dung lượng như x264 preset; bù lại NVENC nén
  kém hơn x264 ở cùng bitrate → muốn bằng chất lượng x264 thường phải **tăng bitrate ~10–20%**
  hoặc nhảy lên `p6/p7`.

### Hỗ trợ player / web (đừng nhầm preset với khả năng phát)

> Preset/tune **chỉ ảnh hưởng chất lượng-tốc độ encode, KHÔNG quyết định player phát được hay
> không** — cái đó do **codec + codec string**:
> - `h264_nvenc` (bất kỳ preset nào) → ra `avc1` → **dash.js/VLC/mọi trình duyệt phát được.**
> - `hevc_nvenc` (bất kỳ preset nào) → ra `hev1`/`hvc1` → **dash.js KHÔNG phát native** (cần WASM);
>   VLC/mpv/Safari phát được. Chi tiết: [notes §13](ffmpeg-hevc-dash-streaming-notes.md).

> Nguồn: [FFmpeg Codecs — NVENC](https://ffmpeg.org/ffmpeg-codecs.html#toc-nvenc) ·
> [NVENC Preset Migration Guide (NVIDIA)](https://docs.nvidia.com/video-technologies/video-codec-sdk/12.0/nvenc-preset-migration-guide/index.html) ·
> kiểm bản đang cài: `ffmpeg -h encoder=hevc_nvenc` (mục `-preset`, `-tune`, `-rc`).

---

## References

- **FFmpeg H.264 Codec Documentation:** https://trac.ffmpeg.org/wiki/Encode/H.264
- **x264 Encoder Guide:** https://www.x264.dev/ (official x264 project)
- **FFmpeg Official:** https://ffmpeg.org/documentation.html
- **FFmpeg NVENC presets:** https://ffmpeg.org/ffmpeg-codecs.html#toc-nvenc
- **NVENC Preset Migration Guide:** https://docs.nvidia.com/video-technologies/video-codec-sdk/12.0/nvenc-preset-migration-guide/index.html

---

## Related Options

When using presets, commonly paired with:
- `-c:v libx264` — Specify H.264 codec
- `-crf N` — Quality (lower = better)
- `-b:v 5000k` — Bitrate (alternative to CRF)
- `-maxrate`, `-bufsize` — For streaming compliance
- `-profile:v main` — H.264 profile compatibility

---

## [ADDED 2026-07-05] Migrate NVENC ladder sang libx264 (CPU fallback, không GPU)

**Bối cảnh:** `encodeAPI.js` case 4 (default) của `Stream-Sub-Server` dùng
`-hwaccel cuda -hwaccel_output_format cuda` + filter `scale_cuda` + `-c:v h264_nvenc` để encode
DASH 3-bitrate ladder (450k/1000k/1900k @ 720x480/1080x720/1920x1080). Node deploy trên VM free-tier
(Oracle) không có GPU/NVENC → cần bản CPU-only tương đương.

**Nguyên tắc cốt lõi:** NVENC là ASIC riêng trên GPU NVIDIA với tập tham số rate-control/AQ tự
thiết kế (`-rc`, `-cq`, `-spatial-aq`, `-multipass`) — **không có ánh xạ tự động** sang libx264.
Đổi `-c:v h264_nvenc` → `-c:v libx264` mà giữ nguyên các flag riêng NVENC bên dưới sẽ lỗi
`Unrecognized option`.

### Bảng ánh xạ flag (case 4 gốc → bản CPU)

| Flag NVENC | Vai trò | libx264 | Lý do |
|---|---|---|---|
| `-hwaccel cuda -hwaccel_output_format cuda` | Decode + giữ frame trong VRAM (zero-copy cho filter GPU) | **Bỏ hẳn** | Lỗi "Cannot init CUDA" nếu không có GPU |
| `scale_cuda=W:H` | Resize bằng NPP (GPU) | `scale=W:H` | Bản CPU dùng `libswscale` |
| `-c:v h264_nvenc` | Encoder ASIC | `-c:v libx264` | Đổi encoder kéo theo đổi toàn bộ option riêng bên dưới |
| `-rc vbr -cq N` | Rate control "constant quality" NVENC | `-crf N` (giữ nguyên số làm điểm khởi đầu) | Cùng ý tưởng quality-based, thang đo nội bộ khác nhau — xem mục "Khác biệt cốt lõi so với CRF" ở trên |
| `-preset pN` | Tốc độ/chất lượng NVENC | `-preset <tên>` — xem bảng preset libx264 đầu file | 2 hệ tên hoàn toàn khác nhau |
| `-bf N -b_ref_mode middle` | B-frame + reference mode riêng NVENC | Giữ `-bf N`, **bỏ** `-b_ref_mode` | `-bf` generic; `-b_ref_mode` chỉ NVENC có |
| `-spatial-aq -aq-strength -temporal-aq` | Adaptive Quantization NVENC | **Bỏ** | libx264 tự bật AQ mặc định nội bộ (`aq-mode 1`) |
| `-rc-lookahead N` | NVENC nhìn trước N frame | **Bỏ** (optional: `-x264-params rc-lookahead=N`) | Không bắt buộc cho ABR ladder VOD thường |
| `-multipass qres` | 2-pass rút gọn nội bộ NVENC | **Bỏ** | Muốn 2-pass thật ở libx264 phải tự dựng `-pass 1`/`-pass 2` |
| `-g`/`-keyint_min`/`-force_key_frames` | GOP/keyframe đồng bộ segment | **Giữ nguyên** | Generic, không thuộc riêng encoder |
| `-b:v:N -maxrate:v:N -bufsize:v:N` | Bitrate ladder + VBV cap mỗi track | **Giữ nguyên** | Output option chung |
| `-profile:v:N` | H.264 profile | **Giữ nguyên** | Cùng tên profile string cho cả 2 encoder |
| *(mới)* `-pix_fmt yuv420p` | Pixel format | **Thêm mới** | Case NVENC dựa vào `hwaccel_output_format` để giữ format hợp lệ; bỏ CUDA phải set tay |
| *(mới)* `-threads 0` | Số luồng CPU | **Thêm mới** | NVENC chỉ cần 1-2 luồng feed GPU; libx264 hưởng lợi dùng hết core — `0` = auto |

### Preset khuyến nghị cho CPU yếu (free-tier, kể cả ARM)

Encode 3 track cùng lúc bằng libx264 (software) tốn CPU gấp nhiều lần so với NVENC (ASIC chuyên
dụng gần như không tải CPU). Với shape 1/8 OCPU (`E2.1.Micro`) hay vài OCPU chia sẻ (`A1.Flex`
ARM) — bắt đầu ở **`veryfast`** (thậm chí `superfast` nếu đo thực tế vẫn quá chậm), không bắt
đầu ở `medium` (mặc định x264, tối ưu cho CPU thường chứ không phải CPU giới hạn lõi).

### Lệnh CPU-equivalent đầy đủ cho case 4

```bash
ffmpeg -i <file> \
  -filter_complex "[0:v]split=3[v0][v1][v2];[v0]scale=720:480[s0];[v1]scale=1080:720[s1];[v2]scale=1920:1080[s2]" \
  -map "[s0]" -map "[s1]" -map "[s2]" -map 0:a:0 \
  -c:v libx264 -preset veryfast -crf 21 -pix_fmt yuv420p -threads 0 \
  -c:a aac -b:a 128k \
  -bf 3 -g 120 -keyint_min 120 \
  -force_key_frames "expr:gte(t,n_forced*2)" \
  -b:v:0 450k  -maxrate:v:0 675k  -bufsize:v:0 900k  -profile:v:0 main \
  -b:v:1 1000k -maxrate:v:1 1500k -bufsize:v:1 2000k -profile:v:1 main \
  -b:v:2 1900k -maxrate:v:2 2850k -bufsize:v:2 3800k -profile:v:2 high \
  -use_timeline 1 -use_template 1 -single_file 0 -seg_duration 4 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash <outputResult>
```
`chưa kiểm chứng` trên VM thật — đề xuất theo tài liệu chính thức FFmpeg (References ở trên),
người dùng tự áp dụng/thêm làm case mới trong `encodeAPI.js`, không tự sửa code dự án.

**Liên quan:** [deployment-hidden-bugs-and-pitfalls.md](deployment-hidden-bugs-and-pitfalls.md) —
case node crash-loop cùng session deploy STORAGE node lên Oracle free-tier (không GPU) dẫn tới
nhu cầu bản CPU-only này.

---

## Changelog

- **2026-06-20** — Last updated (nội dung gốc: bảng preset libx264 ultrafast→placebo, bảng NVENC
  p1–p7, khác biệt CRF vs `-cq`, cảnh báo 2 hệ preset không trộn lẫn).
- **2026-07-05** — Thêm mục "Migrate NVENC ladder sang libx264 (CPU fallback)": bảng ánh xạ
  flag-by-flag từ case 4 thật của `encodeAPI.js` (Stream-Sub-Server) sang bản CPU-only, preset
  khuyến nghị cho CPU yếu/ARM free-tier, lệnh đầy đủ đề xuất (`chưa kiểm chứng`). Không sửa/xoá
  nội dung cũ.