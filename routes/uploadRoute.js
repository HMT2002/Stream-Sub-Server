const express = require('express');
const uploadController = require('../controllers/uploadController.js');

const {
  upload,
  uploadVideo,
  uploadImage,
  uploadMultipartFile,
  uploadMultipartFileChunk,
  uploadFolderFile,
  uploadMultipartFileChunkV2,
  uploadIndividualFile,
} = require('../modules/multerAPI.js');
const router = express.Router();

//ROUTE HANDLER

router
  .route('/file')
  .post(
    uploadController.CheckFileBeforeReceive,
    uploadIndividualFile,
    uploadController.ReceiveIndividualFileFromOtherNode
  );
router
  .route('/')
  .post(uploadController.CheckFileBeforeReceive, uploadMultipartFileChunk, uploadController.ReceiveFileFromOtherNode);
module.exports = router;
