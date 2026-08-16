const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const encodeAPI = require('../modules/encodeAPI');

const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const APIFeatures = require('../utils/apiFeatures');
var FormData = require('form-data');
const axios = require('axios');
const fluentFfmpeg = require('fluent-ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
fluentFfmpeg.setFfmpegPath(ffmpegPath);
const { setTimeout } = require('timers/promises');
const { CONSTANTS } = require('../constants/constants');

async function concater(chunkNames, destination, filename, ext) {
  chunkNames.forEach((chunkName) => {
    const data = fs.readFileSync('./' + destination + chunkName);
    fs.appendFileSync('./' + destination + filename + '.' + ext, data);
  });
}

async function concaterServer(chunkNames, destination, originalname) {
  chunkNames.forEach((chunkName) => {
    try {
      const data = fs.readFileSync('./' + destination + chunkName);
      fs.appendFileSync('./' + destination + originalname, data);
      fs.unlinkSync('./' + destination + chunkName);
    } catch (err) {
      console.log(err);
    }
  });
}
/**
 * @deprecated 2026-08-16 — đường v1. Thay bằng `POST /api/v2/uploads/chunks`
 * (`controllers/uploadV2Controller.js`), nơi identity đến từ header do Central
 * cấp và tên file do Sub tự suy ra.
 * Xoá khi: `legacy.route.hit` của `POST /api/v1/upload` = 0 trong 30 ngày.
 *
 * [FIXED 2026-08-16] Hai handler dưới đây tham chiếu `url` và `port` — HAI BIẾN
 * CHƯA TỪNG ĐƯỢC KHAI BÁO trong file này. Nhánh "file đã tồn tại" vì vậy ném
 * `ReferenceError` thay vì trả 200, và lỗi đó rơi vào `globalErrorHandler` ->
 * client nhận 500. Lỗi nằm im vì nó chỉ chạy khi upload trùng tên.
 */
exports.checkFileOnReceiving = catchAsync(async (req, res, next) => {
  const videoPath = 'videos/' + req.body.filename;
  if (fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'Folder already existed on this server',
      path: videoPath,
    });
    return;
  }
  next();
});

/** @deprecated 2026-08-16 — xem ghi chú ở `checkFileOnReceiving`. */
exports.checkFolderOnReceiving = catchAsync(async (req, res, next) => {
  const videoPath = 'videos/' + req.body.filename;
  if (fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'File already existed on this server',
      path: videoPath,
    });
    return;
  }
  next();
});

exports.receiveVideoFile = catchAsync(async (req, res, next) => {
  console.log('uploadController.receiveVideoFile -> ');
  let chunkNames = req.body.chunkNames;
  let destination = req.file.destination;
  let flag = true;
  chunkNames.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    console.log('Enough for concate');
    const originalname = req.body.chunkname;
    const statusId = req.body.statusId;
    encodeAPI.concaterServer(chunkNames, destination, originalname);
    encodeAPI.encodeIntoDashVer4(destination, originalname, statusId);
    res.status(201).json({
      message: CONSTANTS.SUCCESS_CONCATE_AND_CONVERTED_MESSAGE,
    });
  } else {
    res.status(201).json({
      message: CONSTANTS.NOT_ENOUGH_FOR_CONCATE_MESSAGE,
    });
  }
});

exports.TestEncodeCommand = catchAsync(async (req, res, next) => {
  console.log('uploadController.TestEncodeCommand -> ');
  let videoname = req.body.videoname;

  encodeAPI.encodeIntoDash_test(videoname);
  res.status(201).json({
    message: 'run command!',
  });
});

exports.SendIndIndividualFileToOtherNode = catchAsync(async (req, res, next) => {
  console.log('replicate file controller');
  const filename = req.body.filename || '';
  const filePath = 'videos/' + filename;
  const url = req.body.url || 'localhost';
  const port = req.body.port || '';

  const baseUrl = 'http://' + url + port + CONSTANTS.SUB_SERVER_CHECK_API + '/file/' + filename;
  console.log(baseUrl);
  const { data: check } = await axios.get(baseUrl);
  console.log(check);
  if (check.existed === true) {
    res.status(200).json({
      message: 'File already existed on sub server',
      check,
    });
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.status(200).json({
      message: 'File not found',
      path: filePath,
    });
    return;
  }
  console.log('File found!: ' + filePath);
  console.log(filePath);
  console.log(fs.existsSync(filePath));
  const readStream = fs.createReadStream(filePath);
  var form = new FormData();
  form.append('myIndividualFile', readStream);
  const { data } = await axios({
    method: 'post',
    url: 'http://' + url + port + CONSTANTS.SUB_SERVER_REPLICATE_API + '/receive-file',
    data: form,
    headers: { ...form.getHeaders(), filename: filename },
  });
  console.log(data);
  res.status(200).json({
    message: 'File sent!',
    filePath,
  });
  return;
});

exports.ReceiveIndividualFileFromOtherNode = catchAsync(async (req, res, next) => {
  let destination = req.file.destination;
  res.status(200).json({
    message: CONSTANTS.SUCCESS_RECEIVE_INDIVIDUAL_FILE,
    destination,
  });
});
