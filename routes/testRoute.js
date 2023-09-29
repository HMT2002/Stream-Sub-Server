const express = require('express');
const fs=require('fs');
const testController = require('../controllers/testController');
const { upload, uploadVideo, uploadImage,uploadMultipartFile ,uploadMultipartFileChunk} = require('../modules/multerAPI.js');
const router = express.Router();
const tempHls = fs.readFileSync('./public/client.html', 'utf-8');

//ROUTE HANDLER

router.route('/mutilpart-upload').post(uploadVideo, testController.UploadNewFile);


router.route('/upload-video').post(uploadVideo, testController.UploadNewFile);
router.route('/upload-video-large').post(uploadVideo, testController.UploadNewFileLarge);
router.route('/upload-video-large-mutilpart').post(uploadMultipartFileChunk, testController.UploadNewFileLargeNew);
router.route('/upload-video-large-mutilpart-concatenate').post( testController.UploadNewFileLargeMultilpartConcatenate,testController.UploadNewFileLargeGetVideoThumbnail);

router.route('/video-stream-file/:filename').get(testController.VideoStreamingFile);
router.route('/video-stream-hls/:filename').get(testController.VideoStreamingHLS);
router.route('/video-proc/convert-stream/:filename').get(testController.VideoConverter);
router.route('/video-proc/OPTIONSVideoRequest/:filename').options(testController.VideoPlayOPTIONS);


router.route('/template-hls/:filename').get(testController.VideoTemplateHLSStreaming,(req, res,next) => {

    console.log('template');
    console.log(req.filename)
    res.writeHead(200, {
        'Content-type': 'text/html',
      });
    const output = tempHls.replace(/{%FILENAME%}/g, req.filename);


      res.end(output);
    return ;
  });



  router.route('/receive/:filename').post(uploadMultipartFileChunk,testController.ReceiveFileFromOtherNode,testController.ConcateRequestNEXT);
  router.route('/send/:filename').get(testController.SendFileToOtherNode);
  router.route('/concate/:filename').post(testController.ConcateRequest);

  
  router.route('/ftp/send/:filename').get(testController.FTPSend);
  router.route('/ftp/receive/:filename').get(testController.FTPReceive);

module.exports = router;
