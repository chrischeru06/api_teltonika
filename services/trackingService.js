// services/trackingService.js
const { getPool } = require('../db/pool');
const { insertTrackingData, clearTrackingData } = require('../db/queries');
const logger = require('../logger/logger');

async function insertTrackingDataService(values) {
  try {
    const pool = getPool();
    await insertTrackingData(pool, values);
  } catch (err) {
    logger.error('Insert tracking data error:', err.message);
  }
}

async function clearTrackingDataService(device_uid) {
  try {
    const pool = getPool();
    await clearTrackingData(pool, device_uid);
  } catch (err) {
    logger.error('Clear tracking data error:', err.message);
  }
}

module.exports = {
  insertTrackingData: insertTrackingDataService,
  clearTrackingData: clearTrackingDataService,
};
