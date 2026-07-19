const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');

const uploadContract = require('../middleware/uploadContract');
const replicationContract = require('../middleware/replicationContract');
const uploadSession = require('../services/uploadSessionService');
const replication = require('../services/replicationService');

const runMiddleware = (middleware, headers) => new Promise((resolve) => {
  const req = { headers };
  middleware(req, {}, (error) => resolve({ req, error }));
});

test('upload v2 derives the filesystem chunk name and ignores client filenames', async () => {
  const { req, error } = await runMiddleware(uploadContract, {
    'x-upload-contract': 'stream-upload-v2',
    'x-upload-id': 'f36c2461-17c6-4600-a20b-fad62a188063',
    'x-storage-key': 'aabbcc001122',
    'x-media-extension': 'mp4',
    'x-chunk-index': '2',
    'x-chunk-count': '4',
    'x-chunk-name': '../../untrusted',
  });
  assert.equal(error, undefined);
  assert.equal(req.uploadContract.chunkName, 'f36c2461-17c6-4600-a20b-fad62a188063.part.2');
});

test('upload v2 rejects a missing or different contract version', async () => {
  const { error } = await runMiddleware(uploadContract, {});
  assert.equal(error.statusCode, 400);
});

test('upload session concatenates deterministic chunks once and records acceptance', () => {
  const contract = {
    uploadId: `contract-test-${process.pid}-${Date.now()}`,
    storageKey: `contractmedia${process.pid}${Date.now()}`,
    extension: 'mp4',
    chunkCount: 2,
  };
  const cleanup = [
    uploadSession.partPath(contract.uploadId, 0), uploadSession.partPath(contract.uploadId, 1),
    uploadSession.outputPath(contract), uploadSession.markerPath(contract),
  ];
  try {
    fs.writeFileSync(cleanup[0], 'hello ');
    fs.writeFileSync(cleanup[1], 'world');
    const result = uploadSession.acceptChunk(contract);
    assert.equal(result.complete, true);
    assert.equal(result.alreadyComplete, false);
    assert.equal(fs.readFileSync(result.outputPath, 'utf8'), 'hello world');
    assert.equal(uploadSession.acceptChunk(contract).alreadyComplete, true);
  } finally {
    cleanup.forEach((file) => { if (fs.existsSync(file)) fs.unlinkSync(file); });
  }
});

test('replication receiver rejects path traversal and accepts canonical metadata', async () => {
  const rejected = await runMiddleware(replicationContract, {
    'x-replication-contract': 'stream-replication-v2', 'x-job-id': 'job-1',
    'x-storage-key': 'media-1', 'x-file-name': '../init.mpd',
  });
  assert.equal(rejected.error.statusCode, 400);

  const accepted = await runMiddleware(replicationContract, {
    'x-replication-contract': 'stream-replication-v2', 'x-job-id': 'job-1',
    'x-storage-key': 'media-1', 'x-file-name': 'init.mpd',
  });
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.req.replicationContract.fileName, 'init.mpd');
  assert.equal(replication.safeStorageKey('media-1'), 'media-1');
});
