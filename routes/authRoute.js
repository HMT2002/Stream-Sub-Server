const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

//ROUTE HANDLER

// Endpoint cho nginx `auth_request` — GIỮ ĐƯỜNG DẪN NÀY ỔN ĐỊNH, nó được hardcode
// trong streamingVer3 (`proxy_pass http://node_app_9100/api/auth/verify;`).
// Đổi path ở đây mà quên đổi bên nginx -> subrequest nhận 404 -> nginx dịch
// thành 500 -> chặn sạch mọi video, trong khi `nginx -t` vẫn PASS.
// Đăng ký cả HEAD để test tay bằng `curl -I` cho tiện (nginx luôn gửi GET).
router.route('/verify').get(authController.AuthRequest).head(authController.AuthRequest);

// Quan sát trước khi siết: xem tỉ lệ sẽ bị chặn khi AUTH_MODE=log.
router.route('/stats').get(authController.AuthStats);

// Route cũ — kiểm tra token bằng middleware protect (dùng cho client gọi thẳng Node).
router.route('/check-token').get(authController.protect, authController.Check);

module.exports = router;
