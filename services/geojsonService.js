const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');
const logger = require('../logger/logger');
const { MAX_GEOJSON_SIZE, IMEI_FOLDER_BASE } = require('../config');

async function saveTripGeoJson(imei, trip) {
  const folder = path.join(IMEI_FOLDER_BASE, imei);
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

  const dateName = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `trip_${dateName}_linestring.geojson`;
  const filepath = path.join(folder, filename);

  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: trip.points.map(p => p.geometry.coordinates)
        },
        properties: {
          imei,
          startTime: trip.startTime,
          endTime: trip.endTime,
          totalPoints: trip.points.length
        }
      }
    ]
  };

  const geojsonStr = JSON.stringify(geojson, null, 2);

  if (Buffer.byteLength(geojsonStr) > MAX_GEOJSON_SIZE) {
    logger.warn(`GeoJSON file too large for IMEI ${imei}`);
    // Add split logic here if needed
  }

  fs.writeFileSync(filepath, geojsonStr);
  logger.info(`Trip saved: ${filepath}`);

  try {
    const pool = getPool();
    await pool.execute(
      `INSERT INTO path_histo_trajet_geojson (DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE)
       VALUES (?, ?, ?, ?)`,
      [imei, trip.startTime, trip.endTime, filepath]
    );
  } catch (err) {
    logger.error('Insert trip history error:', err.message);
  }
}

module.exports = {
  saveTripGeoJson,
};
