const express = require('express');
const replicateController = require('../controllers/replicateController');

const { upload, uploadVideo, uploadImage,uploadMultipartFile ,uploadMultipartFileChunk,uploadFolderFile} = require('../modules/multerAPI.js');
const router = express.Router();

//ROUTE HANDLER
router.route('/receive').post(uploadMultipartFileChunk,replicateController.ReceiveFileFromOtherNode);
router.route('/send').post(replicateController.SendFileToOtherNode);
router.route('/concate').post(replicateController.ConcateRequest);

router.route('/receive-folder').post(uploadFolderFile,replicateController.ReceiveFolderFileFromOtherNode);
router.route('/send-folder').post(replicateController.SendFolderFileToOtherNode);
router.route('/concate-folder').post(replicateController.ConcateFolderRequest);

module.exports = router;
