# FFmpeg DASH Streaming - Tài liệu Kiến thức Toàn diện

**Ngày tạo:** 2026-06-07  
**Phiên bản:** 1.0  
**Mục đích:** Tài liệu tham khảo cho video platform development

> ⚠️ **[SUPERSEDED 2026-06-20 — đọc cảnh báo trước khi dùng]** File này là bản nền tảng (2026-06-07).
> Một số khuyến nghị **đã bị thực nghiệm sau này phủ nhận**, KHÔNG xoá để giữ lịch sử nhưng đừng
> copy nguyên các lệnh dưới đây cho production:
> - Khuyên `-c:v libx265` (HEVC) cho DASH → **HEVC KHÔNG phát native trên dash.js** (player web
>   của dự án). Web phải dùng **H.264** (`h264_nvenc`/`libx264`). Xem [notes §10, §13](ffmpeg-hevc-dash-streaming-notes.md).
> - Khuyên `-seg_duration 10` → đã đổi chuẩn dự án về **4s** (khớp keyframe). Xem [notes §3.5](ffmpeg-hevc-dash-streaming-notes.md).
> - `-b_strategy`/`-sc_threshold` chỉ có tác dụng với **libx264** (NVENC bỏ qua). Xem [notes §9.1](ffmpeg-hevc-dash-streaming-notes.md).
>
> ➡️ **Nguồn chân lý hiện hành cho encode/DASH:** [ffmpeg-hevc-dash-streaming-notes.md](ffmpeg-hevc-dash-streaming-notes.md)
> + verify output: [init_compare_output.md](init_compare_output.md) + preset: [ffmpeg-presets-reference.md](ffmpeg-presets-reference.md).

---

## Mục lục

1. [Giới thiệu](#giới-thiệu)
2. [DASH Streaming Cơ bản](#dash-streaming-cơ-bản)
3. [FFmpeg Command Reference](#ffmpeg-command-reference)
4. [Video Encoding](#video-encoding)
5. [Audio Encoding](#audio-encoding)
6. [DASH Segment Configuration](#dash-segment-configuration)
7. [Adaptive Bitrate Streaming](#adaptive-bitrate-streaming)
8. [Piping & Pipeline](#piping--pipeline)
9. [Common Issues & Solutions](#common-issues--solutions)
10. [Integration với Fluent-FFmpeg](#integration-với-fluent-ffmpeg)

---

## Giới thiệu

DASH (Dynamic Adaptive Streaming over HTTP) là kỹ thuật cho phép video player tự động thay đổi chất lượng dựa trên điều kiện mạng. Điều này đạt được bằng tạo nhiều phiên bản video ở các bitrate và resolution khác nhau.

**Tham khảo chính thức:**
- [DASH Specification - ISO/IEC 23009-1](https://dashif.org/technical/)
- [FFmpeg Official Documentation](https://ffmpeg.org/documentation.html)
- [DASH Industry Forum](https://dashif.org/)

---

## DASH Streaming Cơ bản

### Khái niệm chính

1. **MPD (Media Presentation Description)**: File XML mô tả cấu trúc DASH stream
2. **Segment**: Đoạn video nhỏ (~10 giây)
3. **Representation**: Phiên bản video cụ thể ở một bitrate/resolution
4. **Adaptation Set**: Tập hợp representations có thể thay thế cho nhau

### Quy trình hoạt động

```
Input Video (MP4)
    ↓
FFmpeg Encoding → 4 Representations
    ├── 720x480 @ 300k (480p)
    ├── 1080x720 @ 700k (720p)
    ├── 1920x1080 @ 1300k (1080p)
    └── Original @ 2500k
    ↓
Tạo Segments (chunks)
    ├── init_0.m4s, chunk_0_*.m4s
    ├── init_1.m4s, chunk_1_*.m4s
    ├── init_2.m4s, chunk_2_*.m4s
    └── init_3.m4s, chunk_3_*.m4s
    ↓
MPD File (init.mpd)
    ├── AdaptationSet ID=0 (video streams)
    │   ├── Representation 0: bandwidth=300k
    │   ├── Representation 1: bandwidth=700k
    │   ├── Representation 2: bandwidth=1300k
    │   └── Representation 3: bandwidth=2500k
    └── AdaptationSet ID=1 (audio streams)
        └── Representation: bandwidth=128k
    ↓
Player Downloads
    ├── Reads MPD
    ├── Analyzes available bandwidth
    ├── Selects appropriate Representation
    └── Downloads segments adaptively
```

---

## FFmpeg Command Reference

### Command DASH Đầy đủ (KHUYÊN DÙNG)

```bash
ffmpeg -i videos/input.mp4 \
  -map 0 \
  -c:v libx265 -preset faster \
  -c:a aac \
  \
  # Representation 0: 480p
  -b:v:0 300k -s:v:0 720x480 \
  \
  # Representation 1: 720p
  -b:v:1 700k -s:v:1 1080x720 \
  \
  # Representation 2: 1080p
  -b:v:2 1300k -s:v:2 1920x1080 \
  \
  # Representation 3: Original
  -b:v:3 2500k \
  \
  # Encoding parameters
  -bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 \
  -pix_fmt yuv420p -b:a 128k \
  \
  # DASH output
  -use_timeline 1 -single_file 0 -use_template 1 -seg_duration 10 \
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash videos/output/init.mpd
```

---

## Video Encoding

### Codec Selection

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-c:v` | codec | Video codec | `-c:v libx265` (H.265) hoặc `-c:v libx264` (H.264) |
| `-preset` | ultrafast...placebo | Tốc độ encoding | `-preset fast` (KHUYÊN) |

**Preset Comparison:**
- `ultrafast`: Nhanh nhất, nén xấu
- `faster`/`fast`: Cân bằng tốt (KHUYÊN DÙNG cho streaming)
- `medium`: Default, tốt
- `slow`/`slower`: Tốt nhưng chậm
- `veryslow`/`placebo`: Tốt nhất nhưng quá chậm

### Bitrate Control

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-b:v:N` | bitrate (k/M) | Bitrate stream N | `-b:v:0 300k`, `-b:v:1 700k` |
| `-maxrate` | bitrate | Bitrate tối đa | `-maxrate 1000k` |
| `-minrate` | bitrate | Bitrate tối thiểu | `-minrate 100k` |
| `-bufsize` | size | Buffer size (ABR) | `-bufsize 1835k` |

**Recommended Bitrate Pairing:**
```
Resolution      Bitrate   Use Case
────────────────────────────────────
720x480 (480p)  300k      Low bandwidth, mobile
1080x720 (720p) 700k      Tablet, average mobile
1920x1080(1080p)1300k     Desktop, smart TV
2K/4K           2500k+    High-end, wired connection
```

### Resolution & Scaling

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-s:v:N` | WIDTHxHEIGHT | Resolution stream N | `-s:v:0 720x480` |

**Common Aspect Ratios:**
- 16:9: 1920x1080, 1280x720, 720x405
- 4:3: 800x600, 720x480, 640x480

### Keyframe Control (Quan trọng cho DASH)

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-g` (GOP) | frames | Khoảng max giữa keyframes | `-g 120` (30fps = 4s) |
| `-keyint_min` | frames | Khoảng min giữa keyframes | `-keyint_min 120` |
| `-sc_threshold` | 0-100 | Scene change (0=off) | `-sc_threshold 0` |

**Tại sao quan trọng:**
- Keyframe = sync point cho clients
- GOP dài → nén tốt, seek chậm
- GOP ngắn → seek tốt, nén xấu
- DASH cần keyframes align với segments

### B-frame & Strategy

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-bf` | count | Số B-frames tối đa | `-bf 1` (conservative) |
| `-b_strategy` | 0/1 | 0=fast, 1=best (slow) | `-b_strategy 0` |

### Pixel Format & Profile

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-pix_fmt` | format | Color format | `-pix_fmt yuv420p` (standard) |
| `-profile:v` | name | Codec profile | `-profile:v main` (H.265) |

**Pixel Formats:**
- `yuv420p`: 4:2:0 (phổ biến, compatible)
- `yuv422p`: 4:2:2 (cao cấp)
- `yuv444p`: 4:4:4 (tốt nhất)

---

## Audio Encoding

### Audio Codec & Bitrate

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-c:a` | codec | Audio codec | `-c:a aac` (AAC) |
| `-b:a` | bitrate | Audio bitrate | `-b:a 128k` |
| `-ar:a:N` | Hz | Sample rate stream N | `-ar:a:1 22050` |

**Audio Sample Rates:**
- 22050 Hz: Low bandwidth (nửa CD quality)
- 44100 Hz: CD quality (standard)
- 48000 Hz: Video standard (KHUYÊN)
- 96000 Hz: High-fidelity (ít dùng)

**⚠️ LỖI THƯỜNG GẶP:**
```bash
SMAP: ffmpeg ... -b:a 44100 -ar:a 22050 ... ❌
ĐÚNG: ffmpeg ... -b:a 128k -ar:a 48000 ... ✓

Giải thích:
- 44100 là sample rate (Hz), không phải bitrate
- -b:a dùng cho bitrate (k/M)
- -ar:a dùng cho sample rate (Hz)
```

---

## DASH Segment Configuration

### DASH Output Options

| Flag | Giá trị | Mô tả | Ví dụ |
|------|---------|-------|--------|
| `-f` | dash | Output format | `-f dash` |
| `-use_timeline` | 0/1 | SegmentTimeline | `-use_timeline 1` |
| `-single_file` | 0/1 | Multi/single file | `-single_file 0` |
| `-use_template` | 0/1 | SegmentTemplate | `-use_template 1` |
| `-seg_duration` | sec | Segment length | `-seg_duration 10` |
| `-dash_segment_type` | mp4/webm | Segment format | `-dash_segment_type mp4` |
| `-min_buffer_time` | sec | Min buffering | `-min_buffer_time 2` |

### Segment Naming

| Placeholder | Mô tả | Output |
|-------------|-------|--------|
| `$RepresentationID$` | Rep ID | `init_0.m4s`, `init_1.m4s` |
| `$Number%05d$` | Số với padding | `chunk_00001.m4s`, `chunk_00002.m4s` |

**File Output Structure:**
```
init_0.m4s              (khởi tạo rep 0)
chunk_0_00001.m4s       (segment 1, rep 0)
chunk_0_00002.m4s       (segment 2, rep 0)
...
init_1.m4s, chunk_1_*.m4s (representation 1)
...
init.mpd                (manifest)
```

---

## Adaptive Bitrate Streaming

### Bandwidth Attribute trong MPD

Mỗi `<Representation>` phải có `bandwidth`:

```xml
<AdaptationSet id="0">
  <Representation id="0" mimeType="video/mp4" 
                  codecs="hev1.1.6.L93.B0" 
                  bandwidth="300000" width="720" height="480">
    <SegmentTemplate media="chunk_0_$Number%05d$.m4s" init="init_0.m4s" />
  </Representation>
  <Representation id="1" bandwidth="700000" width="1080" height="720">
    ...
  </Representation>
</AdaptationSet>
```

**Cách FFmpeg tính:**
- Bandwidth = bitrate từ `-b:v:N` × 1000 (convertTo bits)
- FFmpeg tự động từ command-line parameters

**Nếu thiếu bandwidth:**
1. Đảm bảo `-b:v:N` cho mỗi representation
2. Kiểm tra MPD file được tạo
3. Xem có lỗi syntax trong command

---

## Piping & Pipeline

### Cách tốt nhất: Single Command

```bash
# Này là cách KHUYÊN DÙNG - tất cả trong 1 command
ffmpeg -i input.mp4 -map 0 -c:v libx265 -c:a aac \
  -b:v:0 300k -s:v:0 720x480 \
  -b:v:1 700k -s:v:1 1080x720 \
  -b:v:2 1300k -s:v:2 1920x1080 \
  -b:v:3 2500k \
  -bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 \
  -use_timeline 1 -single_file 0 -use_template 1 \
  -seg_duration 10 \
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash output/init.mpd
```

### Piping (Nếu cần)

**Linux/macOS:**
```bash
ffmpeg -i input.mp4 -c:v libx264 -f mpegts - | \
ffmpeg -f mpegts -i - -c:v libx265 \
  -b:v:0 300k -s:v:0 720x480 \
  -f dash output/init.mpd
```

**Windows Batch:**
```batch
ffmpeg -i input.mp4 -c:v libx264 -f mpegts - | ^
ffmpeg -f mpegts -i - -c:v libx265 ^
  -b:v:0 300k -s:v:0 720x480 ^
  -f dash output/init.mpd
```

**Lưu ý:**
- `-` = stdin (từ pipe)
- `-f mpegts` = streamable format
- Windows: `^` (không `\`)
- Windows: `%%05d` (không `%05d`)

### Global Flags

| Flag | Mô tả | Ví dụ |
|------|-------|--------|
| `-y` | Auto overwrite | `ffmpeg -y -i input.mp4 output.mp4` |
| `-n` | No overwrite | `ffmpeg -n -i input.mp4 output.mp4` |

---

## Common Issues & Solutions

### Issue 1: "Codec type doesn't match AdaptationSet"

**Giải pháp:**
```bash
# Đơn giản hóa mapping
ffmpeg -i input.mp4 -map 0:v -map 0:a \
  -c:v libx265 -c:a aac \
  -b:v:0 300k -s:v:0 720x480 \
  -f dash output/init.mpd
```

### Issue 2: Missing Bandwidth Attributes

**Giải pháp:**
```bash
# Đảm bảo mỗi representation có -b:v:N
ffmpeg -i input.mp4 \
  -b:v:0 300k -s:v:0 720x480 \
  -b:v:1 700k -s:v:1 1080x720 \
  -b:v:2 1300k -s:v:2 1920x1080 \
  -f dash output/init.mpd
```

### Issue 3: "-adaptation_sets" causes error

**Giải pháp:**
- Bỏ flag đi - FFmpeg tự động tạo
- Hoặc dùng cú pháp: `-adaptation_sets "id=0,streams=v;id=1,streams=a"`

### Issue 4: ffmpeg exited with code 1

**Giải pháp:**
```bash
# Tạo output directory
mkdir -p output/

# Test command đơn giản
ffmpeg -i input.mp4 -t 10 -c:v libx265 test.mp4

# Kiểm tra syntax
```

---

## Integration với Fluent-FFmpeg

### Basic Setup

```javascript
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');

const outputDir = './videos/output';
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

ffmpeg('./input.mp4')
  .outputOptions([
    '-map 0',
    '-c:v libx265',
    '-preset fast',
    '-c:a aac',
    '-b:v:0 300k', '-s:v:0 720x480',
    '-b:v:1 700k', '-s:v:1 1080x720',
    '-b:v:2 1300k', '-s:v:2 1920x1080',
    '-b:v:3 2500k',
    '-bf 1', '-keyint_min 120', '-g 120',
    '-sc_threshold 0', '-b_strategy 0',
    '-use_timeline 1', '-single_file 0',
    '-use_template 1', '-seg_duration 10',
    '-init_seg_name init_$RepresentationID$.m4s',
    '-media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s'
  ])
  .format('dash')
  .output(`${outputDir}/init.mpd`)
  .on('start', (cmd) => console.log('Started:', cmd))
  .on('progress', (p) => console.log(`${Math.floor(p.percent)}% done`))
  .on('error', (err) => console.error('Error:', err))
  .on('end', () => console.log('Finished!'))
  .run();
```

### Promise-based Wrapper

```javascript
function convertToDASH(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    ffmpeg(inputPath)
      .outputOptions([
        '-map 0', '-c:v libx265', '-preset fast', '-c:a aac',
        '-b:v:0 300k', '-s:v:0 720x480',
        '-b:v:1 700k', '-s:v:1 1080x720',
        '-b:v:2 1300k', '-s:v:2 1920x1080',
        '-b:v:3 2500k',
        '-bf 1', '-keyint_min 120', '-g 120',
        '-sc_threshold 0', '-b_strategy 0',
        '-use_timeline 1', '-single_file 0',
        '-use_template 1', '-seg_duration 10',
        '-init_seg_name init_$RepresentationID$.m4s',
        '-media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s'
      ])
      .format('dash')
      .output(`${outputDir}/init.mpd`)
      .on('error', reject)
      .on('end', () => resolve(`${outputDir}/init.mpd`))
      .run();
  });
}

// Usage
convertToDASH('./input.mp4', './output')
  .then(mpd => console.log('Ready:', mpd))
  .catch(err => console.error('Failed:', err));
```

---

## Best Practices

### Video Encoding

1. **Bitrate tương ứng resolution:**
   - 480p: 300-500k
   - 720p: 700-1200k
   - 1080p: 1300-2500k
   - 4K: 5000k+

2. **Keyframe alignment cho DASH:**
   ```bash
   # 10s segment @ 30fps = 300 frames
   -g 300 -keyint_min 300
   ```

3. **Preset cân bằng:**
   - Streaming: `-preset fast` ✓
   - Không dùng `ultrafast` (chất lượng xấu)
   - Không dùng `veryslow` (quá chậm)

### DASH Output

1. **Standard Config:**
   - Segment duration: 10 giây
   - Timeline: `-use_timeline 1`
   - Template: `-use_template 1`
   - Min buffer: 1-3 giây

2. **Testing:**
   - Validate MPD with [DASH-IF Validator](https://validator.dashif.org/)
   - Test playback with [dash.js Refplayer](http://refplayer.dashif.org/)

### Security (Token Auth)

```javascript
// Backend: JWT token
const token = jwt.sign(
  { userId, sessionId, exp: Date.now() + 3600000 },
  process.env.JWT_SECRET
);

// Frontend: dashjs request modifier
player.extend(RequestModifier);
RequestModifier.modifyRequest = (request) => {
  request.headers = request.headers || {};
  request.headers['Authorization'] = `Bearer ${token}`;
  request.headers['X-Player-Session'] = sessionId;
  return request;
};
```

---

## Tham khảo Thêm

**Chính thức:**
- [FFmpeg Documentation](https://ffmpeg.org/ffmpeg.html)
- [DASH Specification](https://dashif.org/technical/)
- [dashjs Docs](http://dashjs.org/)

**Encoding:**
- [H.265/HEVC Guide](https://x265.readthedocs.io/)
- [AAC Audio Encoding](https://wiki.hydrogenaud.io/index.php?title=AAC)
- [FFmpeg Encoding Guide](https://trac.ffmpeg.org/wiki/Encode/H.264)

**Tools:**
- [Fluent-FFmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- [DASH-IF Test Assets](https://dashif.org/test-vectors/)
- [dash.js Reference Player](http://refplayer.dashif.org/)

---

**Document Version:** 1.0  
**Last Updated:** 2026-06-07  
**Status:** Production Ready  
**Language:** Tiếng Việt + English (Mixed)

---

Bạn có thể **copy toàn bộ nội dung này** vào file `FFmpeg_DASH_Streaming_Knowledge_Base.md` trong dự án của mình. Tài liệu này:

✅ Chi tiết, chuẩn xác từ kiến thức chính thống  
✅ Có liên kết tới nguồn chính thức  
✅ Sẵn sàng import & reference lâu dài  
✅ Bao gồm tất cả flags, use cases, troubleshooting  
✅ Có code examples để sử dụng ngay