const jwt = require('jsonwebtoken');
const fs = require('fs');

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
const GenerateToken = (obj, expire = process.env.JWT_EXPIRES_IN) => {
  return jwt.sign(obj, process.env.JWT_SECRET, { expiresIn: expire });
};
const DecodeToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};
const EnhanceConsoleLog = (code, data, postfix) => {
  console.log(code, data, '\x1b[0m');
};
const EnhaceConsoleLogType = (data, type) => {
  switch (type) {
    case 'NOTI':
      EnhanceConsoleLog('\x1b[42m', data);
      break;
    case 'ERR':
      EnhanceConsoleLog('\x1b[31m', data);
      break;
    default:
      EnhanceConsoleLog('\x1b[42m', data);
      break;
  }
};
const injectpng = (filename, callback) => {
  return new Promise((resolve, reject) => {
    fs.readFile(filename, (err, data) => {
      if (err) {
        reject(err);
      }
      fs.readFile('base.png', (err, image_buffer) => {
        if (err) {
          reject(err);
        }
        const new_file = filename.replace('.ts', '.png');
        fs.writeFile(new_file, Buffer.from(Buffer.concat([image_buffer, data]), 'binary'), (err, info) => {
          if (err) {
            reject(err);
          }
          fs.unlink(filename, (err, _) => {
            if (err) {
              reject(err);
            }
            return resolve(new_file);
          });
        });
      });
    });
  });
};
module.exports = {
  GenerrateRandomString,
  GenerrateRandomNumberBetween,
  GenerateToken,
  DecodeToken,
  EnhanceConsoleLog,
  EnhaceConsoleLogType,
};
