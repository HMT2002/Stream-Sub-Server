const write = (event, fields = {}) => {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    scope: 'media-contract-v2',
    event,
    ...fields,
  }));
};

module.exports = Object.freeze({ write });
