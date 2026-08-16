'use strict';

// Công tắc chặn phát — xem `controllers/playbackBlockController.js`.
// Mount tại `/api/v2/playback` (control plane, có requestTrace).

const express = require('express');
const playbackBlockController = require('../../controllers/playbackBlockController');

const router = express.Router();

router.route('/blocks').get(playbackBlockController.list).post(playbackBlockController.create);
router.route('/blocks/clear').post(playbackBlockController.clear);

// Thử trước khi chặn thật: hỏi "URI này bây giờ có qua được không?".
router.route('/probe').get(playbackBlockController.probe);

// Đặt SAU `/blocks/clear` — nếu đặt trước, `clear` sẽ khớp vào `:id`.
router.route('/blocks/:id').delete(playbackBlockController.remove);

module.exports = router;
