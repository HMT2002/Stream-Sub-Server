const express = require('express');
const replicateController = require('../controllers/replicateController');

const { upload, uploadVideo, uploadImage,uploadMultipartFile ,uploadMultipartFileChunk,uploadFolderFile} = require('../modules/multerAPI.js');
const router = express.Router();

//ROUTE HANDLER
router.route('/receive').post(replicateController.CheckFileBeforeReceive, uploadMultipartFileChunk,replicateController.ReceiveFileFromOtherNode);
router.route('/send').post(replicateController.SendFileToOtherNode);
router.route('/concate').post(replicateController.ConcateRequest);
router.route('/concate-hls').post(replicateController.ConcateAndEncodeToHlsRequest);
router.route('/concate-dash').post(replicateController.ConcateAndEncodeToDashRequest);


router.route('/receive-folder').post(replicateController.CheckFolderBeforeReceive, uploadFolderFile,replicateController.ReceiveFolderFileFromOtherNode);
router.route('/send-folder').post(replicateController.SendFolderFileToOtherNode);

module.exports = router;
