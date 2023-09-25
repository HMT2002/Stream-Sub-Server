const fs = require('fs');
const path = require('path');
const helperAPI = require('../modules/helperAPI');
const firebaseAPI = require('../modules/firebaseAPI');


const catchAsync = require('../utils/catchAsync');
const AppError = require('../utils/appError');
const APIFeatures = require('../utils/apiFeatures');

exports.SendFileToOtherNode = catchAsync(async (req, res, next) => {
  res.status(201).json({
    message: 'still in development',
  });
});

exports.ReceiveFileFromOtherNode = catchAsync(async (req, res, next) => {
  res.status(201).json({
    message: 'still in development',
  });
});
