function isValidGps(gps) {
  return gps && gps.latitude !== 0 && gps.longitude !== 0 &&
    Math.abs(gps.latitude) <= 90 && Math.abs(gps.longitude) <= 180;
}

function extractIoValue(ioElements, label, defaultValue = 0) {
  const element = ioElements.find(e => e.label === label);
  return element ? element.value : defaultValue;
}

module.exports = {
  isValidGps,
  extractIoValue,
};
