const fs = require('fs');
const path = require('path');

const axios = require('axios');
const fluentFfmpeg = require('fluent-ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const GenerrateRandomString = (length) => {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_xXx_Tue_Dep_Trai_Vjp_Pro_xXx_abcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  let counter = 0;
  while (counter < length) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
    counter += 1;
  }
  return result;
};

const GenerrateRandomNumberBetween = (min, max) => {
  return Math.floor(Math.random() * (Math.floor(max) - min) + Math.ceil(min)); // The maximum is exclusive and the
};

const encodeIntoDash = async (destination, originalname) => {
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
      '-c:v libx264',
      // '-c:a copy',
      '-c:a aac',
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
      '-crf 28',
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
};

const concaterServer = async (arrayChunkName, destination, originalname) => {
  arrayChunkName.forEach((chunkName) => {
    try {
      const data = fs.readFileSync('./' + destination + chunkName);
      fs.appendFileSync('./' + destination + originalname, data);
      fs.unlinkSync('./' + destination + chunkName);
    } catch (err) {
      console.log(err);
    }
  });
};

module.exports = { GenerrateRandomString, GenerrateRandomNumberBetween, encodeIntoDash, concaterServer };
