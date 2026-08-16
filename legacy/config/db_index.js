const mongoose = require('mongoose');

const DB_LOCAL = 'mongodb://127.0.0.1:27017/LearnNodeJS';
const DB_LOCAL_NEW = 'mongodb://127.0.0.1:27017/VideoSharing';
const DB_LOCAL_ALPHA_TEST = 'mongodb://127.0.0.1:27017/STREAMING_DB';
const DB_CLOUD = process.env.DATABASE.replace('<PASSWORD>', process.env.DATABASE_PASSWORD);

if (process.env.VER === undefined) {
  const connect = async () => {
    try {
      // await mongoose.connect(DB_CLOUD, {}).then((con) => {
      //   console.log('Mongo connected! ');
      //   console.log(con.connections);
      // });
      await mongoose.connect(DB_CLOUD, {}).then((con) => {
        console.log('Mongo connected! ');
        //console.log(con.connections);
      });
    } catch (err) {
      console.log(err);
    }
  };
  module.exports = { connect };
} else {
  if (process.env.VER < '1.0.0' || process.env.VER === '1.0.0') {
  }
}
