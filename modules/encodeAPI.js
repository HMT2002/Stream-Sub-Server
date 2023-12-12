const fs = require('fs');
const path = require('path');

const axios = require('axios');
const fluentFfmpeg = require('fluent-ffmpeg');
const ffmpeg = require('fluent-ffmpeg');

const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
fluentFfmpeg.setFfmpegPath(ffmpegPath);

const sizes = [
  [240, 350],
  [480, 700],
  [720, 2500],
];

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
      '-re',
      '-preset veryfast',
      // '-c:v copy',
      '-c:v libx264',
      // '-c:a copy',
      '-c:a aac',
      '-c:s srt',
      '-crf 28',
      '-f dash',
      '-map 0:v:0',
      '-map 0:a:0',
      '-ar 44100',

      '-b:v:0 750k -filter:v:0 scale=-2:480',
      '-b:v:1 1000k -filter:v:1 scale=-2:720',
      '-b:v:2 1500k -filter:v:2 scale=-2:1080',

      // '-filter:v:0 scale=-2:360',
      // '-maxrate:v:0 600k',
      // '-b:a:0 500k',
      // '-filter:v:1 scale=-2:480',
      // '-maxrate:v:1 1500k',
      // '-b:a:1 1000k',
      // '-filter:v:2 scale=-2:1080',
      // '-maxrate:v:2 3000k',
      // '-b:a:2 2000k',
      // '-var_stream_map',
      // '"v:0,a:0,s:0 v:1,a:0,s:0 v:2,a:0,s:0"',
      '-use_timeline 1',
      '-single_file 0',
      '-use_template 1',
      '-seg_duration 10',
      // '-adaptation_sets "id=0,streams=v id=1,streams=a"',
      '-bf 1',
      '-keyint_min 120',
      '-g 120',
      '-sc_threshold 0',
      '-b_strategy 0',
      '-ar:a:1 22050',
      '-init_seg_name init_$RepresentationID$.m4s',
      '-media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s',
    ])
    // .outputOption('-adaptation_sets', 'id=0,streams=v id=1,streams=a')
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

const executeFfmpeg = (args) => {
  let command = fluentFfmpeg().output(' '); // pass "Invalid output" validation
  command._outputs[0].isFile = false; // disable adding "-y" argument
  command._outputs[0].target = ''; // bypass "Unable to find a suitable output format for ' '"
  command._global.get = () => {
    // append custom arguments
    return typeof args === 'string' ? args.split(' ') : args;
  };
  return command;
};

const encodeIntoDashVer2 = async (destination, originalname) => {
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

  let command0=
    '-re -i '+filePath+' -map 0 -map 0 -preset ultrafast -c:s srt -sn -c:v libx264 -c:a aac -b:v:0 750k -filter:v:0 scale=-2:480 -b:v:1 1000k -filter:v:1 scale=-2:720 -b:v:2 1500k -filter:v:2 scale=-2:1080 -bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 -ar:a:1 22050 -use_timeline 1 -single_file 0 -use_template 1 -seg_duration 10 -init_seg_name init_$RepresentationID$.m4s -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s -f dash ' +
      outputResult;
      let command1=
      '-re -i '+filePath+' -map 0 -map 0 -preset ultrafast -c:s srt -sn -c:v libx264 -c:a aac -vf format=yuv420p -b:v:0 300k -s:v:0 720x480 -b:v:1 700k -s:v:1 1080x720 -b:v:2 1300k -s:v:2 1920x10800 -bf 1 -keyint_min 120 -g 120 -sc_threshold 0 -b_strategy 0 -ar:a:1 22050 -use_timeline 1 -single_file 0 -use_template 1 -seg_duration 10 -init_seg_name init_$RepresentationID$.m4s -media_seg_name chunk_$RepresentationID$_$Number%05d$.m4s -f dash ' +
        outputResult;
  executeFfmpeg(command1
  )
    .on('start', (commandLine) => console.log('start', commandLine))
    .on('codecData', (codecData) => console.log('codecData', codecData))
    .on('error', (error) => console.log('error', error))
    .on('stderr', (stderr) =>{ console.log('stderr', stderr)
  })
  .on('end', (end) =>{ console.log('end', end);
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

module.exports = {
  GenerrateRandomString,
  GenerrateRandomNumberBetween,
  encodeIntoDash,
  concaterServer,
  encodeIntoDashVer2,
};
