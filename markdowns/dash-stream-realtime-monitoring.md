# Giám sát số liệu DASH Stream Real-time

**Created:** 2026-06-07
**Status:** Active
**Scope:** Theo dõi số liệu real-time của một luồng DASH `.mpd` đang chạy (đã có URL, đã kết nối server)
**Related files:** `FFmpeg_DASH_Streaming_Knowledge_Base.md` (tập trung *encoding/tạo* stream), `NGINX_FFmpeg_DASH_Streaming.md` (server-side)

> File này tập trung vào **giám sát/monitoring** một stream đã chạy, KHÁC với các file kia tập trung vào *tạo* stream.

---

## 1. Bối cảnh / Vấn đề

Đã có luồng DASH `.mpd` chạy được, kết nối được server, có URL. Mục tiêu: xem số liệu streaming **real-time**. Có 3 hướng tiếp cận, mỗi hướng cho một loại số liệu khác nhau.

| Hướng | Công cụ | Số liệu thu được | Mức real-time |
|-------|---------|------------------|---------------|
| Client/player | dash.js, chrome://media-internals | buffer, ABR switch, dropped frames, latency | Cao (đúng trải nghiệm người xem) |
| Xử lý stream | ffmpeg, ffprobe | bitrate thực, fps, frame drop | Trung bình (1 representation, không ABR) |
| Server/CDN | NGINX log, GoAccess | request, segment, lỗi 4xx/5xx | Cao (phía hệ thống) |

---

## 2. Cách 1 — ffmpeg / ffprobe

### ffprobe — kiểm tra cấu trúc manifest (chạy 1 lần rồi thoát)

```bash
ffprobe -v quiet -print_format json -show_format -show_streams \
  "http://your-server/stream.mpd"
```

Liệt kê các representation / adaptation set:

```bash
ffprobe -show_programs -i "http://your-server/stream.mpd"
```

### ffmpeg — đo throughput thực tế theo thời gian (gần real-time nhất)

```bash
# Decode nhanh hết sức, in bitrate/fps/speed liên tục
ffmpeg -i "http://your-server/stream.mpd" -f null - 2>&1

# Đọc đúng tốc độ phát (mô phỏng player)
ffmpeg -re -i "http://your-server/stream.mpd" -f null - 2>&1

# Output key=value dễ parse + ghi log
ffmpeg -i "http://your-server/stream.mpd" -progress pipe:1 -nostats \
  -f null - 2>ffmpeg.log
```

### Ý nghĩa option

| Option | Ý nghĩa |
|--------|---------|
| `-f null -` | Decode nhưng không ghi file, chỉ lấy số liệu xử lý |
| `-re` | Đọc input ở tốc độ native frame rate (mô phỏng realtime) |
| `-progress pipe:1` | Xuất tiến trình dạng `key=value` ra stdout |
| `-nostats` | Tắt dòng status mặc định cho output sạch |

### Trường status đọc được

- `bitrate=` — bitrate thực tế của dữ liệu đang xử lý
- `fps=` — khung hình/giây đang decode
- `speed=` — tốc độ so với realtime (`1x` = đúng tốc độ phát)
- `drop=` / `dup=` — frame rớt / nhân bản (dấu hiệu nghẽn)

### Hạn chế (by design)

- ffmpeg chọn **một** representation và **KHÔNG** chạy logic ABR như player thật → không phản ánh chuyển bitrate theo băng thông.
- ffprobe chỉ cho bitrate **khai báo trong manifest**, không phải throughput thực.

**Nguồn:** [ffmpeg.org/ffmpeg.html](https://ffmpeg.org/ffmpeg.html)

---

## 3. Cách 2 — Client / Player (số liệu đúng nghĩa nhất)

### dash.js reference player (DASH-IF — công cụ chính thống)

Mở https://reference.dashif.org/dash.js/ → dán URL `.mpd` → tab **Metrics**.

Số liệu real-time:
- Buffer level (giây dữ liệu đang đệm)
- Bitrate downloading / switching theo thời gian
- Throughput đo được
- Latency (quan trọng nếu live)
- Dropped frames

API lấy metric bằng code: `player.getDashMetrics()`, `getBufferLength()`.
- Docs: [dash.js wiki](https://github.com/Dash-Industry-Forum/dash.js/wiki), [API docs](https://cdn.dashjs.org/latest/jsdoc/)

### Chrome media-internals (decode stats trình duyệt)

`chrome://media-internals/` khi đang phát → dropped frames, decode timing, audio/video properties (số liệu decoder thật trong trình duyệt).

---

## 4. Cách 3 — Server / CDN

> Đường dẫn log mặc định NGINX là `/var/log/nginx/access.log`; nếu cấu hình đặt nơi khác thì đổi cho khớp.

### Theo dõi log realtime, lọc segment/manifest

```bash
tail -f /var/log/nginx/access.log | grep -E "\.mpd|\.m4s|\.ts"
```

### Đếm lỗi realtime (segment thiếu, timeout)

```bash
tail -f /var/log/nginx/access.log | grep -E " (404|499|5[0-9]{2}) "
```

### Thống kê nhanh status code

```bash
awk '{print $9}' /var/log/nginx/access.log | sort | uniq -c | sort -rn
```

### GoAccess — dashboard real-time

```bash
goaccess /var/log/nginx/access.log -o report.html --real-time-html
```

**Nguồn:** [goaccess.io](https://goaccess.io/), [goaccess.io/man](https://goaccess.io/man)

---

## 5. Tóm tắt lựa chọn theo mục tiêu

- Cần bitrate/fps nhanh gọn → **ffmpeg** (Cách 1)
- Cần hiểu trải nghiệm người xem + ABR → **dash.js metrics** (Cách 2, đáng tin nhất phía client)
- Cần biết tải/lỗi hệ thống → **NGINX log + GoAccess** (Cách 3)

---

## 6. Câu hỏi mở / Cần làm rõ

- Stream là **live** hay **VOD**? (ảnh hưởng metric latency)
- Player phía client: dash.js / ExoPlayer / app riêng? (chọn bộ metric phù hợp)

---

## Nguồn tham khảo

- FFmpeg docs: https://ffmpeg.org/ffmpeg.html
- dash.js reference player: https://reference.dashif.org/dash.js/
- dash.js wiki: https://github.com/Dash-Industry-Forum/dash.js/wiki
- GoAccess: https://goaccess.io/
