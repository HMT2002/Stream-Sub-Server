const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const APIFeatures = require('../utils/apiFeatures');
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
  });
}

async function concaterServer(arrayChunkName, destination, originalname) {
  arrayChunkName.forEach((chunkName) => {
    try {
      const data = fs.readFileSync('./' + destination + chunkName);
      fs.appendFileSync('./' + destination + originalname, data);
      fs.unlinkSync('./' + destination + chunkName);
    } catch (err) {
      console.log(err);
    }
  });
}

async function encodeIntoHls(destination, originalname) {
  console.log({ destination, originalname });
  const filePath = destination + originalname;
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
      '-map 0:v',
      '-map 0:a',
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

      '-map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0 -map 0:v:0 -map 0:a:0',
      '-c:v libx265 -crf 22',
      '-c:a aac -ar 44100',
      '-filter:v:0 scale=w=480:h=360  -maxrate:v:0 600k -b:a:0 500k',
      '-filter:v:1 scale=w=640:h=480  -maxrate:v:1 1500k -b:a:1 1000k',
      '-filter:v:2 scale=w=1280:h=720 -maxrate:v:2 3000k -b:a:2 2000k',
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
      // fs.unlinkSync(filePath, function (err) {
      //   if (err) throw err;
      //   console.log(filePath + ' deleted!');
      // });
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

async function encodeIntoDash(destination, originalname) {
  console.log({ destination, originalname });
  const filePath = destination + originalname;
  const filenameWithoutExt = originalname.split('.')[0];
  const outputFolder = destination + filenameWithoutExt + 'Dash';
  const outputResult = outputFolder + '/init.mpd';
  fs.access(outputFolder, (error) => {
    if (error) {
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
      '-f dash',
      '-preset veryfast',
      '-use_timeline 1',
      '-single_file 0',
      '-use_template 1',
      '-seg_duration 10',
      // '-adaptation_sets "id=0,streams=v id=1,streams=a"',
      '-init_seg_name init_$RepresentationID$.m4s',
      '-media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s',
      // '-c:v copy',
      '-c:a copy',
      //'-var_stream_map', '"v:0,a:0 v:1,a:1"',
      '-b:v:0 750k',
      '-filter:v:0 scale=-2:480',
      '-b:v:1 1000k',
      '-filter:v:1 scale=-2:720',
      '-b:v:2 1500k',
      '-filter:v:2 scale=-2:1080',
      // '-s:v:1 320x170',
      '-bf 1',
      '-keyint_min 120',
      '-g 120',
      '-sc_threshold 0',
      '-b_strategy 0',
      '-ar:a:1 22050',
    ])
    .outputOption('-adaptation_sets', 'id=0,streams=v id=1,streams=a')
    .output(outputResult)
    .on('start', function (commandLine) {
      console.log('Spawned Ffmpeg with command: ' + commandLine);
    })
    .on('error', function (err, stdout, stderr) {
      console.error('An error occurred: ' + err.message, err, stderr);
      // fs.unlinkSync(filePath, function (err) {
      //   if (err) throw err;
      //   console.log(filePath + ' deleted!');
      // });
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

exports.CheckFileBeforeReceive = catchAsync(async (req, res, next) => {
  console.log('check file before receive');
  const videoPath = 'videos/' + req.body.filename;
  if (fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'Folder already existed on this server',
      path: videoPath,
      url,
      port,
    });
    return;
  }
  next();
});

exports.CheckFolderBeforeReceive = catchAsync(async (req, res, next) => {
  console.log('check folder before receive');
  const videoPath = 'videos/' + req.body.filename;
  if (fs.existsSync(videoPath)) {
    res.status(200).json({
      message: 'File already existed on this server',
      path: videoPath,
      url,
      port,
    });
    return;
  }
  next();
});

exports.ReceiveFileFromOtherNode = catchAsync(async (req, res, next) => {
  console.log('received');
  let arrayChunkName = req.body.arraychunkname;
  let destination = req.file.destination;
  let flag = true;
  arrayChunkName.forEach((chunkName) => {
    if (!fs.existsSync(destination + chunkName)) {
      flag = false;
    }
  });
  if (flag) {
    let arrayChunkName = req.body.arraychunkname;
    const originalname = req.body.filename;
    concaterServer(arrayChunkName, destination, originalname);
    encodeIntoDash(destination, originalname);
    res.status(201).json({
      message: 'concated and converted!',
    });
  } else {
    res.status(201).json({
      message: 'success upload chunk, not enough for concate',
    });
  }
});

exports.SendIndIndividualFileToOtherNode = catchAsync(async (req, res, next) => {
  console.log('replicate file controller');
  const filename = req.body.filename || '';
  const filePath = 'videos/' + filename;
  const url = req.body.url || 'localhost';
  const port = req.body.port || '';

  const baseUrl = 'http://' + url + port + '/api/v1/check/file/' + filename;
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
    url: 'http://' + url + port + '/api/v1/replicate/receive-file',
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
    message: 'success receive individual files',
    destination,
  });
});
