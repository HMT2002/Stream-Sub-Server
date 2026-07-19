const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const AppError = require('../utils/appError');

const videosRoot = path.resolve(__dirname, '..', 'videos');
const safeStorageKey = (value) => {
  const key = String(value || '').trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(key)) throw new AppError('Invalid storageKey', 400);
  return key;
};
const sendFolder = async (command) => {
  if (command.contractVersion !== 'stream-replication-v2') throw new AppError('stream-replication-v2 contract is required', 400);
  if (!/^[a-zA-Z0-9._-]+$/.test(String(command.jobId || ''))) throw new AppError('Invalid jobId', 400);
  const storageKey = safeStorageKey(command.video?.storageKey);
  const receiveUrl = command.destination?.receiveUrl;
  let parsedReceiveUrl;
  try { parsedReceiveUrl = new URL(receiveUrl); } catch (error) { throw new AppError('destination.receiveUrl is invalid', 400); }
  if (!['http:', 'https:'].includes(parsedReceiveUrl.protocol)) throw new AppError('destination.receiveUrl protocol is invalid', 400);
  const folder = path.join(videosRoot, storageKey);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new AppError('Video folder not found', 404);
  const files = fs.readdirSync(folder).filter((name) => fs.statSync(path.join(folder, name)).isFile()).sort();
  const results = [];
  for (const fileName of files) {
    const form = new FormData();
    form.append('replicationFile', fs.createReadStream(path.join(folder, fileName)));
    const response = await axios.post(receiveUrl, form, {
      timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity, validateStatus: () => true,
      headers: {
        ...form.getHeaders(), 'X-Replication-Contract': 'stream-replication-v2',
        'X-Job-Id': command.jobId, 'X-Storage-Key': storageKey,
        'X-File-Name': fileName, 'X-Video-Id': command.video?.id || '',
      },
    });
    const acknowledgement = response.data?.data;
    if (response.status < 200 || response.status >= 300 || response.data?.ok !== true || acknowledgement?.jobId !== command.jobId || acknowledgement?.storageKey !== storageKey || acknowledgement?.fileName !== fileName || acknowledgement?.received !== true) throw new AppError(`Destination rejected ${fileName}`, 502);
    results.push({ fileName, status: response.status });
  }
  return { jobId: command.jobId, storageKey, filesSent: results.length, files: results };
};
module.exports = Object.freeze({ videosRoot, safeStorageKey, sendFolder });
