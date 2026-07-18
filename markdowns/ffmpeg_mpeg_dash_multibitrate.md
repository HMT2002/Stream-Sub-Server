# MPEG-DASH Multi-Bitrate Streaming với FFmpeg

> ⚠️ **[SUPERSEDED 2026-06-20 từng phần]** Bản nền tảng dùng `libx264` + pipe MPEG-TS. Giữ
> nguyên để tham chiếu, nhưng lưu ý đã được đính chính:
> - Bảng mô tả `-b_strategy 0/1/2` và `-sc_threshold` như **đang có tác dụng** — chỉ đúng với
>   **libx264 (software)**. Với `h264_nvenc`/`hevc_nvenc` (NVENC) hai option này **bị bỏ qua**;
>   tương đương NVENC là `-strict_gop 1` và `-no-scenecut 1`. Xem [notes §9.1](ffmpeg-hevc-dash-streaming-notes.md).
> - Pipe 2 lệnh (stage 2 thiếu `-c:v`) **mặc định re-encode H.264** → nếu stage 1 là HEVC thì bị
>   double-encode + biến thành H.264. Đã verify bằng source. Xem [notes §10](ffmpeg-hevc-dash-streaming-notes.md).
>
> ➡️ Bản encode/verify hiện hành: [ffmpeg-hevc-dash-streaming-notes.md](ffmpeg-hevc-dash-streaming-notes.md) ·
> [init_compare_output.md](init_compare_output.md) · [ffmpeg-presets-reference.md](ffmpeg-presets-reference.md).

## Tổng quan

Tài liệu này cung cấp kiến thức về tạo MPEG-DASH (Dynamic Adaptive Streaming over HTTP) streams với nhiều bitrate video và audio dùng FFmpeg.

---

## 1. Khái niệm cơ bản

### MPEG-DASH là gì?

**MPEG-DASH** (Dynamic Adaptive Streaming over HTTP) là một chuẩn streaming video cho phép:
- **Adaptive bitrate**: Tự động chuyển đổi chất lượng video dựa trên tốc độ kết nối
- **HTTP-based**: Sử dụng giao thức HTTP tiêu chuẩn, dễ cache, không cần máy chủ đặc biệt
- **Segmented**: Chia video thành các segment nhỏ (chunks) để tải từng phần

### Cấu trúc MPEG-DASH

```
XDOGi9HDash/
├── init.mpd                          # Manifest file (Media Presentation Description)
├── init_video0.m4s                   # Initialization segment cho video bitrate 0
├── init_video1.m4s                   # Initialization segment cho video bitrate 1
├── chunk_video0_00001.m4s            # Video segment 1, bitrate 0
├── chunk_video0_00002.m4s            # Video segment 2, bitrate 0
├── chunk_video1_00001.m4s            # Video segment 1, bitrate 1
└── ...
```

**Thành phần chính:**
- **MPD (Media Presentation Description)**: Tệp XML mô tả cấu trúc stream, bitrate, resolution, codec
- **Init segments (.m4s)**: Chứa thông tin codec, profile, level (tải một lần)
- **Media segments (.m4s)**: Các chunk video/audio (thường 2-10 giây mỗi chunk)

---

## 2. FFmpeg Command Structure

### Cấu trúc lệnh tổng quát

```bash
ffmpeg -i INPUT \
  [ENCODING_OPTIONS] \
  [MAPPING_OPTIONS] \
  [BITRATE_OPTIONS] \
  [OUTPUT_OPTIONS] \
  OUTPUT
```

### Ví dụ: 4 Video Bitrate + 1 Audio Bitrate (CÓ SỬA)

```bash
ffmpeg -i videos/XDOGi9H.mp4 \
  -c:v libx264 \
  -c:a aac \
  -b:a 128k \
  -preset veryfast \
  -bf 1 \
  -b_strategy 0 \
  -sc_threshold 0 \
  -pix_fmt yuv420p \
  -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:v:0 -map 0:v:0 \
  -b:v:0 300k -s:v:0 720x480 -profile:v:0 baseline \
  -b:v:1 700k -s:v:1 1080x720 -profile:v:1 main \
  -b:v:2 1300k -s:v:2 1920x1080 -profile:v:2 high \
  -b:v:3 2500k \
  -f mpegts - | \
ffmpeg -i - \
  -map 0 \
  -use_timeline 1 \
  -single_file 0 \
  -use_template 1 \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash videos/XDOGi9HDash/init.mpd
```

---

## 3. Chi tiết các tùy chọn FFmpeg

### A. Encoder Options (Tùy chọn mã hóa)

| Option | Ý nghĩa | Giá trị thường dùng |
|--------|---------|-------------------|
| `-c:v libx264` | Video codec (H.264) | libx264, libx265 |
| `-c:a aac` | Audio codec | aac, libfdk_aac, libopus |
| `-b:a 128k` | Audio bitrate | 128k, 192k, 256k |
| `-preset` | Tốc độ mã hóa vs chất lượng | ultrafast, veryfast, fast, medium, slow |
| `-bf 1` | Max B-frames (0-16) | 1-3 (HLS/DASH khuyên 0-1) |
| `-b_strategy 0` | B-frame strategy | 0=off, 1=simple, 2=complex |
| `-sc_threshold 0` | Scene cut threshold (0-100) | 0=off, 40=default |
| `-pix_fmt yuv420p` | Pixel format | yuv420p (H.264), yuv420p10le (10-bit) |

**Giải thích:**
- `libx264`: Codec H.264 phổ biến nhất (tương thích tốt, hiệu suất tốt)
- `aac`: Audio codec tương thích với DASH/HLS
- `preset veryfast`: Tốc độ nhanh, chất lượng chấp nhận được
- `-bf 1`: Giảm độ trễ, tốt cho adaptive streaming
- `-sc_threshold 0`: Tắt scene detection
- `-pix_fmt yuv420p`: Tiêu chuẩn, tương thích tốt

### B. Mapping Options (Tùy chọn ánh xạ)

**Vấn đề gốc:**
```bash
# SAI: Tạo 4 audio stream
-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0
```

**Cách sửa: 4 video + 1 audio**
```bash
# ĐÚNG: 4 video output, 1 audio output
-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:v:0 -map 0:v:0
```

**Cách hoạt động:**
- `-map 0:v:0`: Đưa video stream 0 từ input → output #0 (video bitrate 0)
- `-map 0:a:0`: Đưa audio stream 0 từ input → output #1 (audio)
- `-map 0:v:0`: → output #2 (video bitrate 1)
- `-map 0:v:0`: → output #3 (video bitrate 2)
- `-map 0:v:0`: → output #4 (video bitrate 3)

**Kết quả:**
- Output 0, 1, 2, 3 = Video (4 bitrate khác nhau)
- Output (audio) = Audio duy nhất được chia sẻ cho cả 4 video

### C. Bitrate & Resolution Options

```bash
# Output 0: 300k, 720x480, baseline profile
-b:v:0 300k -s:v:0 720x480 -profile:v:0 baseline

# Output 1: 700k, 1080x720, main profile
-b:v:1 700k -s:v:1 1080x720 -profile:v:1 main

# Output 2: 1300k, 1920x1080, high profile
-b:v:2 1300k -s:v:2 1920x1080 -profile:v:2 high

# Output 3: 2500k
-b:v:3 2500k
```

**H.264 Profiles:**
| Profile | Ứng dụng | Khả năng |
|---------|---------|---------|
| `baseline` | Mobile, low-end devices | I-frames + P-frames |
| `main` | Standard devices | + B-frames, CABAC |
| `high` | Desktop, HD, UHD | Cao cấp, chất lượng tốt nhất |

---

## 4. Piping Architecture

### Hai-stage Pipeline

```
Stage 1: Encode to MPEGTS
ffmpeg -i INPUT [OPTIONS] -f mpegts -
                                    │
                                    │ Pipe (stdout → stdin)
                                    ▼
Stage 2: Packetize to DASH
ffmpeg -i - -map 0 -f dash output.mpd
```

**Tại sao cần 2 stage?**
1. **Stage 1**: Tạo video/audio streams với encoding settings cụ thể
2. **Stage 2**: Đóng gói các streams thành DASH manifest + segments

**Lợi ích:**
- Không cần file trung gian (không dùng disk)
- Streaming thực sự
- Tiết kiệm thời gian, disk space

---

## 5. DASH-specific Options

### DASH Output Settings

```bash
ffmpeg -i - \
  -map 0 \                               # Map tất cả streams
  -use_timeline 1 \                      # Timeline (not live)
  -single_file 0 \                       # Mỗi segment là file riêng
  -use_template 1 \                      # Dùng template naming
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash output/init.mpd
```

| Option | Ý nghĩa |
|--------|---------|
| `-map 0` | Map tất cả streams từ input |
| `-use_timeline 1` | On-demand (VOD) mode |
| `-single_file 0` | Tách file cho mỗi segment |
| `-use_template 1` | Dùng placeholders |
| `-adaptation_sets` | Gộp streams: v=video, a=audio |

### Adaptation Sets

```bash
-adaptation_sets "id=0,streams=v id=1,streams=a"
```

Giải thích:
- `id=0,streams=v`: Tất cả video streams (video 0-3)
- `id=1,streams=a`: Tất cả audio streams

---

## 6. File Naming Templates

```bash
-init_seg_name init_$RepresentationID$.m4s \
-media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s
```

**Ví dụ output:**
```
init_video0.m4s
init_video1.m4s
init_audio.m4s
chunk_video0_00001.m4s
chunk_video0_00002.m4s
chunk_video1_00001.m4s
```

---

## 7. Bitrate Ladder Best Practices

### Ví dụ tốt (từ bài gốc)

| Bitrate | Resolution | Use case |
|---------|------------|----------|
| 300k | 720x480 | 2G/3G, poor connection |
| 700k | 1080x720 | 3G, poor 4G |
| 1300k | 1920x1080 | 4G, good WiFi |
| 2500k | 1920x1080 | Fast WiFi, wired |

**Quy tắc:**
1. Bitrate tăng dần
2. Gap giữa steps: 30-50%
3. Resolution có thể bằng nhau (ở bitrate khác nhau)

---

## 8. Troubleshooting

### Vấn đề 1: Quá nhiều audio streams

**Nguyên nhân:** Mapping sai (ánh xạ audio nhiều lần)

**Giải pháp:**
```bash
# Trước:
-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0

# Sau:
-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:v:0 -map 0:v:0
```

---

## 9. Tài liệu tham khảo chính thức

1. **FFmpeg Documentation**
   - https://ffmpeg.org/ffmpeg-all.html (Full reference)
   - https://ffmpeg.org/ffmpeg-formats.html (DASH)

2. **DASH Standard**
   - ISO/IEC 23009-1 (Official DASH spec)
   - https://dashif.org/ (DASH Industry Forum)

3. **H.264 Encoding**
   - https://trac.ffmpeg.org/wiki/Encode/H.264
   - ITU-T H.264 standard

4. **Video Bitrate Guidelines**
   - Apple HLS Authoring Spec
   - Adobe Media Server documentation

---

## 10. Công cụ kiểm tra

```bash
# Kiểm tra properties
ffprobe videos/XDOGi9H.mp4

# Inspect DASH segments
ffprobe videos/XDOGi9HDash/init_video0.m4s

# Validate MPD
ffprobe videos/XDOGi9HDash/init.mpd
```

---

## 11. Cải tiến tiếp theo

1. **Keyframe control:**
   ```bash
   -g 48 -keyint_min 48
   ```

2. **Constant quality (CRF):**
   ```bash
   -crf 23
   ```

3. **VBV buffering:**
   ```bash
   -maxrate 300k -bufsize 300k
   ```

4. **Hardware acceleration:**
   ```bash
   -c:v h264_nvenc   # NVIDIA
   -c:v h264_qsv     # Intel
   ```
```