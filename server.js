const net = require('net');
const path = require('path');
const fs = require('fs');
const {
  TCP_PORT, TCP_TIMEOUT, IMEI_FOLDER_BASE,
} = require('./config');
const logger = require('./logger/logger');
const { parseData } = require('./parser/teltonikaParser');
const {
  insertTrackingData, clearTrackingData,
} = require('./services/trackingService');
const { saveTripGeoJson } = require('./services/geojsonService');
const { isValidGps, extractIoValue } = require('./utils/validation');
const { toMysqlDatetime } = require('./utils/dateUtils');

if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

const deviceState = new Map();

const tcpServer = net.createServer(socket => {
  logger.info('TCP client connected');
  let imei = null;
  socket.setTimeout(TCP_TIMEOUT);

  socket.on('timeout', () => socket.end());
  socket.on('end', () => imei && deviceState.delete(imei));
  socket.on('error', err => {
    logger.error('Socket error:', err);
    imei && deviceState.delete(imei);
  });

  socket.on('data', async data => {
    try {
      const parsed = parseData(data);

      if (parsed?.imei) {
        imei = parsed.imei;
        socket.write(Buffer.from([0x01]));

        if (!deviceState.has(imei)) {
          deviceState.set(imei, { lastIgnition: null });
          const folder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
        }
        return;
      }

      if (!parsed?.records?.length) return;

      const state = deviceState.get(imei);

      for (const record of parsed.records) {
        const { gps, timestamp, ioElements } = record;
        if (!isValidGps(gps)) continue;

        const ignition = extractIoValue(ioElements, 'Ignition', 0);
        const mouvement = extractIoValue(ioElements, 'Movement', 0);
        const gnss_statut = extractIoValue(ioElements, 'GNSS Status', 1);

        const timestampIso = toMysqlDatetime(new Date(timestamp).toISOString());

        if (ignition === 1) {
          await insertTrackingData([
            gps.latitude, gps.longitude, gps.speed || 0, gps.altitude, timestampIso,
            gps.angle, gps.satellites, mouvement, gnss_statut, imei, ignition,
          ]);

          if (!state.trip) {
            state.trip = { startTime: timestampIso, points: [] };
          }

          state.trip.points.push({
            geometry: { type: "Point", coordinates: [gps.longitude, gps.latitude] },
            properties: {
              timestamp: timestampIso,
              speed: gps.speed,
              altitude: gps.altitude,
              angle: gps.angle,
              satellites: gps.satellites,
            },
          });
        }

        const ignitionChanged = state.lastIgnition !== null && state.lastIgnition === 1 && ignition === 0;
        state.lastIgnition = ignition;

        if (ignitionChanged && state.trip) {
          state.trip.endTime = timestampIso;

          await saveTripGeoJson(imei, state.trip);
          await clearTrackingData(imei);

          delete state.trip;
        }
      }
    } catch (err) {
      logger.error(`Processing error for IMEI ${imei}: ${err.message}`);
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  logger.info(`TCP Server running on port ${TCP_PORT}`);
});
