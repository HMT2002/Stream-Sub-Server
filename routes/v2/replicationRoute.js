'use strict';

const express = require('express');
const replicationContract = require('../../middleware/replicationContract');
const requestTrace = require('../../middleware/requestTrace');
const replicationV2Controller = require('../../controllers/replicationV2Controller');
const { uploadReplicatedFile } = require('../../modules/multerAPI');

const router = express.Router();

router.post('/send-folder', replicationV2Controller.sendFolder);

// `requestTrace.resume` sau multer — xem ghi chú ở `routes/v2/uploadRoute.js`.
// Ở đây còn quan trọng hơn: node ĐÍCH là chặng cuối của chuỗi
// Central → Sub nguồn → Sub đích, nên mất id ở đây là đứt trace đúng chỗ dữ
// liệu thật được ghi xuống đĩa.
router.post(
  '/receive-file',
  replicationContract,
  uploadReplicatedFile,
  requestTrace.resume,
  replicationV2Controller.receiveFile
);

module.exports = router;
