const fs = require('fs');
const path = require('path');
const logger = require('../logger/logger');

function saveTripGeoJson(imei, trip) {
  return new Promise((resolve, reject) => {
    try {
      if (!trip || !trip.points || trip.points.length < 2) {
        logger.warn(`Trip for IMEI ${imei} discarded — not enough points`);
        return resolve();
      }

      const coordinates = trip.points.map(p => p.geometry.coordinates);
      const properties = {
        imei,
        startTime: trip.startTime,
        endTime: trip.endTime,
        totalPoints: trip.points.length,
      };

      const geojson = {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates,
        },
        properties
      };

      const folder = path.join(__dirname, '..', 'IMEI', imei);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });

      const tripId = trip.id || Date.now();
      const safeStart = trip.startTime.replace(/[:.]/g, '-');
      const filename = `trip_${safeStart}_id-${tripId}_linestring.geojson`;
      const fullPath = path.join(folder, filename);

      fs.writeFile(fullPath, JSON.stringify(geojson, null, 2), (err) => {
        if (err) {
          logger.error(`Failed to save trip for IMEI ${imei}: ${err.message}`);
          return reject(err);
        }

        logger.info(`Trip saved: ${fullPath}`);
        resolve();
      });
    } catch (err) {
      logger.error(`Exception in saveTripGeoJson: ${err.message}`);
      reject(err);
    }
  });
}

module.exports = {
  saveTripGeoJson,
};
