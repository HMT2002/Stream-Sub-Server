const express = require('express');
const checkController = require('../controllers/checkController');

const router = express.Router();

//ROUTE HANDLER
router.route('/file/:filename').get(checkController.CheckFileRequest);
router.route('/folder/:folder').get(checkController.CheckFolderRequest);


module.exports = router;
