const express = require('express');
const defaultController = require('../controllers/defaultController');

const router = express.Router();

//ROUTE HANDLER
router.route('/check/alive/is-this-alive').get(defaultController.CheckIfThisServerIsFckingAlive);

// Đọc bộ đếm route v1 — cơ sở để quyết định xoá code legacy (Phase 3).
router.route('/legacy-usage').get(defaultController.LegacyUsage);

// Có ai còn xin media thẳng từ Node (bỏ qua nginx) không.
router.route('/data-plane').get(defaultController.DataPlaneStatus);

// Hàng đợi encode + trạng thái từng job trên node này.
router.route('/encode-jobs').get(defaultController.EncodeJobs);

// Chữ ký node-to-node: đọc trước khi bật NODE_AUTH_MODE=enforce.
router.route('/node-auth').get(defaultController.NodeAuthStatus);
router.route('/check/hls/:filename').get(defaultController.CheckHlsFile);
router.route('/check/dash/:filename').get(defaultController.CheckDashFile);

// router.route('/check/hls/:filename').post(defaultController.CheckHlsFile);
// router.route('/check/dash/:filename').post(defaultController.CheckDashFile);

module.exports = router;
