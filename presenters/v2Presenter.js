'use strict';

// =============================================================================
// v2Presenter — NƠI DUY NHẤT biết hình dạng envelope v2.
//
// Đặt tên và vị trí theo `Stream-Central-Server/backend/presenters/` để hai repo
// đọc giống nhau.
//
// -----------------------------------------------------------------------------
// Vì sao cần một tầng riêng cho việc "gói response"
// -----------------------------------------------------------------------------
// Trước đây mỗi controller tự `res.status(202).json({ok:true, data:{...}})`. Chỉ
// hai controller mà đã có hai cách gắn `contractVersion` khác nhau. Khi thêm
// endpoint thứ ba, xác suất lệch là gần như chắc chắn — và Central kiểm envelope
// khá chặt (`nodeClient.buildResult` coi `ok:false` kèm HTTP 200 là thất bại
// nghiệp vụ), nên lệch envelope là lỗi im lặng ở phía bên kia.
//
// Nhánh LỖI KHÔNG nằm ở đây: nó thuộc `controllers/errorController.js`, vì lỗi
// có thể phát sinh ở bất kỳ tầng nào và phải đi qua đúng một cửa.
//
// KHÔNG dùng cho data plane: `/api/auth/verify` bị nginx vứt body (auth_request
// là subrequest header-only), còn `*.m4s`/`*.mpd` trả bytes. Gói JSON ở đó là
// vừa vô dụng vừa tốn.
// =============================================================================

const ok = (res, data, status = 200) => res.status(status).json({ ok: true, data });

// 201 Created — đã tạo ra một tài nguyên mới có thể trỏ tới được.
// Dùng cho: nhận xong một file replication, tạo một block.
const created = (res, data) => ok(res, data, 201);

// 202 Accepted — đã nhận, xử lý CHƯA xong và có thể chưa xong khi response về.
// Dùng cho: nhận chunk, nhận job encode. Đây là điểm dễ hiểu nhầm nhất của
// contract v2: `202` KHÔNG có nghĩa là FFmpeg đã chạy xong.
const accepted = (res, data) => ok(res, data, 202);

// Gắn `contractVersion` vào data một cách nhất quán, thay vì mỗi controller tự
// nhớ. Central dùng nó để biết đang nói chuyện với thế hệ Sub nào.
const withContract = (contractVersion, data) => ({ contractVersion, ...data });

module.exports = Object.freeze({ ok, created, accepted, withContract });
