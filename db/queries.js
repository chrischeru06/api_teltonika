// db/queries.js
const insertTrackingData = async (pool, values) => {
  const query = `INSERT INTO tracking_data (
    latitude, longitude, vitesse, altitude, date,
    angle, satellites, mouvement, gnss_statut,
    device_uid, ignition
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  await pool.execute(query, values);
};

const clearTrackingData = async (pool, device_uid) => {
  await pool.execute('DELETE FROM tracking_data WHERE device_uid = ?', [device_uid]);
};

const insertTripRecord = async (pool, { imei, start, end, path }) => {
  const sql = `
    INSERT INTO path_histo_trajet_geojson (DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE)
    VALUES (?, ?, ?, ?)
  `;
  await pool.execute(sql, [imei, start, end, path]);
};

module.exports = {
  insertTrackingData,
  clearTrackingData,
  insertTripRecord,
};
