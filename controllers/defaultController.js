
exports.Default = catchAsync(async (req, res, next) => {

  res.status(200).json({
    default:'default'
  });
});
