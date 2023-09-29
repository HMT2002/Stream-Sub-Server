const express = require('express');
const fs = require('fs');
const replicateController = require('../controllers/replicateController');

const { upload, uploadVideo, uploadImage,uploadMultipartFile ,uploadMultipartFileChunk} = require('../modules/multerAPI.js');
const router = express.Router();

//ROUTE HANDLER
router.route('/receive/:filename').post(uploadMultipartFileChunk,replicateController.ReceiveFileFromOtherNode,replicateController.ConcateRequestNEXT);
router.route('/send/:filename').get(replicateController.SendFileToOtherNode);
router.route('/concate/:filename').post(replicateController.ConcateRequest);

module.exports = router;
