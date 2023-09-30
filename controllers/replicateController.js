const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('./../utils/appError');
const APIFeatures = require('./../utils/apiFeatures');
var FormData = require('form-data');
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
  const filename = req.body.filename||'largetest.mp4';
  const videoPath = 'videos/' + filename;
  const url=req.body.url||'http://localhost';
  const port=req.body.port||':9200';

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
      axios({
        method: "post",
        url: url+port+'/api/v1/replicate/receive',
        data:form,
        headers: { ...form.getHeaders(), chunkname: chunkName + '_' + chunkIndex, ext: filename.split('.')[1] },
      })
        .then(function (response) {
          console.log(response.data);
          const data = response.data;
          if (data.message == 'enough for concate') {
            setTimeout(() => {
              axios({
                method: 'post',
                url: url+port+'/api/v1/replicate/concate',
                data: {
                  arraychunkname: arrayChunkName,
                  filename:filename
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
        })
        .catch(function (error) {
          console.log(error);
        });
    }
    res.status(200).json({
      message: 'File found',
      path: videoPath,
    });
    return;
  } else {
    res.status(200).json({
      message: 'File not found',
      path: videoPath,
    });
    return;
  }
});

exports.ReceiveFileFromOtherNode = catchAsync(async (req, res, next) => {
  let arrayChunkName = JSON.parse(req.body.arraychunkname);
  let destination = req.file.destination;
  let flag = true;
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    console.log('enough')
    req.body.arraychunkname = arrayChunkName;
    res.status(201).json({
      message: 'enough for concate',
    });
  } else {
    console.log('not enough')
    res.status(201).json({
      message: 'success upload chunk, not enough for concate',
    });
  }
});

exports.ConcateRequest = catchAsync(async (req, res, next) => {
  let arrayChunkName = req.body.arraychunkname;
  console.log(req.body.arraychunkname)
  const originalname = req.body.filename;
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
