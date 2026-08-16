const multer = require('multer');
const fs = require('fs');
const path = require('path');
const helperAPI = require('./helperAPI');
const paths = require('../storage/paths');

const defaultStoragePath = 'resources-storage/uploads/';

/**
 * @deprecated 2026-08-16 — chuỗi tương đối, giải theo CWD nên đổi chỗ chạy
 * `pm2 start` là trỏ sang thư mục khác. Dùng `storage/paths` (tuyệt đối).
 * Còn dùng ở các storage v1 bên dưới. Xoá khi các storage đó vào `legacy/`.
 * (`videoChunkStoragePath` đã bị bỏ: nó là bản sao y hệt của hằng này.)
 */
const videoStoragePath = 'videos/';

const storage = multer.diskStorage({
  destination: defaultStoragePath,
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});

const storageVideo = multer.diskStorage({
  destination: videoStoragePath,
  filename: (req, file, cb) => {
    const fileID = helperAPI.GenerrateRandomString(7);
    const ext = file.originalname.split('.')[1];

    cb(null, fileID + '.' + ext);
  },
});

const storageChunk = multer.diskStorage({
  destination: videoStoragePath,
  filename: (req, file, cb) => {
    console.log('req.headers.chunkname: ' + req.headers.chunkname);
    cb(null, req.headers.chunkname);
  },
});

// --- Storage của contract v2 --------------------------------------------------
// Tên file KHÔNG bao giờ lấy từ client: nó được dựng lại từ `storage/paths` dựa
// trên metadata Central đã cấp và middleware đã validate. `path.basename()` ở
// đây là để lấy phần tên từ đường dẫn tuyệt đối mà `paths` trả về — chính đường
// dẫn đó vừa đi qua `assertInside`, nên không có cách nào thoát ra khỏi root.
//
// Mọi lỗi phải đi qua `cb(error)`: ném thẳng trong callback của multer sẽ thành
// unhandled exception, không rơi vào `globalErrorHandler`.
const storageChunkV2 = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const directory = paths.stagingRoot();
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    try {
      cb(null, path.basename(paths.chunkPart(req.uploadContract.uploadId, req.uploadContract.chunkIndex)));
    } catch (error) {
      cb(error);
    }
  },
});

const storageReplicatedFile = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      const directory = paths.mediaDir(req.replicationContract.storageKey);
      fs.mkdirSync(directory, { recursive: true });
      cb(null, directory);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    try {
      cb(null, path.basename(paths.mediaFile(req.replicationContract.storageKey, req.replicationContract.fileName)));
    } catch (error) {
      cb(error);
    }
  },
});

const storageFolderFile = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoFolder = videoStoragePath + '/' + req.headers.folder;
    if (!fs.existsSync(videoFolder)) {
      fs.mkdirSync(videoFolder);
    }
    cb(null, videoFolder);
  },
  filename: (req, file, cb) => {
    cb(null, req.headers.filename);
  },
});

const storageIndividualFile = multer.diskStorage({
  destination: (req, file, cb) => {
    const videoFolder = videoStoragePath + '/';
    if (!fs.existsSync(videoFolder)) {
      fs.mkdirSync(videoFolder);
    }
    cb(null, videoFolder);
  },
  filename: (req, file, cb) => {
    cb(null, req.headers.filename);
  },
});

const multipartMaxSize = 35 * 1024 * 1024; //35mb
const folderFileMaxSize = 100 * 1024 * 1024; //100mb
const individualFileMaxSize = 10 * 1024 * 1024; //10mb

const maxSize = 300 * 1024 * 1024; //300mb
const maxSizeVideo = 300 * 1024 * 1024; //300mb
const maxSizeImage = 15 * 1024 * 1024; //15mb

const upload = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype == 'image/png' ||
      file.mimetype == 'image/jpg' ||
      file.mimetype == 'image/jpeg' ||
      file.mimetype == 'video/mp4' ||
      file.mimetype == 'video/mkv' ||
      file.mimetype == 'image/gif' ||
      file.mimetype == 'video/x-msvideo'
    ) {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .png, .jpg, .jpeg, .gif, .mkv, .avi format allowed!'));
    }
  },
  limits: { fileSize: maxSize },
}).single('myFile');

const uploadFile = multer({
  storage: storage,
  limits: { fileSize: maxSize },
}).single('myFile');

const uploadMultipartFile = multer({
  storage: storage,
  limits: { fileSize: multipartMaxSize },
}).single('myMultilPartFile');

const uploadMultipartFileChunk = multer({
  storage: storageChunk,
  limits: { fileSize: multipartMaxSize },
}).single('multipartFileChunk');

const uploadMultipartFileChunkV2 = multer({
  storage: storageChunkV2,
  limits: { fileSize: multipartMaxSize },
}).single('multipartFileChunk');

const uploadReplicatedFile = multer({
  storage: storageReplicatedFile,
  limits: { fileSize: folderFileMaxSize },
}).single('replicationFile');

const uploadFolderFile = multer({
  storage: storageFolderFile,
  limits: { fileSize: folderFileMaxSize },
}).single('myFolderFile');

const uploadIndividualFile = multer({
  storage: storageIndividualFile,
  limits: { fileSize: individualFileMaxSize },
}).single('myIndividualFile');

const uploadArrayFile = multer({
  storage: storage,
  limits: { fileSize: maxSize },
}).any('myFiles', 10);

// var Upload = upload.any([{ name: 'TenFieldsORouteVaHbsPhaiGiongNhau' }]);

const uploadVideo = multer({
  storage: storageVideo,
  fileFilter: (req, file, cb) => {
    if (file.mimetype == 'video/mp4' || file.mimetype == 'video/mkv' || file.mimetype == 'video/x-msvideo') {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .mkv, .avi format allowed!'));
    }
  },
  limits: { fileSize: maxSizeVideo },
}).single('myFile');

const uploadArrayVideo = multer({
  storage: storageVideo,
  fileFilter: (req, file, cb) => {
    if (file.mimetype == 'video/mp4' || file.mimetype == 'video/mkv' || file.mimetype == 'video/x-msvideo') {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .mkv, .avi format allowed!'));
    }
  },
  limits: { fileSize: maxSizeVideo },
}).array('myFiles', 5);

const uploadImage = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype == 'image/png' || file.mimetype == 'image/jpg' || file.mimetype == 'image/jpeg') {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .png, .jpg, .jpeg format allowed!'));
    }
  },
  limits: { fileSize: maxSizeImage },
}).single('myFile');

const uploadArrayImage = multer({
  storage: storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype == 'image/png' || file.mimetype == 'image/jpg' || file.mimetype == 'image/jpeg') {
      cb(null, true);
    } else {
      cb(null, false);
      return cb(new Error('Only .png, .jpg, .jpeg format allowed!'));
    }
  },
  limits: { fileSize: maxSizeImage },
}).array('myFiles', 10);

module.exports = {
  upload,
  uploadVideo,
  uploadImage,
  uploadArrayFile,
  uploadFile,
  uploadArrayImage,
  uploadArrayVideo,
  uploadMultipartFile,
  uploadMultipartFileChunk,
  uploadFolderFile,
  /**
   * @deprecated 2026-08-16 — trùng với `uploadContractChunk` (cùng một object).
   * Tên có hậu tố phiên bản không nói lên nó làm gì; `uploadContractChunk` nói.
   * Chỉ còn `routes/uploadRoute.js` (v1) import mà KHÔNG dùng.
   * Xoá khi: `routes/uploadRoute.js` vào `legacy/`.
   */
  uploadMultipartFileChunkV2,
  uploadContractChunk: uploadMultipartFileChunkV2,
  uploadReplicatedFile,
  uploadIndividualFile,
};
