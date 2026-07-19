const fs = require('fs');
const path = require('path');

const videosRoot = path.resolve(__dirname, '..', 'videos');
const partPath = (uploadId, index) => path.join(videosRoot, `${uploadId}.part.${index}`);
const outputPath = (contract) => path.join(videosRoot, `${contract.storageKey}.${contract.extension}`);
const markerPath = (contract) => path.join(videosRoot, `.${contract.uploadId}.accepted.json`);
const inspect = (contract) => {
  const received = [];
  for (let index = 0; index < contract.chunkCount; index += 1) {
    if (fs.existsSync(partPath(contract.uploadId, index))) received.push(index);
  }
  return { received, complete: received.length === contract.chunkCount };
};
const concatenate = (contract) => {
  const target = outputPath(contract);
  const marker = markerPath(contract);
  if (fs.existsSync(marker)) return { outputPath: target, alreadyComplete: true };
  const output = fs.openSync(target, 'w');
  try {
    for (let index = 0; index < contract.chunkCount; index += 1) {
      const source = partPath(contract.uploadId, index);
      const input = fs.openSync(source, 'r');
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let bytesRead;
        do {
          bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
          if (bytesRead > 0) fs.writeSync(output, buffer, 0, bytesRead);
        } while (bytesRead > 0);
      } finally { fs.closeSync(input); }
      fs.unlinkSync(source);
    }
  } finally { fs.closeSync(output); }
  fs.writeFileSync(marker, JSON.stringify({ uploadId: contract.uploadId, storageKey: contract.storageKey, acceptedAt: new Date().toISOString() }));
  return { outputPath: target, alreadyComplete: false };
};
const acceptChunk = (contract) => {
  if (fs.existsSync(markerPath(contract))) return { received: [], complete: true, outputPath: outputPath(contract), alreadyComplete: true };
  const state = inspect(contract);
  return state.complete ? { ...state, ...concatenate(contract) } : { ...state, outputPath: null, alreadyComplete: false };
};
module.exports = Object.freeze({ videosRoot, partPath, outputPath, markerPath, inspect, concatenate, acceptChunk });
