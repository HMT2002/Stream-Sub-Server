# CMAF, Thuật Toán ABR & Công Cụ Phân Tích Luồng Streaming

> **Chủ đề chat:** Đào sâu CMAF; các họ thuật toán ABR (throughput / BOLA / DYNAMIC); công cụ miễn phí phân tích luồng streaming của web.
> **Ngày tạo:** 2026-06-07 | **Phiên bản:** 1.0
>
> **⚠️ Track chủ đề:** Chủ đề CMAF + ABR + công cụ phân tích là **mới hoàn toàn**, chưa có file nào trong kho phủ.
> - Phần ABR có liên hệ tới options FFmpeg trong `FFmpeg_DASH_Streaming_Knowledge_Base.md` và `ffmpeg_mpeg_dash_multibitrate.md` (đó là phía encode/server), còn file này là phía **client/player decision**.
> - Mọi cập nhật về CMAF / ABR / công cụ debug stream → ghi vào FILE NÀY.

---

## 1. CMAF — Common Media Application Format (ISO/IEC 23000-19, 2018)

### Vấn đề giải quyết
HLS truyền thống dùng segment `.ts`, DASH dùng fMP4 `.m4s` → phải đóng gói/lưu/cache **2 lần** cùng một nội dung. CMAF quy định **một định dạng segment chung (fMP4)** cho cả HLS lẫn DASH.

```
        ┌──────────────────────────────┐
        │  CMAF segments (.m4s, fMP4)  │  ← 1 bộ media, encode 1 lần
        └──────────────────────────────┘
            ▲                       ▲
        ┌───┴────┐            ┌─────┴────┐
        │ .m3u8  │            │  .mpd    │  ← 2 manifest "mỏng" tham chiếu
        │ (HLS)  │            │ (DASH)   │     cùng 1 bộ media
        └────────┘            └──────────┘
```
→ Tiết kiệm ~50% storage, tăng CDN cache hit. Vẫn cần 2 manifest (rất nhẹ).

### CMAF chunk vs segment — nền tảng low-latency
| Đơn vị | Chứa | Vai trò |
|---|---|---|
| Segment | nhiều fragment | đơn vị addressable trên CDN (4–6s) |
| Fragment | moof + mdat | đơn vị decode độc lập |
| **Chunk** | fragment rất nhỏ (~200ms) | đơn vị **truyền tải** cho low-latency |

Chunked CMAF + HTTP chunked transfer encoding = cơ chế kỹ thuật của LL-DASH & LL-HLS (server gửi từng chunk ngay khi encode, không chờ trọn segment) → trễ 30s ↓ 2–7s.

### Giới hạn thực tế: cbcs vs cenc
- HLS/FairPlay yêu cầu `cbcs` (AES-CBC).
- DASH/Widevine/PlayReady đời đầu dùng `cenc` (AES-CTR).
- Chọn sai scheme → vẫn phải đóng gói 2 lần dù dùng CMAF.
- **Best practice (DASH-IF):** dùng `cbcs` cho cả hai (Widevine + PlayReady hiện đại đều hỗ trợ) → "encode once, encrypt once, play everywhere".

**Nguồn:** [DASH-IF](https://dashif.org/) · [Bitmovin sample streams (có CMAF test)](https://bitmovin.com/blog/mpeg-dash-hls-examples-sample-streams/)

---

## 2. Thuật toán ABR (phía player/software)

Mục tiêu QoE = bitrate cao + ít rebuffer + ít dao động (3 yếu tố mâu thuẫn → bài toán đánh đổi).

### Ba họ thuật toán
1. **Throughput-based**: ước lượng băng thông (harmonic mean) → chọn bitrate cao nhất ≤ 90% throughput. Nhanh, tốt khi buffer nhỏ (live); nhược: ước lượng trên TCP/CDN khó chính xác → dao động.
2. **Buffer-based — BOLA** (Buffer Occupancy based Lyapunov Algorithm): chỉ nhìn buffer; tối ưu utility qua Lyapunov; near-optimal steady-state. Nhược: phản ứng chậm với startup/seek (buffer rỗng) và thay đổi throughput đột ngột.
3. **Hybrid — DYNAMIC** (mặc định dash.js hiện tại): `buffer < 10s ? THROUGHPUT : BOLA`. Tận dụng throughput khi buffer nhỏ, BOLA khi buffer lớn.

### FAST SWITCHING (bổ trợ)
Thay segment bitrate thấp đã nằm trong buffer bằng bản bitrate cao khi throughput tăng → người xem thấy chất lượng cao hơn sớm hơn ~50s (đo trong nghiên cứu UMass).

### Cấu hình dash.js (chính thống)
```js
// https://dashif.org/dash.js/pages/usage/abr/settings.html
player.updateSettings({
  streaming: {
    abr: {
      maxBitrate: { audio: -1, video: 5000 },  // kbit/s
      minBitrate: { audio: -1, video: 2000 },
      rules: {
        throughputRule: { active: true },
        bolaRule: { active: true }   // bật cả hai => chế độ DYNAMIC
      }
    }
  }
});
```
Bật cả hai rule → dash.js tự switch theo buffer level (DYNAMIC).

**Nguồn:** [dash.js ABR Settings](https://dashif.org/dash.js/pages/usage/abr/settings.html) · [BOLA paper (UMass)](https://groups.cs.umass.edu/wp-content/uploads/sites/3/2019/12/BOLA-Near-optimal-bitrate-adaptation-for-online-videos.pdf) · [DYNAMIC/BOLA-E (ACM TOMM 2019)](https://dl.acm.org/doi/fullHtml/10.1145/3336497)

> Lưu ý: thuật toán ML như Pensieve (RL) tồn tại trong nghiên cứu/sandbox (vd [abrcc](https://github.com/danalex97/abrcc)), KHÔNG phải mặc định production — chưa khuyến nghị dùng trực tiếp khi chưa kiểm chứng.

---

## 3. Công cụ phân tích luồng streaming — miễn phí, trực quan

### Nhóm A — Web real-time analyzer (trực quan nhất, không cài đặt)
| Công cụ | Tính năng | URL |
|---|---|---|
| **OTT Basics** ⭐ | Phân tích live DASH/HLS, PTS/DTS gaps, LL-DASH latency, CDN cache; debugger Shaka/dash.js theo dõi buffer, ABR switch, live edge real-time | https://ottbasics.com/ |
| OTT Engine Stream Tester | MSE player (hls.js + dash.js), hiện variant list, current rung, bandwidth, buffer health | https://www.ottengine.com/tools/stream-tester |
| Ant Media HLS Tester | Diagnostics bar: bitrate, quality level, buffer length, dropped frames real-time | https://antmedia.io/webrtc-samples/hls-player/ |

**Cách dùng chung:** dán URL `.m3u8`/`.mpd` → Analyze/Load → quan sát biểu đồ buffer/bitrate/ABR. Yêu cầu: stream CORS-enabled HTTPS.

**Lấy URL stream của web đang xét:** DevTools (F12) → Network → lọc `m3u8`/`mpd` → copy URL manifest.

### Nhóm B — DevTools sẵn có (0 cài đặt)
- Chrome/Edge **Network tab**: lọc `m3u8`/`mpd`/`m4s`/`ts`, xem thời gian + kích thước từng segment → suy bitrate thực & thời điểm ABR đổi rung.
- **`chrome://media-internals`**: trang ẩn, hiện buffer state, dropped frames, audio/video config, player events.

### Nhóm C — CLI soi sâu segment/encoding (broadcast layer)
- **`ffprobe`** (đi kèm FFmpeg, đã có trong dự án):
  ```bash
  ffprobe -v error -show_streams -show_format input.mpd
  ```
  Nguồn: https://ffmpeg.org/ffprobe.html
- **hls-analyzer** (Python OSS): soi codec/profile/resolution, PTS timing, keyframe interval, kiểm tra mỗi segment có bắt đầu bằng keyframe (đảm bảo chuyển bitrate mượt).
  ```bash
  python hls-analyzer.py [-s SEGMENTS] [-l FRAME_INFO_LEN] <URL>
  ```
  Nguồn: https://github.com/epiclabs-io/hls-analyzer

### Bảng chọn nhanh
| Nhu cầu | Công cụ | Cài đặt | Trực quan |
|---|---|---|---|
| Biểu đồ ABR/buffer real-time | OTT Basics / OTT Engine | Không | ⭐⭐⭐⭐⭐ |
| Soi nhanh web đang mở | DevTools + media-internals | Có sẵn | ⭐⭐⭐⭐ |
| Soi codec/keyframe/GOP | ffprobe, hls-analyzer | CLI | ⭐⭐ |

**Đề xuất:** OTT Basics (trực quan nhất) + `chrome://media-internals` (cross-check) + `ffprobe` (xác minh encoding mức segment). Công cụ bên thứ ba nên tự kiểm chứng với [Bitmovin sample streams](https://bitmovin.com/blog/mpeg-dash-hls-examples-sample-streams/) trước khi tin số liệu trên stream production.

---

## 4. VMAF — Đo chất lượng video theo cảm nhận người xem (objective perceptual metric)

**Keywords:** VMAF, Video Multimethod Assessment Fusion, perceptual video quality, JND (Just Noticeable Difference), DMOS, ACR, libvmaf, VMAF model (default/phone/4K), quality-defined encoding, per-title encoding, PSNR, SSIM.

### 4.1 VMAF là gì
- **Video Multimethod Assessment Fusion** — metric chất lượng video do **Netflix + Đại học Nam California (USC)** đồng phát triển, mã nguồn mở, ra mắt 6/2016 để **thay PSNR** trong per-title encoding của Netflix.
- Kết hợp **mô hình thị giác con người + machine learning** → điểm thang **0–100**. Được huấn luyện trên điểm chấm chủ quan của người thật (DMOS), nên tương quan với "mắt người thấy thế nào" tốt hơn hẳn PSNR (thang ~30–45 dB) và SSIM (thang 0–1).
- Là **full-reference metric**: cần video gốc (pristine reference) để so. Không có gốc thì không tính được (trừ model no-reference riêng).
- Bản chất **tương đối**: VMAF nói chất lượng *so với nguồn*, không nói gì về chất lượng tuyệt đối của chính nguồn.

### 4.2 Thang điểm & cách diễn giải (model 1080p mặc định v0.6.1)
- Huấn luyện bằng **ACR (Absolute Category Rating)** trên màn **1080p, khoảng cách xem 3H** (3× chiều cao màn). Người xem chấm bad/poor/fair/good/excellent → "bad" ≈ 20, "excellent" ≈ 100. Vậy điểm 70 = giữa "good" và "fair".

| VMAF | Diễn giải |
|---|---|
| 95–100 | Gần như hoàn hảo; tăng bitrate thêm là vô ích (đã bão hòa cảm nhận) |
| ~93–95 | Ngưỡng "ngon" — **mục tiêu nên nhắm cho bitrate ladder** |
| 80–90 | Chấp nhận được, artifact nhẹ có thể thấy |
| 60–80 | "fair", vỡ bắt đầu rõ |
| <40 | Tệ, vỡ rõ ràng |

### 4.3 Hai mốc thực dụng quan trọng nhất
**① 6 điểm VMAF = 1 JND (Just Noticeable Difference)**
- Netflix: chênh **6 điểm** = một just-noticeable difference — theo định nghĩa là khác biệt mà **75% người sẽ thấy** khi so từng cặp.
- Thực dụng: chênh **1 điểm** → không ai để ý; chênh **15 điểm** → gần như ai cũng thấy.
- Đây là cách lượng hóa "giới hạn mắt người": dùng để chia nấc bitrate ladder cách nhau ~1 JND.

**② VMAF ~93 = "gần như không phân biệt được với gốc"**
- Nghiên cứu của Reza Rassool (RealNetworks CTO), "VMAF Reproducibility": encode đạt VMAF ~93 → phục vụ đa số khán giả với nội dung *không phân biệt được với gốc, hoặc méo nhẹ nhưng không khó chịu*.
- VMAF 93 ≈ SSIM 0.95.

### 4.4 ⚠️ Phụ thuộc MODEL & điều kiện xem — điểm dễ dùng sai nhất
- VMAF có 3 model: **default (1080p), phone, 4K**. Phải chọn model khớp cách user thật xem.
- Áp model **1080p lên video 720p/480p** → điểm diễn giải như xem ở khoảng cách **4.5H / 6.75H**; ở khoảng cách xa đó nhiều artifact bị che → **điểm cao giả tạo**.
- **Model phone** cho điểm cao hơn vì màn nhỏ che artifact → nếu user chủ yếu xem điện thoại thì đây mới là model đúng.
- Khi điểm chạm 100 thì tăng bitrate thêm KHÔNG cải thiện cảm nhận (đã bão hòa).
- Hệ quả cho dự án: vỡ thấy khi soi mpv pause-zoom (điều kiện khắc nghiệt) sẽ cho VMAF thấp hơn cảm nhận thật của user xem điện thoại tốc độ thường → đừng tăng bitrate quá tay dựa trên soi pixel.

### 4.5 Cách chạy (libvmaf trong FFmpeg)
```bash
# 2 input PHẢI cùng resolution → scale bản encode lên res gốc trước khi đo
ffmpeg -i encoded.mp4 -i original.mp4 \
  -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]libvmaf" -f null -

# Chỉ định model cụ thể (vd model phone)
ffmpeg -i encoded.mp4 -i original.mp4 \
  -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]libvmaf=model=path=/path/vmaf_v0.6.1.json" -f null -
```
- Áp dụng so H.264 vs HEVC: đo VMAF từng rendition vs cùng gốc. HEVC cao hơn ở cùng bitrate là dự kiến; nhưng **chênh <6 điểm thì user không nhận ra** → không đáng đánh đổi tính tương thích dash.js.

### 4.6 ⚠️ Lưu ý kiểm chứng trước khi tin số
- FFmpeg phải build kèm `libvmaf` → kiểm: `ffmpeg -filters | grep vmaf`. Nhiều bản không có sẵn.
- Mặc định là model 1080p; muốn model phone/4K phải trỏ file model qua `model=path=...`.
- Thứ tự input + cách scale ảnh hưởng kết quả → đọc kỹ docs trước khi tin số.
- VMAF có thể bị "hack" bằng tiền xử lý tăng contrast → cảnh giác điểm tăng bất thường.

### Nguồn
- Netflix TechBlog — VMAF: The Journey Continues: https://netflixtechblog.com/vmaf-the-journey-continues-44b51ee9ed12
- Netflix/vmaf (repo + docs model): https://github.com/Netflix/vmaf — models.md: https://github.com/Netflix/vmaf/blob/master/resource/doc/models.md
- Streaming Learning Center (Jan Ozer) — Finding the JND with VMAF: https://streaminglearningcenter.com/codecs/finding-the-just-noticeable-difference-with-netflix-vmaf.html
- Mapping SSIM & VMAF to subjective ratings: https://streaminglearningcenter.com/learning/mapping-ssim-vmaf-scores-subjective-ratings.html
- VMAF is Hackable: What Now?: https://streaminglearningcenter.com/blogs/vmaf-is-hackable-what-now.html
- libvmaf FFmpeg filter: https://ffmpeg.org/ffmpeg-filters.html#libvmaf

### 4.7 Các metric khác ngoài VMAF — so gốc ↔ encode (PSNR / SSIM / CIEDE / visual diff)

> [UPDATED 2026-06-14] Bổ sung các cách so chất lượng ngoài VMAF. Tất cả là **full-reference** (cần bản gốc làm tham chiếu) trừ nhóm no-reference ở 4.7.5. Mọi metric Y/U/V đều phải **scale 2 input về cùng resolution trước** — như lệnh VMAF ở 4.5.

**Keywords:** PSNR, SSIM, MS-SSIM, CIEDE2000, libvmaf feature flags, blend difference, blockdetect, blurdetect, signalstats, VQMT, SSIMULACRA2, no-reference metric, perceptual color difference.

#### 4.7.1 PSNR — metric lâu đời nhất (lệch pixel thuần)
```bash
ffmpeg -i encoded.mp4 -i original.mp4 \
  -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]psnr=stats_file=psnr.log" -f null -
```
- `psnr=stats_file=psnr.log` → ghi **PSNR từng frame** (cột `psnr_avg`, `psnr_y/u/v`); bỏ `stats_file` thì chỉ in trung bình cuối.
- Thang **~30–50 dB**: <30 kém, ~40 tốt, >45 gần như vô hình. `psnr_y` (luma) đáng nhìn nhất vì mắt nhạy độ sáng hơn màu.
- **By-design pitfall:** chỉ đo lệch pixel, **không hiểu cảm nhận mắt người** → frame mờ đều có thể PSNR cao mà nhìn tệ; nhiễu hạt nhẹ PSNR thấp mà nhìn ổn. Chính điểm yếu này khiến Netflix bỏ PSNR để làm VMAF (2016) — xem 4.1.

#### 4.7.2 SSIM / MS-SSIM — đo cấu trúc (vá điểm yếu PSNR, 2004)
```bash
ffmpeg -i encoded.mp4 -i original.mp4 \
  -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]ssim=stats_file=ssim.log" -f null -
```
- Thang **0–1**. Mốc thực dụng: **SSIM ≥ 0.95 ≈ VMAF 93** (xem 4.3②) → "gần như không phân biệt với gốc".
- FFmpeg filter `ssim` là **single-scale**. **MS-SSIM** (multi-scale, sát mắt người hơn) FFmpeg native chưa có → dùng `libvmaf` feature flag (4.7.3) hoặc VQMT.

#### 4.7.3 ⭐ Gọn nhất: libvmaf xuất PSNR + SSIM + CIEDE2000 cùng một pass
Đã có lệnh VMAF rồi thì **không cần chạy 3 lệnh riêng** — bật thêm "feature":
```bash
ffmpeg -i encoded.mp4 -i original.mp4 \
  -lavfi "[0:v]scale=1920:1080[enc];[enc][1:v]libvmaf=feature=name=psnr|name=float_ssim|name=ciede:log_path=vmaf.json:log_fmt=json" \
  -f null -
```
- `feature=name=psnr|name=float_ssim|name=ciede` → đo thêm **PSNR**, **SSIM**, **CIEDE2000** (sai lệch **màu sắc** mà PSNR/SSIM trên luma bỏ sót) trong cùng pass.
- `log_path=vmaf.json:log_fmt=json` → JSON per-frame, dễ parse để vẽ chart / tìm frame tệ nhất (scene tối nhiều noise).
- **Khuyến nghị cho pipeline dự án:** một lệnh ra full bộ metric, gắn vào `VideoStatus` cùng lúc với `encodeDuration`.
- [TODO: cần xác minh] Cú pháp `feature=name=...` đúng với libvmaf ≥ v2.x (FFmpeg ≥ 5.1). Bản cũ dùng key `psnr=1:ssim=1:ms_ssim=1`. Kiểm: `ffmpeg -h filter=libvmaf`.

#### 4.7.4 So sánh trực quan (mắt người, không phải số) — blend=difference
```bash
# Ảnh hiệu số: chỗ sáng = nơi encode lệch gốc nhiều nhất
ffmpeg -i original.mp4 -i encoded.mp4 \
  -lavfi "[1:v]scale=1920:1080[enc];[0:v][enc]blend=all_mode=difference,eq=contrast=4" \
  diff.mp4
```
- `blend=all_mode=difference` → mỗi pixel = |gốc − encode|. Vùng đen = giống hệt; vùng sáng = banding/blocking/mất chi tiết.
- `eq=contrast=4` → khuếch đại sai số nhỏ; rất hợp để bắt **banding ở vùng gradient** (trời, tường) mà metric trung bình hay bỏ sót.

#### 4.7.5 No-reference (không cần gốc) — khi chỉ còn bản encode
- `signalstats` → thống kê YUV/độ sáng từng frame (phát hiện frame đen, clip trắng).
- `blockdetect`, `blurdetect` (FFmpeg ≥ 5.0) → ước lượng mức block/mờ **không cần gốc**. Hữu ích khi mezzanine đã xóa, chỉ còn rendition trên storage node.

#### 4.7.6 Ngoài FFmpeg (chuyên sâu / báo cáo)
| Công cụ | Khi nào dùng |
|---|---|
| **Netflix VQMT** (vmaf repo) | Batch nhiều rendition, xuất CSV/biểu đồ chuẩn, chính chủ VMAF |
| **SSIMULACRA2** | Metric mới (2023) bám cảm nhận tốt cho ảnh/banding; per-frame |
| **MSU VQMT** | GUI, MS-SSIM/VQM, khi cần báo cáo trực quan |

#### 4.7.7 Tóm tắt thực dụng
- **Nhanh & đủ:** `libvmaf` + `feature=` ra **VMAF + PSNR + SSIM + CIEDE** trong 1 pass → đừng chạy 3 lệnh.
- **VMAF** quyết định bitrate ladder; **PSNR/SSIM** cross-check, lòi ra điểm bất thường (VMAF cao giả do hack contrast — xem 4.6 — thì PSNR sẽ tố).
- **`blend=difference`** khi cần mắt người xác nhận artifact cụ thể.

### Nguồn (mục 4.7)
- FFmpeg `psnr` filter: https://ffmpeg.org/ffmpeg-filters.html#psnr
- FFmpeg `ssim` filter: https://ffmpeg.org/ffmpeg-filters.html#ssim
- FFmpeg `libvmaf` (feature flags): https://ffmpeg.org/ffmpeg-filters.html#libvmaf
- FFmpeg `blend` (difference mode): https://ffmpeg.org/ffmpeg-filters.html#blend-1
- Netflix VQMT: https://github.com/Netflix/vmaf — SSIMULACRA2: https://github.com/cloudinary/ssimulacra2
- SSIM gốc (Wang 2004): https://www.cns.nyu.edu/pub/eero/wang03-reprint.pdf

---

## Changelog
- **2026-06-14** — Thêm mục **4.7 "Các metric khác ngoài VMAF"** (PSNR, SSIM/MS-SSIM, libvmaf feature flags ra PSNR+SSIM+CIEDE 1 pass, visual diff `blend=difference`, no-reference `blockdetect/blurdetect`, công cụ ngoài FFmpeg). Giữ nguyên mục 4 (VMAF). Nguồn: FFmpeg filter docs (psnr/ssim/libvmaf/blend), Netflix VQMT, SSIMULACRA2, Wang 2004.

---
