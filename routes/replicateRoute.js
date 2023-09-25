const express = require('express');
const fs = require('fs');
const replicateController = require('../controllers/replicateController');

const { upload, uploadVideo, uploadImage } = require('../modules/multerAPI.js');
const router = express.Router();
const tempHls = fs.readFileSync('./public/client.html', 'utf-8');

//ROUTE HANDLER
router.route('/receive/:filename').get(replicateController.ReceiveFileFromOtherNode);
router.route('/send/:filename').get(replicateController.ReceiveFileFromOtherNode);

module.exports = router;
