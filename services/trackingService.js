const { getPool } = require('../db/pool');
const logger = require('../logger/logger');

async function insertTrackingData(values) {
  const query = `INSERT INTO tracking_data (
    latitude, longitude, vitesse, altitude, date,
    angle, satellites, mouvement, gnss_statut,
    device_uid, ignition
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  try {
    const pool = getPool();
    await pool.execute(query, values);
  } catch (err) {
    logger.error('Insert tracking data error:', err.message);
  }
}

async function clearTrackingData(device_uid) {
  try {
    const pool = getPool();
    await pool.execute('DELETE FROM tracking_data WHERE device_uid = ?', [device_uid]);
  } catch (err) {
    logger.error('Clear tracking data error:', err.message);
  }
}

module.exports = {
  insertTrackingData,
  clearTrackingData,
};
