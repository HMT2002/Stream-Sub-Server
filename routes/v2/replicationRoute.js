const express = require('express');
const replicationContract = require('../../middleware/replicationContract');
const replicationV2Controller = require('../../controllers/replicationV2Controller');
const { uploadReplicatedFile } = require('../../modules/multerAPI');
const router = express.Router();
router.post('/send-folder', replicationV2Controller.sendFolder);
router.post('/receive-file', replicationContract, uploadReplicatedFile, replicationV2Controller.receiveFile);
module.exports = router;
