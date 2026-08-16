# Annotate lệnh encode (line-by-line) — 3 mốc tiến hóa của pipeline

> **File này là gì:** chú thích **từng dòng** 3 lệnh encode đã dùng trong dự án, để tra nhanh
> "dòng này làm gì". Đây là **nguyên liệu thô**; phân tích đầy đủ (vì sao đúng/sai, đối chiếu
> source) nằm ở [ffmpeg-hevc-dash-streaming-notes.md](ffmpeg-hevc-dash-streaming-notes.md).
> Verify & so sánh chất lượng output: [init_compare_output.md](init_compare_output.md).
>
> | | Nội dung | Trạng thái |
> |---|---|---|
> | **COMMAND 1** | Pipe 2 lệnh HEVC→DASH (bản đầu) | ⚠️ **[SUPERSEDED]** — "H.264 trá hình" + double-encode, đã bỏ. Xem [notes §10](ffmpeg-hevc-dash-streaming-notes.md). Giữ lại để học lỗi. |
> | **COMMAND 4** | H.264 1 lệnh, 3 luồng, AQ+lookahead+multipass | ✅ Bản **đang dùng** cho web (dash.js phát được). = [notes §15.1](ffmpeg-hevc-dash-streaming-notes.md) |
> | **COMMAND 5** | HEVC 1 lệnh, cùng tham số để so chất lượng | 🔬 Chỉ để **so offline** (mpv/VMAF); HEVC **không** lên web dash.js. = [notes §15.2](ffmpeg-hevc-dash-streaming-notes.md) |
>
> **Lưu ý đọc các `# ⚠️` bên dưới:** đó là các option **không có tác dụng với NVENC** (vd
> `-b_strategy`, `-sc_threshold` là của libx264) hoặc **mâu thuẫn cấu hình** (vd `-profile:v:0 1`
> = main10 chứ không phải main). Đối chiếu đã verify: [notes §3.4 + §9](ffmpeg-hevc-dash-streaming-notes.md).

---

## COMMAND 1 — Pipe HEVC→DASH (BẢN CŨ, [SUPERSEDED] — giữ để tham chiếu)

```bash
ffmpeg -i videos/IjTyvFk.mp4 \   # input file nguồn (decode bằng CPU - KHÔNG có -hwaccel cuda)
  -c:v hevc_nvenc \              # video codec: HEVC encode bằng GPU NVIDIA (NVENC)
  -c:a aac \                     # audio codec: AAC
  -b:a 128k \                    # audio bitrate 128 kbps
  -preset 4 \                    # ⚠️ preset SỐ (=hp, high-performance). Bị ghi đè bởi -preset p4 phía dưới
  -bf 1 \                        # tối đa 1 B-frame (giữ thấp cho ABR switching ổn định)
  -b_strategy 0 \                # ⚠️ option của libx264, NVENC bỏ qua. Ý định: tắt adaptive B-frame
  -sc_threshold 0 \              # ⚠️ option của libx264, NVENC bỏ qua. Ý định: tắt scene-cut keyframe
  -pix_fmt yuv420p \             # pixel format 8-bit 4:2:0 (tương thích rộng nhất)
  -preset p4 \                   # preset NVENC mới (p1 nhanh→p7 chậm/đẹp). Đây mới là preset có hiệu lực
  -rc vbr \                      # rate control: variable bitrate
  -threads 3 \                   # giới hạn 3 thread CPU (chủ yếu ảnh hưởng decode/mux, không phải NVENC core)
  -g 120 \                       # GOP size: keyframe tối đa mỗi 120 frame
  -keyint_min 120 \              # khoảng cách keyframe tối thiểu = 120 (ép GOP cố định)
  -force_key_frames "expr:gte(t,n_forced*3)" \   # ép keyframe mỗi 3 giây (cho segment alignment)

  -map 0:v:0 -map 0:a:0 \        # output stream 0 = video rendition 0 + audio
  -map 0:v:0 \                   # output stream 2 = video rendition 1
  -map 0:v:0 \                   # output stream 3 = video rendition 2
  -map 0:v:0 \                   # output stream 4 = video rendition 3  ← TỔNG 4 video

  -b:v:0 300k  -s:v:0 720x480   -profile:v:0 1 \   # rendition 0: 300k, 480p, profile=main10(10-bit)
  -b:v:1 700k  -s:v:1 1080x720  -profile:v:1 1 \   # rendition 1: 700k, 720p, profile=main10
  -b:v:2 1300k -s:v:2 1920x1080 -profile:v:2 2 \   # rendition 2: 1300k, 1080p, profile=rext
  -b:v:3 2500k                  -profile:v:3 2 \   # rendition 3: 2500k, KHÔNG có -s → giữ res gốc, profile=rext
  -f mpegts - | \                # output stage 1 ra stdout dạng MPEG-TS

ffmpeg -i - \                    # stage 2: đọc MPEG-TS từ stdin
  -map 0 \                       # map tất cả stream từ pipe
  -use_timeline 1 \              # dùng SegmentTimeline trong MPD
  -single_file 0 \               # mỗi segment 1 file riêng (không gộp)
  -use_template 1 \              # dùng SegmentTemplate (MPD gọn)
  -seg_duration 10 \             # ⚠️ segment 10s nhưng keyframe ép mỗi 3s → KHÔNG chia hết
  -adaptation_sets "id=0,streams=v id=1,streams=a" \   # nhóm video riêng, audio riêng
  -init_seg_name init_$RepresentationID$.m4s \
  -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s \
  -f dash videos/XXXX/init.mpd   # xuất MPD + segment vào thư mục videos/XXXX/
```

---

## COMMAND 4 — H.264 1 lệnh (✅ BẢN ĐANG DÙNG cho web)

```bash
ffmpeg -i videos/IjTyvFk.mp4 \                         # input nguồn (decode CPU — tránh lỗi trộn format cuda)
  -filter_complex "\
    [0:v]split=3[v0][v1][v2]; \                        # tách 3 nhánh có label rõ ràng (tránh mất stream khi 1 lệnh)
    [v0]scale=720:480[s0]; \                            # nhánh 0 → 480p (scale CPU)
    [v1]scale=1280:720[s1]" \                           # nhánh 1 → 720p; v2 KHÔNG scale → giữ res gốc (cùng format CPU nên không lỗi)
  -map "[s0]" -map "[s1]" -map "[v2]" -map 0:a:0 \     # 3 video (480p, 720p, gốc) + 1 audio
  -c:v h264_nvenc \                                     # video codec: H.264 hardware (dash.js phát được)
  -c:a aac -b:a 128k \                                  # audio AAC 128k
  -preset p6 -tune hq \                                 # preset cân bằng chất lượng (p6 hơn p4, gần p7 nhưng nhẹ hơn); tune hq cho VOD
  -rc vbr \                                             # rate control: variable bitrate
  -rc-lookahead 32 \                                    # phân tích 32 frame tới → phân bổ bit tốt hơn, giảm vỡ
  -multipass qres \                                     # 2-pass quarter-res → rate control chính xác hơn ở scene phức tạp
  -spatial-aq 1 -temporal-aq 1 -aq-strength 8 \         # AQ: dồn bit vào vùng chi tiết/tĩnh → giảm blocking (điểm chống vỡ chính)
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
  -init_seg_name init_\$RepresentationID\$.m4s \        # tên init segment
  -media_seg_name chunk_\$RepresentationID\$_\$Number%05d\$.m4s \   # tên media segment
  -f dash videos/XXXX_h264/init.mpd                     # xuất ra thư mục riêng cho H.264
```

---

## COMMAND 5 — HEVC 1 lệnh (🔬 chỉ để SO chất lượng offline, không lên web)

```bash
ffmpeg -i videos/IjTyvFk.mp4 \                         # input nguồn (decode CPU — tránh lỗi trộn format cuda đã gặp)
  -filter_complex "\
    [0:v]split=3[v0][v1][v2]; \                        # tách 3 nhánh có label rõ ràng
    [v0]scale=720:480[s0]; \                            # nhánh 0 → 480p (scale CPU)
    [v1]scale=1280:720[s1]" \                           # nhánh 1 → 720p; v2 giữ res gốc
  -map "[s0]" -map "[s1]" -map "[v2]" -map 0:a:0 \     # 3 video (480p, 720p, gốc) + 1 audio
  -c:v hevc_nvenc \                                     # video codec: HEVC hardware (so với h264_nvenc)
  -c:a aac -b:a 128k \                                  # audio AAC 128k (giữ nguyên để so công bằng)
  -preset p6 -tune hq \                                 # preset cân bằng + tune hq (giống bản H.264)
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
  -init_seg_name init_\$RepresentationID\$.m4s \        # tên init segment
  -media_seg_name chunk_\$RepresentationID\$_\$Number%05d\$.m4s \   # tên media segment
  -f dash videos/XXXX_hevc/init.mpd                     # xuất ra thư mục RIÊNG để không đè bản H.264
```

---

## THUMBNAIL — hai bản, sinh cùng lúc với encode

> [UPDATED 2026-08-15] `modules/encodeAPI.js` sinh **hai** ảnh trước khi encode DASH.

| File | Kích thước ảnh | Dung lượng đo thật | Dùng ở đâu |
|---|---|---|---|
| `thumbnail.png` | frame nguyên kích thước (1280×720 – 1920×1080) | 227 KB – 2.8 MB | player hub (`infoPlaybackService.toImageServer`) |
| `thumb.webp` | 320×180 | **~3 KB** | bảng quản trị video (ô 54×34) |

```bash
# Bản nhỏ — chạy ngay sau thumbnail.png, trước khi encode DASH
ffmpeg -y   -ss 10 \                       # seek TRƯỚC -i => input seeking, nhảy thẳng, không decode từ đầu
  -i <input>   -frames:v 1 \                  # lấy đúng 1 frame
  -an \                          # bỏ audio: muxer ảnh không nhận stream audio
  -vf scale=320:-2 \             # rộng 320, cao tự tính theo tỉ lệ gốc, làm tròn CHẴN
  -c:v libwebp \                 # khai tường minh để lỗi lộ rõ khi build ffmpeg thiếu libwebp
  -quality 80 \                  # thang 0-100 của libwebp (KHÁC -qscale của MJPEG)
  <folder>/thumb.webp
```

### Vì sao `scale=320:-2` chứ không phải `scale=320:180`

`-2` = tự tính chiều cao theo đúng tỉ lệ gốc rồi làm tròn về số chẵn (yêu cầu của hầu hết
encoder). Video 16:9 cho ra đúng **320×180**; video tỉ lệ khác không bị bóp méo.

Không dùng `pad` để ép đủ 320×180: frontend đã `object-fit: cover`, nướng viền đen vào file là
mất dữ liệu vĩnh viễn và không lấy lại được.

### Vì sao KHÔNG gộp hai ảnh vào một lệnh ffmpeg

Một lệnh hai output sẽ chỉ decode một lần — nhanh hơn. Nhưng nếu bản ffmpeg trên node **thiếu
libwebp** thì cả lệnh hỏng, kéo theo **toàn bộ encode DASH** chết theo. Đổi vài chục ms lấy rủi
ro mất cả pipeline là không đáng.

### Chuỗi lệnh và luật "được phép thất bại"

```
thumbnail.png && (thumb.webp || echo skipped) && encode DASH
```

- `||` chạy được ở **cả `cmd.exe` lẫn `/bin/sh`**, nên không phải rẽ nhánh theo
  `process.platform`. (`&` thì **không** portable: cmd.exe hiểu là "chạy tiếp", sh hiểu là
  "chạy nền".)
- Nhánh `echo` luôn trả exit code 0 → chuỗi đi tiếp tới encode DASH.

Điều này quan trọng vì `encodeIntoDashVer4` chỉ coi là thành công khi `close` trả `code === 0`.
Nếu để bản nhỏ làm hỏng exit code thì một node thiếu libwebp sẽ báo **mọi** lần encode là thất
bại, dù segment DASH đã ghi đủ.

Đặt bản nhỏ **ngay sau** `thumbnail.png` (không phải cuối chuỗi) để nó có mặt sớm, thay vì phải
chờ hết encode DASH vốn có thể mất hàng chục phút.

### Ghi chú: `-qscale:v 2` ở lệnh `thumbnail.png` không có tác dụng

`-qscale` chỉ áp cho MJPEG/JPEG; PNG là nén **không mất dữ liệu** nên tham số này bị bỏ qua.
Đây là lý do file PNG lớn như vậy. Giữ nguyên lệnh cũ vì đổi nó sẽ đổi kích thước của artifact
mà player hub đang dùng — muốn sửa thì phải đo lại phía player trước.

### Video encode trước 2026-08-15

Chỉ có `thumbnail.png`. Frontend thử `thumb.webp` trước, `404` thì lùi về `thumbnail.png`, nên
không cần backfill; muốn có bản nhỏ cho video cũ thì chạy lại đúng lệnh trên cho từng thư mục.

---

## Changelog
- **2026-06-20** — Thêm header ngữ cảnh + bảng 3 mốc (COMMAND 1 cũ/4 đang dùng/5 so offline);
  đóng khung code từng lệnh cho dễ đọc; gắn link chéo tới
  [ffmpeg-hevc-dash-streaming-notes.md](ffmpeg-hevc-dash-streaming-notes.md) (phân tích đầy đủ)
  và [init_compare_output.md](init_compare_output.md) (verify/so sánh). Giữ nguyên 100% nội dung
  annotate gốc.
- **2026-08-15** — Thêm mục *THUMBNAIL — hai bản*: encode giờ sinh thêm `thumb.webp` 320×180
  (~3 KB, nhỏ hơn bản PNG 70–900 lần) cho bảng quản trị. Ghi rõ lý do `scale=320:-2` thay vì
  `pad`, lý do không gộp hai ảnh vào một lệnh ffmpeg (thiếu libwebp sẽ giết cả pipeline DASH),
  luật `||` cho phép bản nhỏ thất bại mà không làm hỏng exit code, và ghi chú `-qscale:v 2` ở
  lệnh PNG là no-op. Giữ nguyên toàn bộ nội dung cũ.
