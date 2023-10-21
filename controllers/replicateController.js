const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const catchAsync = require('./../utils/catchAsync');
const AppError = require('./../utils/appError');
const APIFeatures = require('./../utils/apiFeatures');
var FormData = require('form-data');
const axios = require('axios');
const fluentFfmpeg = require('fluent-ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
fluentFfmpeg.setFfmpegPath(ffmpegPath);

async function concater(arrayChunkName, destination, filename, ext) {
  arrayChunkName.forEach((chunkName) => {
    const data = fs.readFileSync('./' + destination + chunkName);
    fs.appendFileSync('./' + destination + filename + '.' + ext, data);
    //fs.unlinkSync('./' + destination + chunkName);
  });
}

async function encodeIntoHls(destination,originalname) {
  console.log({destination,originalname})
  const filePath = destination+originalname;
  const filenameWithoutExt = originalname.split('.')[0];
  const outputFolder = destination + filenameWithoutExt + 'Hls';
  const outputResult = outputFolder + '/' + filenameWithoutExt + '.m3u8';
  fs.access(outputFolder, (error) => {
    // To check if the given directory
    // already exists or not
    if (error) {
      // If current directory does not exist
      // then create it
      fs.mkdir(outputFolder, (error) => {
        if (error) {
          console.log(error);
        } else {
          console.log('New Directory created successfully !!');
        }
      });
    } else {
      console.log('Given Directory already exists !!');
    }
  });
  console.log('Do ffmpeg shit');

  await new ffmpeg()
    .addInput(filePath)
    .outputOptions([
      // '-map 0:v',
      // '-map 0:v',
      // '-map 0:a',
      // '-map 0:a',
      // '-s:v:0 426x240',
      // '-c:v:0 libx264',
      // '-b:v:0 400k',
      // '-c:a:0 aac',
      // '-b:a:0 64k',
      // '-s:v:1 640x360',
      // '-c:v:1 libx264',
      // '-b:v:1 700k',
      // '-c:a:1 aac',
      // '-b:a:1 96k',
      // //'-var_stream_map', '"v:0,a:0 v:1,a:1"',
      // '-master_pl_name '+filenameWithoutExt+'_master.m3u8',
      // '-f hls',
      // '-max_muxing_queue_size 1024',
      // '-hls_time 4',
      // '-hls_playlist_type vod',
      // '-hls_list_size 0',
      // // '-hls_segment_filename ./videos/output/v%v/segment%03d.ts',

      '-c:v copy',
      '-c:a copy',
      //'-var_stream_map', '"v:0,a:0 v:1,a:1"',
      '-level 3.0',
      '-start_number 0',
      '-master_pl_name ' + filenameWithoutExt + '_master.m3u8',
      '-f hls',
      '-hls_list_size 0',
      '-hls_time 10',
      '-hls_playlist_type vod',
      // '-hls_segment_filename ./videos/output/v%v/segment%03d.ts',
    ])
    .output(outputResult)
    .on('start', function (commandLine) {
      console.log('Spawned Ffmpeg with command: ' + commandLine);
    })
    .on('error', function (err, stdout, stderr) {
      console.error('An error occurred: ' + err.message, err, stderr);
    })
    .on('progress', function (progress) {
      console.log('Processing: ' + progress.percent + '% done');
      console.log(progress);
      /*percent = progress.percent;
      res.write('<h1>' + percent + '</h1>');*/
    })
    .on('end', function (err, stdout, stderr) {
      console.log('Finished processing!' /*, err, stdout, stderr*/);
      fs.unlinkSync(filePath, function (err) {
        if (err) throw err;
        console.log(filePath + ' deleted!');
      });
    })
    .run();
}

async function concaterServer(arrayChunkName, destination, originalname) {
  arrayChunkName.forEach((chunkName) => {
    const data = fs.readFileSync('./' + destination + chunkName);
    fs.appendFileSync('./' + destination + originalname, data);
    fs.unlinkSync('./' + destination + chunkName);
  });
}

exports.SendFileToOtherNode = catchAsync(async (req, res, next) => {
  const filename = req.body.filename || 'largetest.mp4';
  const videoPath = 'videos/' + filename;
  const url = req.body.url || 'http://localhost';
  const port = req.body.port || ':9200';
  if (!fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'File not found',
      path: videoPath,
    });
    return;
  }
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
      method: 'post',
      url: url + port + '/api/v1/replicate/receive',
      data: form,
      headers: { ...form.getHeaders(), chunkname: chunkName + '_' + chunkIndex, ext: filename.split('.')[1] },
    })
      .then(function (response) {
        console.log(response.data);
        const data = response.data;
        if (data.message == 'enough for concate') {
          setTimeout(() => {
            axios({
              method: 'post',
              url: url + port + '/api/v1/replicate/concate',
              data: {
                arraychunkname: arrayChunkName,
                filename: filename,
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
});

exports.ReceiveFileFromOtherNode = catchAsync(async (req, res, next) => {
  console.log('received')
  let arrayChunkName = JSON.parse(req.body.arraychunkname);
  let destination = req.file.destination;
  let flag = true;
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    console.log('enough');
    req.body.arraychunkname = arrayChunkName;
    res.status(201).json({
      message: 'enough for concate',
    });
  } else {
    console.log('not enough');
    res.status(201).json({
      message: 'success upload chunk, not enough for concate',
    });
  }
});

exports.ConcateRequest = catchAsync(async (req, res, next) => {
  let arrayChunkName = req.body.arraychunkname;
  console.log(req.body.arraychunkname);
  const originalname = req.body.filename;
  console.log(originalname)
  let flag = true;
  const destination = 'videos/';
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    concaterServer(arrayChunkName, destination, originalname);
    encodeIntoHls(destination, originalname);

    res.status(201).json({
      message: 'concated',
    });
    return;
  }
  res.status(201).json({
    message: 'still in development',
  });
});

exports.SendFolderFileToOtherNode = catchAsync(async (req, res, next) => {
  console.log('replicate folder controller')
  const filename = req.body.filename || 'World Domination How-ToHls';
  const videoPath = 'videos/' + filename + '/';
  const url = req.body.url || 'http://localhost';
  const port = req.body.port || ':9200';

  const baseUrl = url + port + '/api/v1/check/folder/' + filename;
  console.log(baseUrl)
  const {data:check} = await axios.get(baseUrl);
  console.log(check);
  if(check.existed===true){
      res.status(200).json({
    message: 'Folder already existed on sub server',
    check,
  });
  return;
  }

  
    if (!fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'File not found',
      path: videoPath,
    });
    return;
  }
  console.log('File found!: ' + videoPath);
  const dir = 'videos/' + filename ;
  console.log(dir);
  const fileList = fs.readdirSync(dir);
  console.log(fileList);
  for (let i = 0; i < fileList.length; i++) {
    const filePath=videoPath + '/' + fileList[i]
    console.log(filePath)
    console.log(fs.existsSync(filePath))
    const readStream = fs.createReadStream(filePath);
    var form = new FormData();
    form.append('myFolderFile', readStream);
    const { data } = await axios({
      method: 'post',
      url: url + port + '/api/v1/replicate/receive-folder',
      data: form,
      headers: { ...form.getHeaders(), filename: fileList[i],folder:filename },
    });
    console.log(data);
  }
  res.status(200).json({
    message: 'Folder sent!',
    videoPath,
  });
  return;
});

exports.ReceiveFolderFileFromOtherNode = catchAsync(async (req, res, next) => {
  let destination = req.file.destination;
  let flag = true;
  res.status(200).json({
    message: 'success receive folder files',
  });
});

exports.ConcateFolderRequest = catchAsync(async (req, res, next) => {
  let arrayChunkName = req.body.arraychunkname;
  console.log(req.body.arraychunkname);
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
