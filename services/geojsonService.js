// services/geojsonService.js
const fs = require('fs');
const path = require('path');
const { IMEI_FOLDER_BASE } = require('../config');
const { saveTripRecord } = require('./tripService');

function cleanImei(imei) {
  return String(imei).replace(/[^\d]/g, '').slice(0, 15);
}

async function saveTripGeoJson(imei, trip) {
  const safeImei = cleanImei(imei);
  if (safeImei.length !== 15) {
    throw new Error(`IMEI invalide pour GeoJSON: ${imei}`);
  }

  const imeiFolder = path.join(IMEI_FOLDER_BASE, safeImei);
  if (!fs.existsSync(imeiFolder)) fs.mkdirSync(imeiFolder, { recursive: true });

  const filename = `trip_${trip.id}.geojson`;
  const filepath = path.join(imeiFolder, filename);

  const geojson = {
    type: "FeatureCollection",
    features: trip.points,
  };

  fs.writeFileSync(filepath, JSON.stringify(geojson, null, 2));

  await saveTripRecord({
    imei: safeImei,
    start: trip.startTime,
    end: trip.endTime,
    path: filepath,
  });
}

module.exports = {
  saveTripGeoJson,
};
