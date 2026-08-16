'use strict';

const express = require('express');
const uploadContract = require('../../middleware/uploadContract');
const requestTrace = require('../../middleware/requestTrace');
const uploadV2Controller = require('../../controllers/uploadV2Controller');
const { uploadContractChunk } = require('../../modules/multerAPI');

const router = express.Router();

// `requestTrace.resume` PHẢI nằm ngay sau multer: multer đọc body bằng stream
// event trên `req`, và AsyncLocalStorage không sống qua ranh giới đó — mọi thứ
// phía sau sẽ mất `requestId` nếu thiếu dòng này.
// Đo được: "before multer: trace-123" / "after multer: null".
// Chi tiết: middleware/requestTrace.js, phần `resume`.
router.post('/chunks', uploadContract, uploadContractChunk, requestTrace.resume, uploadV2Controller.receiveChunk);

// Central tra trạng thái encode khi callback `stream-encode-v1` chưa tới
// (Central restart, mạng đứt, endpoint callback chưa bật).
router.get('/jobs/:storageKey', uploadV2Controller.jobStatus);

module.exports = router;
