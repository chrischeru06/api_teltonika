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

      let currentIgnition = state.lastIgnition;
      let newIgnition = null;

      for (const record of parsed.records) {
        const { gps, timestamp, ioElements } = record;
        if (!isValidGps(gps)) continue;

        const ignition = extractIoValue(ioElements, 'Ignition', 0);
        const mouvement = extractIoValue(ioElements, 'Movement', 0);
        const gnss_statut = extractIoValue(ioElements, 'GNSS Status', 1);

        const timestampIso = toMysqlDatetime(new Date(timestamp).toISOString());

        // Log to console as requested
        console.log('Inserting to DB:', {
          imei, lat: gps.latitude, lon: gps.longitude, speed: gps.speed,
          alt: gps.altitude, timestamp: timestampIso, ignition
        });

        // Insert into database
        await insertTrackingData([
          gps.latitude, gps.longitude, gps.speed || 0, gps.altitude, timestampIso,
          gps.angle, gps.satellites, mouvement, gnss_statut, imei, ignition,
        ]);

        // Handle ignition ON
        if (ignition === 1) {
          if (!state.trip) {
            const startTime = timestampIso;
            state.trip = {
              id: Date.now(),
              startTime,
              points: []
            };
          }

          state.trip.points.push({
            geometry: { type: "Point", coordinates: [gps.longitude, gps.latitude] },
            properties: {
              timestamp: timestampIso,
              speed: gps.speed,
              altitude: gps.altitude,
              angle: gps.angle,
              satellites: gps.satellites,
            }
          });
        }

        newIgnition = ignition;
      }

      // Detect transition 1 → 0
      if (state.lastIgnition === 1 && newIgnition === 0 && state.trip) {
        const endTime = toMysqlDatetime(new Date().toISOString());
        state.trip.endTime = endTime;

        // Save trip
        await saveTripGeoJson(imei, state.trip);
        await clearTrackingData(imei);

        delete state.trip;
      }

      state.lastIgnition = newIgnition;
    } catch (err) {
      logger.error(`Processing error for IMEI ${imei}: ${err.message}`);
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  logger.info(`TCP Server running on port ${TCP_PORT}`);
});
