'use strict';

// =============================================================================
// dashCommand — DỰNG chuỗi lệnh FFmpeg. Không chạy gì cả.
//
// -----------------------------------------------------------------------------
// Vì sao tách ra khỏi modules/encodeAPI.js
// -----------------------------------------------------------------------------
// `encodeAPI.js` dài 1525 dòng và trộn ba việc: dựng lệnh, spawn tiến trình, và
// năm hàm encode gần trùng nhau. Hàm dựng lệnh vốn ĐÃ THUẦN — chuỗi vào, chuỗi
// ra, không fs, không spawn — nhưng nằm trong file đó thì không test được nếu
// không kéo theo cả `child_process` lẫn `fluent-ffmpeg`.
//
// Đây là bước có giá trị cao nhất trên mỗi đơn vị rủi ro: nội dung hàm giữ
// NGUYÊN VĂN (tách bằng script, không gõ lại), nhưng giờ unit test được đúng
// phần dễ sai nhất của pipeline — quoting đường dẫn và thứ tự tham số ffmpeg.
//
// -----------------------------------------------------------------------------
// Tính an toàn của chuỗi lệnh
// -----------------------------------------------------------------------------
// Chuỗi trả về được chạy bằng `spawn(cmd, [], { shell: true })`, tức là ĐI QUA
// SHELL. `quotePath()` bên dưới chỉ từ chối dấu nháy kép; nó KHÔNG chặn backtick,
// `$` hay `;`. Tính an toàn hôm nay dựa vào việc `storageKey`/`extension` đã bị
// regex `^[a-zA-Z0-9._-]+$` lọc từ `middleware/uploadContract` — tức là bảo đảm
// nằm ở FILE KHÁC.
//
// `assertSafeCommandInput()` lặp lại kiểm tra đó NGAY TẠI ĐÂY, để tính an toàn
// trở thành tính chất CỤC BỘ của module thay vì một giả định về call site.
// (Bỏ hẳn shell là lựa chọn đúng hơn, nhưng phải viết lại luật `&&`/`||` của
// chuỗi thumbnail vốn đã được kiểm chứng trên cả cmd.exe lẫn /bin/sh — xem
// markdowns/encode_explain.md. Để Phase 2.)
//
// Annotate từng dòng của các lệnh: markdowns/encode_explain.md
// =============================================================================

const path = require('path');
const AppError = require('../utils/appError');

// Ký tự có nghĩa với cmd.exe hoặc /bin/sh. Một tên file chứa chúng mà lọt vào
// chuỗi lệnh là chạy lệnh khác ý muốn.
const SHELL_METACHARACTERS = /[`$;&|<>(){}\r\n"']/;

/**
 * Kiểm tra một THÀNH PHẦN TÊN (basename, tên thư mục) trước khi ghép vào chuỗi
 * shell.
 *
 * Cố ý chỉ soi phần tên chứ không soi cả đường dẫn tuyệt đối: trên Windows một
 * đường dẫn hợp lệ luôn chứa `:` và dấu gạch chéo ngược, còn phần do Central/
 * người dùng quyết định thì chỉ là tên file và tên thư mục.
 */
const assertSafeCommandInput = (value, field) => {
  const text = String(value === undefined || value === null ? '' : value);
  if (!text) throw new AppError(`${field} is required`, 400, 'IDENTITY_INVALID');
  if (SHELL_METACHARACTERS.test(text)) {
    throw new AppError(`${field} contains shell metacharacters`, 400, 'IDENTITY_INVALID');
  }
  return text;
};

/**
 * Tạo câu lệnh FFmpeg encode video thành MPEG-DASH.
 *
 * Các case được hỗ trợ:
 * - Case 4: H.264 NVENC, decode và scale bằng CUDA.
 * - Case 6: H.264 libx264, kích thước cố định.
 * - Case 7: H.264 NVENC, giữ đúng aspect ratio.
 * - Case 8: H.264 libx264, giữ đúng aspect ratio.
 *
 * @param {number} index Loại encoder cần sử dụng.
 * @param {string} filePath Đường dẫn video nguồn.
 * @param {string} outputFolder Thư mục chứa thumbnail.
 * @param {string} outputResult Đường dẫn file manifest .mpd.
 * @returns {string} Câu lệnh FFmpeg hoàn chỉnh.
 */
const buildParts = (index, filePath, outputFolder, outputResult) => {
  /**
   * Quote đường dẫn để xử lý khoảng trắng.
   *
   * Hàm này dùng được với:
   * - cmd.exe trên Windows.
   * - /bin/sh hoặc Bash trên Linux.
   *
   * Không cho phép dấu nháy kép bên trong đường dẫn để tránh tạo
   * câu lệnh shell không hợp lệ hoặc shell injection.
   */
  const quotePath = (value) => {
    const normalizedValue = String(value);

    if (normalizedValue.includes('"')) {
      throw new Error(`Đường dẫn không được chứa dấu nháy kép: ${normalizedValue}`);
    }

    return `"${normalizedValue}"`;
  };

  /**
   * Chuẩn hóa dấu phân cách thư mục.
   *
   * FFmpeg trên Windows hiểu được dấu "/", vì vậy dùng "/" giúp
   * việc nối đường dẫn hoạt động giống nhau trên cả hai hệ điều hành.
   */
  const normalizedOutputFolder = String(outputFolder).replace(/[\\/]+$/, '');

  // Đường dẫn ảnh thumbnail.
  const thumbnailPath = `${normalizedOutputFolder}/thumbnail.png`;

  // Bản nhỏ cho danh sách quản trị. Xem giải thích ở `smallThumbnailCommand`.
  const smallThumbnailPath = `${normalizedOutputFolder}/thumb.webp`;

  /**
   * Template tên initialization segment.
   *
   * Câu lệnh shell được tạo ra:
   *
   *   init_"$"RepresentationID"$".m4s
   *
   * Sau khi cmd.exe hoặc Bash phân tích, FFmpeg sẽ nhận:
   *
   *   init_$RepresentationID$.m4s
   *
   * Cách này không cần kiểm tra process.platform.
   */
  const dashInitSegmentName = 'init_"$"RepresentationID"$".m4s';

  /**
   * Template tên media segment.
   *
   * FFmpeg sẽ nhận:
   *
   *   chunk_$RepresentationID$_$Number%05d$.m4s
   */
  const dashMediaSegmentName = 'chunk_"$"RepresentationID"$"_"$"Number%05d"$".m4s';

  /**
   * Lệnh tạo thumbnail.
   *
   * Dùng "&&" thay cho "|" vì lệnh encode thứ hai không nhận
   * dữ liệu video từ stdout của lệnh tạo thumbnail.
   *
   * Với "&&", encode DASH chỉ bắt đầu khi thumbnail tạo thành công.
   */
  const thumbnailCommand = [
    'ffmpeg',
    '-y',
    '-ss 10',
    `-i ${quotePath(filePath)}`,
    '-qscale:v 2',
    '-frames:v 1',
    quotePath(thumbnailPath),
  ].join(' ');

  /**
   * Lệnh tạo thumbnail BẢN NHỎ (thumb.webp).
   *
   * VÌ SAO CẦN BẢN THỨ HAI:
   * `thumbnail.png` ở trên là frame NGUYÊN KÍCH THƯỚC - đo trên dữ liệu thật:
   * 1280x720 đến 1920x1080, nặng 227 KB đến 2.8 MB. Màn hình quản trị video
   * hiển thị nó trong ô 54x34 px, tức tải khoảng 350 lần số pixel cần thiết;
   * một trang 20 dòng có thể kéo về hàng chục MB.
   *
   * (`-qscale:v 2` ở lệnh trên KHÔNG có tác dụng: qscale chỉ áp cho MJPEG/JPEG,
   * còn PNG là nén không mất dữ liệu. Giữ nguyên vì đổi lệnh cũ sẽ đổi kích
   * thước của artifact mà player hub đang dùng.)
   *
   * `scale=320:-2`: cố định chiều rộng 320, chiều cao tự tính theo đúng tỉ lệ
   * gốc và làm tròn về số chẵn (yêu cầu của hầu hết encoder). Video 16:9 cho ra
   * đúng 320x180. KHÔNG dùng `pad` để ép đủ 320x180 vì frontend đã
   * `object-fit: cover` - nướng viền đen vào file là mất dữ liệu vĩnh viễn.
   *
   * KHÔNG gộp chung vào một lệnh ffmpeg hai output với `thumbnail.png`: nếu bản
   * ffmpeg trên node thiếu libwebp thì cả lệnh hỏng, kéo theo TOÀN BỘ encode
   * DASH chết theo. Tách riêng và cho phép thất bại (xem chỗ ghép lệnh).
   */
  const smallThumbnailCommand = [
    'ffmpeg',
    '-y',
    '-ss 10',
    `-i ${quotePath(filePath)}`,
    '-frames:v 1',
    '-an',
    '-vf scale=320:-2',
    '-c:v libwebp',
    '-quality 80',
    quotePath(smallThumbnailPath),
  ].join(' ');

  /**
   * Các tùy chọn DASH dùng chung.
   */
  const dashOptions = [
    // Tạo timeline trong MPD.
    '-use_timeline 1',

    // Dùng template để mô tả segment.
    '-use_template 1',

    // Xuất nhiều file segment riêng biệt.
    '-single_file 0',

    // Mỗi segment dài khoảng 4 giây.
    '-seg_duration 4',

    // Gom video và audio thành hai adaptation set.
    '-adaptation_sets "id=0,streams=v id=1,streams=a"',

    // Template tên initialization segment.
    `-init_seg_name ${dashInitSegmentName}`,

    // Template tên media segment.
    `-media_seg_name ${dashMediaSegmentName}`,

    // Chọn DASH muxer.
    '-f dash',

    // Đường dẫn file manifest đầu ra.
    quotePath(outputResult),
  ].join(' ');

  // Câu lệnh encode DASH sẽ được gán theo từng case.
  let dashEncodeCommand = '';

  switch (index) {
    case 4: {
      /**
       * Case 4:
       *
       * - Decode bằng NVIDIA CUDA.
       * - Scale bằng scale_cuda.
       * - Encode bằng h264_nvenc.
       *
       * Case này yêu cầu:
       * - NVIDIA GPU.
       * - NVIDIA driver.
       * - FFmpeg có cuda, scale_cuda và h264_nvenc.
       */
      dashEncodeCommand = [
        // Chương trình encode.
        'ffmpeg',

        // Ghi đè output nếu đã tồn tại.
        '-y',

        // Decode video bằng CUDA.
        '-hwaccel cuda',

        // Giữ frame trên GPU.
        '-hwaccel_output_format cuda',

        // Video nguồn.
        `-i ${quotePath(filePath)}`,

        // Tách video thành ba luồng và scale trên GPU.
        '-filter_complex ' +
          quotePath(
            '[0:v]split=3[v0][v1][v2];' +
              '[v0]scale_cuda=720:480[s0];' +
              '[v1]scale_cuda=1280:720[s1];' +
              '[v2]scale_cuda=1920:1080[s2]'
          ),

        // Map video 480p.
        '-map "[s0]"',

        // Map video 720p.
        '-map "[s1]"',

        // Map video 1080p.
        '-map "[s2]"',

        // Map audio đầu tiên.
        '-map 0:a:0',

        // Encode video bằng NVIDIA NVENC.
        '-c:v h264_nvenc',

        // Encode audio bằng AAC.
        '-c:a aac',

        // Bitrate audio.
        '-b:a 128k',

        // Variable bitrate.
        '-rc vbr',

        // Constant quality cho NVENC.
        '-cq 21',

        // Preset chất lượng cao.
        '-preset p6',

        // Số lượng B-frame.
        '-bf 3',

        // Cho phép B-frame làm reference.
        '-b_ref_mode middle',

        // Bật spatial adaptive quantization.
        '-spatial-aq 1',

        // Cường độ adaptive quantization.
        '-aq-strength 8',

        // Bật temporal adaptive quantization.
        '-temporal-aq 1',

        // Số frame lookahead.
        '-rc-lookahead 32',

        // Multipass quarter resolution.
        '-multipass qres',

        // GOP tối đa.
        '-g 120',

        // GOP tối thiểu.
        '-keyint_min 120',

        // Ép keyframe mỗi 2 giây.
        '-force_key_frames "expr:gte(t,n_forced*2)"',

        // Cấu hình video representation 0.
        '-b:v:0 450k',
        '-maxrate:v:0 675k',
        '-bufsize:v:0 900k',
        '-profile:v:0 main',

        // Cấu hình video representation 1.
        '-b:v:1 1000k',
        '-maxrate:v:1 1500k',
        '-bufsize:v:1 2000k',
        '-profile:v:1 main',

        // Cấu hình video representation 2.
        '-b:v:2 1900k',
        '-maxrate:v:2 2850k',
        '-bufsize:v:2 3800k',
        '-profile:v:2 high',

        // Tùy chọn xuất MPEG-DASH.
        dashOptions,
      ].join(' ');

      break;
    }

    case 6: {
      /**
       * Case 6:
       *
       * - Decode và scale bằng CPU.
       * - Encode bằng libx264.
       * - Xuất kích thước cố định.
       *
       * Case này không yêu cầu NVIDIA GPU.
       */
      dashEncodeCommand = [
        // Chương trình encode.
        'ffmpeg',

        // Ghi đè output nếu đã tồn tại.
        '-y',

        // Video nguồn.
        `-i ${quotePath(filePath)}`,

        // Tách video thành ba luồng và scale bằng CPU.
        '-filter_complex ' +
          quotePath(
            '[0:v]split=3[v0][v1][v2];' +
              '[v0]scale=720:480[s0];' +
              '[v1]scale=1280:720[s1];' +
              '[v2]scale=1920:1080[s2]'
          ),

        // Map video 480p.
        '-map "[s0]"',

        // Map video 720p.
        '-map "[s1]"',

        // Map video 1080p.
        '-map "[s2]"',

        // Map audio đầu tiên.
        '-map 0:a:0',

        // Encode video bằng phần mềm.
        '-c:v libx264',

        // Định dạng pixel tương thích trình duyệt.
        '-pix_fmt yuv420p',

        // Preset ưu tiên tốc độ.
        '-preset veryfast',

        // Cho FFmpeg tự chọn số thread.
        '-threads 0',

        // Số lượng B-frame.
        '-bf 3',

        // Encode audio bằng AAC.
        '-c:a aac',

        // Bitrate audio.
        '-b:a 128k',

        // GOP tối đa.
        '-g 120',

        // GOP tối thiểu.
        '-keyint_min 120',

        // Tắt tự động chèn keyframe khi đổi cảnh.
        '-sc_threshold 0',

        // Ép keyframe mỗi 2 giây.
        '-force_key_frames "expr:gte(t,n_forced*2)"',

        // Cấu hình video representation 0.
        '-b:v:0 450k',
        '-maxrate:v:0 675k',
        '-bufsize:v:0 900k',
        '-profile:v:0 main',

        // Cấu hình video representation 1.
        '-b:v:1 1000k',
        '-maxrate:v:1 1500k',
        '-bufsize:v:1 2000k',
        '-profile:v:1 main',

        // Cấu hình video representation 2.
        '-b:v:2 1900k',
        '-maxrate:v:2 2850k',
        '-bufsize:v:2 3800k',
        '-profile:v:2 high',

        // Tùy chọn xuất MPEG-DASH.
        dashOptions,
      ].join(' ');

      break;
    }

    case 7: {
      /**
       * Case 7:
       *
       * - Decode và resize bằng CPU.
       * - Encode bằng NVIDIA NVENC.
       * - Giữ đúng aspect ratio.
       * - Pad màu đen khi tỷ lệ video không khớp output.
       */
      dashEncodeCommand = [
        // Chương trình encode.
        'ffmpeg',

        // Ghi đè output nếu đã tồn tại.
        '-y',

        // Video nguồn.
        `-i ${quotePath(filePath)}`,

        // Chuẩn hóa aspect ratio, tạo ba kích thước và pad màu đen.
        '-filter_complex ' +
          quotePath(
            '[0:v]' +
              'scale=trunc(ih*dar/2)*2:trunc(ih/2)*2,' +
              'setsar=1,' +
              'split=3[v0][v1][v2];' +
              '[v0]' +
              'scale=640:360:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=640:360:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s0];' +
              '[v1]' +
              'scale=1280:720:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s1];' +
              '[v2]' +
              'scale=1920:1080:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s2]'
          ),

        // Map video 360p.
        '-map "[s0]"',

        // Map video 720p.
        '-map "[s1]"',

        // Map video 1080p.
        '-map "[s2]"',

        // Map audio đầu tiên.
        '-map 0:a:0',

        // Encode video bằng NVIDIA NVENC.
        '-c:v h264_nvenc',

        // Định dạng pixel tương thích trình duyệt.
        '-pix_fmt yuv420p',

        // Encode audio bằng AAC.
        '-c:a aac',

        // Bitrate audio.
        '-b:a 128k',

        // Variable bitrate.
        '-rc vbr',

        // Constant quality cho NVENC.
        '-cq 21',

        // Preset chất lượng cao.
        '-preset p6',

        // Số lượng B-frame.
        '-bf 3',

        // Cho phép B-frame làm reference.
        '-b_ref_mode middle',

        // Bật spatial adaptive quantization.
        '-spatial-aq 1',

        // Cường độ adaptive quantization.
        '-aq-strength 8',

        // Bật temporal adaptive quantization.
        '-temporal-aq 1',

        // Số frame lookahead.
        '-rc-lookahead 32',

        // Multipass quarter resolution.
        '-multipass qres',

        // GOP tối đa.
        '-g 120',

        // GOP tối thiểu.
        '-keyint_min 120',

        // Tắt tự động chèn keyframe khi đổi cảnh.
        '-sc_threshold 0',

        // Ép keyframe mỗi 2 giây.
        '-force_key_frames "expr:gte(t,n_forced*2)"',

        // Cấu hình video representation 0.
        '-b:v:0 450k',
        '-maxrate:v:0 675k',
        '-bufsize:v:0 900k',
        '-profile:v:0 main',

        // Cấu hình video representation 1.
        '-b:v:1 1000k',
        '-maxrate:v:1 1500k',
        '-bufsize:v:1 2000k',
        '-profile:v:1 main',

        // Cấu hình video representation 2.
        '-b:v:2 1900k',
        '-maxrate:v:2 2850k',
        '-bufsize:v:2 3800k',
        '-profile:v:2 high',

        // Tùy chọn xuất MPEG-DASH.
        dashOptions,
      ].join(' ');

      break;
    }

    case 8:
    default: {
      /**
       * Case 8:
       *
       * - Decode, resize và encode bằng CPU.
       * - Encode bằng libx264.
       * - Giữ đúng aspect ratio.
       * - Pad màu đen khi tỷ lệ video không khớp output.
       *
       * Đây cũng là case mặc định.
       */
      dashEncodeCommand = [
        // Chương trình encode.
        'ffmpeg',

        // Ghi đè output nếu đã tồn tại.
        '-y',

        // Video nguồn.
        `-i ${quotePath(filePath)}`,

        // Chuẩn hóa aspect ratio, tạo ba kích thước và pad màu đen.
        '-filter_complex ' +
          quotePath(
            '[0:v]' +
              'scale=trunc(ih*dar/2)*2:trunc(ih/2)*2,' +
              'setsar=1,' +
              'split=3[v0][v1][v2];' +
              '[v0]' +
              'scale=640:360:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=640:360:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s0];' +
              '[v1]' +
              'scale=1280:720:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s1];' +
              '[v2]' +
              'scale=1920:1080:' +
              'force_original_aspect_ratio=decrease:' +
              'force_divisible_by=2,' +
              'pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,' +
              'setsar=1[s2]'
          ),

        // Map video 360p.
        '-map "[s0]"',

        // Map video 720p.
        '-map "[s1]"',

        // Map video 1080p.
        '-map "[s2]"',

        // Map audio đầu tiên.
        '-map 0:a:0',

        // Encode video bằng phần mềm.
        '-c:v libx264',

        // Định dạng pixel tương thích trình duyệt.
        '-pix_fmt yuv420p',

        // Preset ưu tiên tốc độ.
        '-preset veryfast',

        // Cho FFmpeg tự chọn số thread.
        '-threads 0',

        // Số lượng B-frame.
        '-bf 3',

        // Encode audio bằng AAC.
        '-c:a aac',

        // Bitrate audio.
        '-b:a 128k',

        // GOP tối đa.
        '-g 120',

        // GOP tối thiểu.
        '-keyint_min 120',

        // Tắt tự động chèn keyframe khi đổi cảnh.
        '-sc_threshold 0',

        // Ép keyframe mỗi 2 giây.
        '-force_key_frames "expr:gte(t,n_forced*2)"',

        // Cấu hình video representation 0.
        '-b:v:0 450k',
        '-maxrate:v:0 675k',
        '-bufsize:v:0 900k',
        '-profile:v:0 main',

        // Cấu hình video representation 1.
        '-b:v:1 1000k',
        '-maxrate:v:1 1500k',
        '-bufsize:v:1 2000k',
        '-profile:v:1 main',

        // Cấu hình video representation 2.
        '-b:v:2 1900k',
        '-maxrate:v:2 2850k',
        '-bufsize:v:2 3800k',
        '-profile:v:2 high',

        // Tùy chọn xuất MPEG-DASH.
        dashOptions,
      ].join(' ');

      break;
    }
  }

  /**
   * Chạy tạo thumbnail trước.
   * Chỉ encode DASH khi thumbnail được tạo thành công.
   *
   * `(smallThumbnailCommand || echo ...)` - bản nhỏ được phép THẤT BẠI:
   *
   * - `||` chạy được ở CẢ cmd.exe LẪN /bin/sh, nên không phải rẽ nhánh theo
   *   `process.platform`. (`&` thì KHÔNG portable: cmd.exe hiểu là "chạy tiếp",
   *   còn sh hiểu là "chạy nền".)
   * - Nhánh `echo` luôn trả exit code 0, nên chuỗi lệnh đi tiếp tới encode DASH.
   *
   * Điều này quan trọng vì `encodeIntoDashVer4` chỉ coi là thành công khi
   * `close` trả `code === 0`. Nếu để bản nhỏ làm hỏng exit code thì một node
   * thiếu libwebp sẽ báo mọi lần encode là thất bại, dù segment DASH đã ghi đủ.
   *
   * Đặt bản nhỏ NGAY SAU thumbnail (không phải cuối chuỗi) để nó có mặt sớm,
   * thay vì phải chờ hết encode DASH vốn có thể mất hàng chục phút.
   */
  return { thumbnailCommand, smallThumbnailCommand, dashEncodeCommand };
};

/**
 * Chuỗi lệnh shell hoàn chỉnh — GIỮ NGUYÊN hình dạng cũ.
 *
 * @deprecated 2026-08-16 (Phase 3) — dùng `buildDashPlan()`, bản không đi qua
 * shell. Giữ lại vì `encodeIntoDash`/`Ver2`/`Ver3`/`_test` trong
 * `modules/encodeAPI.js` (các route v1) vẫn spawn bằng shell.
 * Xoá khi: những hàm đó vào `legacy/`.
 */
const encodeCommand = (index, filePath, outputFolder, outputResult) => {
  const parts = buildParts(index, filePath, outputFolder, outputResult);
  return `${parts.thumbnailCommand} && (${parts.smallThumbnailCommand} || echo [encode] thumb.webp skipped) && ${parts.dashEncodeCommand}`;
};

/**
 * Cửa vào khuyến nghị cho code mới: kiểm tra đầu vào rồi mới dựng lệnh.
 *
 * `encodeCommand()` giữ nguyên chữ ký cũ để 5 hàm encode trong `modules/encodeAPI.js`
 * không phải sửa. `buildDashCommand()` thêm hai thứ mà bản cũ thiếu:
 *
 *   1. Kiểm tra tên file/thư mục trước khi ghép vào chuỗi shell (xem đầu file).
 *   2. Từ chối `profile` không phải số.
 *
 * LƯU Ý VỀ `default:` — `switch` bên dưới cho `case 8` DÙNG CHUNG nhánh
 * `default:`. Nghĩa là một `ENCODE_TYPE` lạ (hoặc `NaN` do thiếu biến môi
 * trường) KHÔNG sinh ra lệnh rỗng như thoạt nhìn, mà lặng lẽ rơi vào **case 8 —
 * libx264, encode bằng CPU**. Trên node có GPU, đó là chạy chậm hơn nhiều lần
 * so với ý định (case 7 dùng NVENC) mà không có triệu chứng nào ngoài thời gian
 * encode; trên node không GPU thì lại đúng. Vì vậy `platform/config` vẫn coi
 * `ENCODE_TYPE` là biến bắt buộc: im lặng dùng nhầm encoder khó phát hiện hơn
 * là chết ngay lúc boot.
 *
 * Kiểm tra "chuỗi rỗng" bên dưới giữ lại làm lưới an toàn cho trường hợp ai đó
 * thêm `case` mới mà quên gán `dashEncodeCommand` — nó KHÔNG phải mô tả một lỗi
 * đang có.
 */
const buildDashCommand = ({ profile, sourceFile, mediaDir, manifestPath }) => {
  assertSafeCommandInput(path.basename(sourceFile), 'sourceFile');
  assertSafeCommandInput(path.basename(mediaDir), 'mediaDir');

  const index = Number(profile);
  if (!Number.isFinite(index)) {
    throw new AppError('ENCODE_TYPE không phải số', 500, 'ENCODE_START_FAILED');
  }

  const command = encodeCommand(index, sourceFile, mediaDir, manifestPath || `${mediaDir}/init.mpd`);

  if (!command || command.trim().endsWith('&&')) {
    throw new AppError(`ENCODE_TYPE=${index} không khớp case nào trong dashCommand`, 500, 'ENCODE_START_FAILED');
  }
  return command;
};

// =============================================================================
// [PHASE 3] Bỏ shell — chạy FFmpeg bằng argv thay vì một chuỗi qua shell
// =============================================================================
//
// Vì sao đáng làm: `spawn(cmd, [], { shell: true })` đưa cả chuỗi cho cmd.exe
// hoặc /bin/sh diễn giải. An toàn hiện tại phụ thuộc vào việc `storageKey` đã
// bị regex lọc từ middleware — tức là một bảo đảm ở TẦNG KHÁC. Với argv, shell
// không tồn tại trong đường chạy, nên câu hỏi "chuỗi này có thoát ra thành lệnh
// khác không" biến mất hoàn toàn thay vì được trả lời là "không, vì chỗ kia đã
// lọc".
//
// Vì sao TOKENIZE chứ không viết lại builder:
// Viết lại 650 dòng tham số FFmpeg thành mảng là chép tay hàng trăm cờ đã được
// kiểm chứng trên dữ liệu thật — rủi ro cao, lợi ích bằng không. Ở đây giữ
// NGUYÊN builder làm nguồn sự thật duy nhất, rồi tách chuỗi thành argv theo
// đúng luật mà shell sẽ dùng.
//
// Vì sao tokenizer này ĐỦ (không phải một shell thu nhỏ nửa vời):
// Chuỗi do chính `buildParts()` sinh ra, và nó chỉ dùng đúng MỘT cơ chế quoting
// là dấu nháy kép. Không có nháy đơn, không có escape `\\`, không có glob,
// không có biến môi trường — `quotePath()` từ chối `"` bên trong, và
// `assertSafeCommandInput()` từ chối mọi ký tự có nghĩa với shell. Vì vậy luật
// "tách theo khoảng trắng, nháy kép gộp thành một token" tái tạo CHÍNH XÁC
// những gì cmd.exe/sh sẽ truyền cho FFmpeg.
//
// Trường hợp tinh tế nhất, và cũng là lý do cách này đúng:
//     init_"$"RepresentationID"$".m4s   ->   init_$RepresentationID$.m4s
// Dấu nháy ở giữa token là để shell không nuốt `$`; bỏ nháy khi tokenize cho ra
// đúng chuỗi FFmpeg cần, giống hệt kết quả của shell.
// =============================================================================

/**
 * Tách chuỗi lệnh thành argv theo luật nháy kép.
 * Trả `[file, ...args]`.
 */
const tokenize = (command) => {
  const tokens = [];
  let current = '';
  let started = false; // phân biệt token rỗng có chủ đích ("") với chưa có token
  let inQuotes = false;

  for (const character of String(command)) {
    if (character === '"') {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (character === ' ' || character === '\t')) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
};

const toStep = (name, command, optional) => {
  const argv = tokenize(command);
  return { name, file: argv[0], args: argv.slice(1), optional: Boolean(optional) };
};

/**
 * Kế hoạch encode: ba bước tuần tự, KHÔNG qua shell.
 *
 * `optional: true` thay cho `|| echo ...` của bản shell. Luật giữ nguyên: bản
 * `thumb.webp` được phép thất bại (node thiếu libwebp) mà không kéo theo cả
 * encode DASH — xem markdowns/encode_explain.md.
 */
const buildDashPlan = ({ profile, sourceFile, mediaDir, manifestPath }) => {
  assertSafeCommandInput(path.basename(sourceFile), 'sourceFile');
  assertSafeCommandInput(path.basename(mediaDir), 'mediaDir');

  const index = Number(profile);
  if (!Number.isFinite(index)) throw new AppError('ENCODE_TYPE không phải số', 500, 'ENCODE_START_FAILED');

  const parts = buildParts(index, sourceFile, mediaDir, manifestPath || `${mediaDir}/init.mpd`);
  if (!parts.dashEncodeCommand) {
    throw new AppError(`ENCODE_TYPE=${index} không dựng được lệnh DASH`, 500, 'ENCODE_START_FAILED');
  }

  return {
    profile: index,
    steps: [
      toStep('thumbnail.png', parts.thumbnailCommand, false),
      toStep('thumb.webp', parts.smallThumbnailCommand, true),
      toStep('dash', parts.dashEncodeCommand, false),
    ],
  };
};

module.exports = Object.freeze({
  SHELL_METACHARACTERS,
  assertSafeCommandInput,
  buildParts,
  encodeCommand,
  buildDashCommand,
  tokenize,
  buildDashPlan,
});
