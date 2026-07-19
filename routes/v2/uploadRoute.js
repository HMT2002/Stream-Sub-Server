const express = require('express');
const uploadContract = require('../../middleware/uploadContract');
const uploadV2Controller = require('../../controllers/uploadV2Controller');
const { uploadContractChunk } = require('../../modules/multerAPI');
const router = express.Router();
router.post('/chunks', uploadContract, uploadContractChunk, uploadV2Controller.receiveChunk);
module.exports = router;
