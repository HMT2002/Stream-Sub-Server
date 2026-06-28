const fs = require('fs');
const path = require('path');

const axios = require('axios');
const fluentFfmpeg = require('fluent-ffmpeg');
const ffmpeg = require('fluent-ffmpeg');
var hash = require('object-hash');

const { exec, spawn } = require('child_process');
const client = axios.create({
  baseURL: process.env.CENTRAL_API,
  timeout: 5000, // bắt buộc cho heartbeat
  headers: { 'Content-Type': 'application/json' },
});
async function sendHeartbeat(payload) {
  try {
    await client.post('api/v1/heartbeat/receive', payload);
    return true; // báo cáo OK
  } catch (err) {
    // gom cả network error lẫn 4xx/5xx về đây
    console.error('[heartbeat] failed:', err.code || err.response?.status);
    return false; // để vòng lặp tự retry lần sau
  }
}

const gatherServerStatus = async () => {};
const gatherServerInfo = async () => {
  return { baseURL: process.env.CENTRAL_API, serverIndex: process.env.SERVERINDEX };
};

const gatherVideosInfo = async () => {
  let videoInfos = [];
  const videoFolder = 'videos/';
  await fs.promises.readdir(videoFolder, { withFileTypes: true });
  const files = await fs.promises.readdir(videoFolder, { withFileTypes: true });

  const directories = files.filter((dirent) => dirent.isDirectory());
  directories.forEach((folder) => {
    // console.log(folder.name);
    const folderPath = path.join(videoFolder, folder.name);
    const videoFiles = fs.readdirSync(folderPath).filter((file) => {
      const ext = path.extname(file).toLowerCase();
      return ext === '.mpd';
    });
    videoInfos.push({ folder: folder.name, videos: videoFiles });
  });

  return videoInfos;
};

const gatherHeartbeatInfo = async () => {
  const serverStatus = await gatherServerStatus();
  const serverInfo = await gatherServerInfo();
  const videosInfo = await gatherVideosInfo();

  const videosInfoHash = hash(videosInfo);
  return (heartbeatInfo = { serverStatus, serverInfo, videosInfo, videosInfoHash });
};
function buildPayload(serverInfo) {
  return {
    payload: serverInfo,
    ts: Date.now(), // epoch ms, UTC — node đóng dấu
    status: 'alive',
    // metrics kèm theo nếu cần: cpu, mem, streams đang chạy...
  };
}
//#region autoHeartbeat
const HEARTBEAT_INTERVAL = 10000;
let stopped = false;

function nextDelay() {
  // rải đều trong [BASE - JITTER, BASE + JITTER]
  const JITTER = process.env.JITTER;
  return HEARTBEAT_INTERVAL - JITTER + Math.random() * (2 * JITTER);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function heartbeatLoop() {
  while (!stopped) {
    try {
      const heartbeatInfo = await gatherHeartbeatInfo();
      const sendRes = await sendHeartbeat(buildPayload(heartbeatInfo));
      // console.log(sendRes);
    } catch (err) {
      console.error('[heartbeat] loop error:', err);
    }
    await sleep(nextDelay()); // chỉ chờ SAU khi gửi xong
  }
}
//#endregion

module.exports = {
  gatherServerStatus,
  gatherServerInfo,
  gatherVideosInfo,
  gatherHeartbeatInfo,
  sendHeartbeat,
  heartbeatLoop,
};
