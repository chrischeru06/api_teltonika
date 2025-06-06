// services/tripService.js
const { getPool } = require('../db/pool');
const { insertTripRecord } = require('../db/queries');
const logger = require('../logger/logger');

async function saveTripRecord(tripData) {
  try {
    const pool = getPool();
    await insertTripRecord(pool, tripData);
  } catch (err) {
    logger.error('Insert trip record error:', err.message);
    throw err;
  }
}

module.exports = {
  saveTripRecord,
};
