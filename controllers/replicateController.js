const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('./../utils/appError');
const APIFeatures = require('./../utils/apiFeatures');
var FormData = require('form-data');
var http = require('http');
const axios = require('axios');

async function concater(arrayChunkName, destination, filename, ext) {
  arrayChunkName.forEach((chunkName) => {
    const data = fs.readFileSync('./' + destination + chunkName);
    fs.appendFileSync('./' + destination + filename + '.' + ext, data);
    //fs.unlinkSync('./' + destination + chunkName);
  });
}

async function concaterServer(arrayChunkName, destination, originalname) {
  arrayChunkName.forEach((chunkName) => {
    const data = fs.readFileSync('./' + destination + chunkName);
    fs.appendFileSync('./' + destination + originalname, data);
    fs.unlinkSync('./' + destination + chunkName);
  });
}

exports.SendFileToOtherNode = catchAsync(async (req, res, next) => {
  const filename = req.params.filename;
  const videoPath = 'videos/' + filename;
  if (fs.existsSync(videoPath)) {
    console.log('File converted!: ' + videoPath);
    const videoSize = fs.statSync(videoPath).size;
    let chunkName = helperAPI.GenerrateRandomString(7);
    let arrayChunkName = [];
    const CHUNK_SIZE = 30 * 1024 * 1024; // 30MB
    const totalChunks = Math.ceil(videoSize / CHUNK_SIZE);
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      arrayChunkName.push(chunkName + '_' + chunkIndex);
    }
    for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
      let start = chunkIndex * CHUNK_SIZE;
      let end = Math.min(start + CHUNK_SIZE, videoSize);
      const readStream = fs.createReadStream(videoPath, { start: start, end: end - 1 });
      var form = new FormData();
      form.append('myMultilPartFileChunk', readStream);
      form.append('arraychunkname', JSON.stringify(arrayChunkName));
      var options = {
        method: 'POST',
        port: 9200,
        host: 'localhost',
        path: '/api/v1/replicate/receive/' + filename,
        headers: { ...form.getHeaders(), chunkname: chunkName + '_' + chunkIndex, ext: filename.split('.')[1] },
      };
      var request = http.request(options);
      await form.pipe(request);
      request.on('response', function (response) {
        response.on('data', function (chunk) {
          const data = JSON.parse(chunk);
          if (data.message == 'enough for concate') {
            setTimeout(() => {
              axios({
                method: 'post',
                url: 'http://localhost:9200/api/v1/replicate/concate/' + filename,
                data: {
                  arraychunkname: arrayChunkName,
                },
              })
                .then(function (response) {
                  console.log(response.data);
                })
                .catch(function (error) {
                  console.log(error);
                });
            }, 5000);
          }
        });
      });
    }

    res.status(200).json({
      message: 'File found',
      path: videoPath,
    });
    return;
  } else {
    console.log('not found video');
    res.status(200).json({
      message: 'File not found',
      path: videoPath,
    });
    return;
  }

  // res.writeHead(206, headers);
  // const videoStream = fs.createReadStream(videoPath, { start, end });
  // videoStream.pipe(res);
});

async function SplitAndSendFile(start, end, videoPath, filename, arrayChunkName, chunkIndex) {
  var form = new FormData();
  form.append('myMultilPartFileChunk', fs.createReadStream(videoPath, { start, end }));
  form.append('arraychunkname', JSON.stringify(arrayChunkName));
  var request = http.request({
    method: 'POST',
    port: 9200,
    host: 'localhost',
    path: '/api/test/receive/' + filename,
    headers: { ...form.getHeaders(), chunkname: arrayChunkName[chunkIndex] },
  });
  form.pipe(request);
}

exports.ReceiveFileFromOtherNode = catchAsync(async (req, res, next) => {
  console.log(req.headers);
  let arrayChunkName = JSON.parse(req.body.arraychunkname);
  let destination = req.file.destination;
  let flag = true;
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });

  if (flag) {
    req.body.arraychunkname = arrayChunkName;
    next();
  } else {
    res.status(201).json({
      message: 'success upload chunk, not enough for concate',
    });

    return;
  }
});

exports.ConcateRequestNEXT = catchAsync(async (req, res, next) => {
  let arrayChunkName = req.body.arraychunkname;
  console.log(arrayChunkName);
  const originalname = req.file.originalname;
  const destination = 'videos/';
  // concaterServer(arrayChunkName, destination, originalname);
  res.status(201).json({
    message: 'enough for concate',
  });
});

exports.ConcateRequest = catchAsync(async (req, res, next) => {
  let arrayChunkName = req.body.arraychunkname;
  console.log(req.body.arraychunkname)
  const originalname = req.params.filename;
  let flag = true;
  const destination = 'videos/';
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    concaterServer(arrayChunkName, destination, originalname);
    res.status(201).json({
      message: 'concated',
    });
    return;
  }
  res.status(201).json({
    message: 'still in development',
  });
});
