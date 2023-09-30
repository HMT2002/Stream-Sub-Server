const express = require('express');
const replicateController = require('../controllers/replicateController');

const { upload, uploadVideo, uploadImage,uploadMultipartFile ,uploadMultipartFileChunk} = require('../modules/multerAPI.js');
const router = express.Router();

//ROUTE HANDLER
router.route('/receive').post(uploadMultipartFileChunk,replicateController.ReceiveFileFromOtherNode);
router.route('/send').post(replicateController.SendFileToOtherNode);
router.route('/concate').post(replicateController.ConcateRequest);

module.exports = router;
