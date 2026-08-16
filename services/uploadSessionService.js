'use strict';

// =============================================================================
// uploadSessionService — ghép các chunk của một phiên upload thành file gốc.
//
// Service này KHÔNG nhận `req`/`res`: vào bằng object `contract` thuần, ra bằng
// object thuần. Nhờ vậy test được bằng `node --test` mà không dựng HTTP server
// (xem `tests/contracts.test.js`) — cùng nguyên tắc với `services/authService.js`.
//
// [UPDATED 2026-08-16] Mọi đường dẫn chuyển sang `storage/paths`. Trước đây file
// này tự ghép path và KHÔNG validate `storageKey`/`uploadId` — nó tin
// `middleware/uploadContract` đã làm. Đúng trên đường HTTP, nhưng bảo đảm nằm ở
// file khác; gọi thẳng service (test, script vận hành) là mất bảo đảm.
// Đường dẫn sinh ra KHÔNG đổi so với bản cũ.
// =============================================================================

const fs = require('fs');
const paths = require('../storage/paths');

const CONCAT_BUFFER_BYTES = 1024 * 1024;

const partPath = (uploadId, index) => paths.chunkPart(uploadId, index);
const outputPath = (contract) => paths.sourceFile(contract.storageKey, contract.extension);
const markerPath = (contract) => paths.uploadMarker(contract.uploadId);

const inspect = (contract) => {
  const received = [];
  for (let index = 0; index < contract.chunkCount; index += 1) {
    if (fs.existsSync(partPath(contract.uploadId, index))) received.push(index);
  }
  return { received, complete: received.length === contract.chunkCount };
};

// Ghép bằng buffer cố định 1 MiB thay vì đọc cả chunk vào RAM: chunk tối đa
// 30 MiB × nhiều phiên đồng thời sẽ vượt heap của một VM free-tier.
const concatenate = (contract) => {
  const target = outputPath(contract);
  const marker = markerPath(contract);

  // Marker là thứ làm cho retry chunk cuối KHÔNG ghép lại lần hai. FE gửi lại
  // chunk cuối khi mạng chập là chuyện bình thường.
  if (fs.existsSync(marker)) return { outputPath: target, alreadyComplete: true };

  const output = fs.openSync(target, 'w');
  try {
    for (let index = 0; index < contract.chunkCount; index += 1) {
      const source = partPath(contract.uploadId, index);
      const input = fs.openSync(source, 'r');
      try {
        const buffer = Buffer.allocUnsafe(CONCAT_BUFFER_BYTES);
        let bytesRead;
        do {
          bytesRead = fs.readSync(input, buffer, 0, buffer.length, null);
          if (bytesRead > 0) fs.writeSync(output, buffer, 0, bytesRead);
        } while (bytesRead > 0);
      } finally {
        fs.closeSync(input);
      }
      fs.unlinkSync(source);
    }
  } finally {
    fs.closeSync(output);
  }

  fs.writeFileSync(
    marker,
    JSON.stringify({ uploadId: contract.uploadId, storageKey: contract.storageKey, acceptedAt: new Date().toISOString() })
  );
  return { outputPath: target, alreadyComplete: false };
};

const acceptChunk = (contract) => {
  if (fs.existsSync(markerPath(contract))) {
    return { received: [], complete: true, outputPath: outputPath(contract), alreadyComplete: true };
  }
  const state = inspect(contract);
  return state.complete
    ? { ...state, ...concatenate(contract) }
    : { ...state, outputPath: null, alreadyComplete: false };
};

module.exports = Object.freeze({
  // Getter, không phải hằng: `MEDIA_ROOT` đọc lúc gọi nên `config.reload()`
  // trong test có hiệu lực ngay.
  get videosRoot() {
    return paths.mediaRoot();
  },
  partPath,
  outputPath,
  markerPath,
  inspect,
  concatenate,
  acceptChunk,
});
