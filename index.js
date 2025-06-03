/**
 * Teltonika GPS Tracker Server - Local Development Version
 * Author: Cerubala Christian Wann'y
 * Email: wanny@mediabox.bi
 */
const net = require('net');
const Parser = require('teltonika-parser-ex');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// === Configuration ===
const TCP_PORT = 2354;
const TCP_TIMEOUT = 300000; // 5 minutes
const IMEI_FOLDER_BASE = '/var/www/html/IMEI';

if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

const deviceState = new Map();

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'Chris@1996..',
  database: 'car_trucking_v3',
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 0,
};

let db;

async function initDbPool() {
  try {
    db = await mysql.createPool(dbConfig);
    console.log('✅ MySQL pool created');
  } catch (err) {
    console.error('❌ MySQL pool creation failed:', err.message);
    setTimeout(initDbPool, 5000);
  }
}
initDbPool();

db?.on('error', err => {
  console.error('MySQL connection error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('Reconnecting to MySQL...');
    initDbPool();
  } else {
    throw err;
  }
});

function toMysqlDatetime(isoDate) {
  return isoDate.replace('T', ' ').replace('Z', '').split('.')[0];
}

function formatDateForFilename(date) {
  const d = new Date(date);
  const pad = n => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

async function insertTrackingData(values) {
  const insertQuery = `
    INSERT INTO tracking_data (
      latitude, longitude, vitesse, altitude, date,
      angle, satellites, mouvement, gnss_statut,
      device_uid, ignition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  try {
    await db.execute(insertQuery, values);
    console.log(`✅ Data inserted into DB for IMEI: ${values[9]}`);
  } catch (dbErr) {
    console.error('❌ MySQL Insert Error:', dbErr.message);
  }
}

const tcpServer = net.createServer(socket => {
  console.log('🟢 TCP client connected');
  let imei = null;
  socket.setTimeout(TCP_TIMEOUT);

  socket.on('timeout', () => {
    console.log('⏱️ TCP connection timed out');
    socket.end();
  });

  socket.on('end', () => {
    console.log('🔴 TCP client disconnected');
    if (imei) deviceState.delete(imei);
  });

  socket.on('error', err => {
    console.error('Socket error:', err);
    if (imei) deviceState.delete(imei);
  });

  socket.on('data', async data => {
    try {
      console.log('📥 Raw data received (hex):', data.toString('hex'));
      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        console.log('✅ IMEI connected:', imei);
        socket.write(Buffer.from([0x01]));

        if (!deviceState.has(imei)) {
          deviceState.set(imei, { lastIgnition: null });

          const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(imeiFolder)) {
            fs.mkdirSync(imeiFolder, { recursive: true });
            console.log(`📁 Folder created for IMEI at: ${imeiFolder}`);
          }
        }
        return;
      }

      const avl = parser.getAvl();
      if (!avl?.records?.length) {
        console.warn('⚠️ No AVL records found for IMEI:', imei);
        return;
      }

      const state = deviceState.get(imei);

      for (const record of avl.records) {
        const { gps, timestamp, ioElements } = record;
        if (!gps || gps.latitude === 0 || gps.longitude === 0) continue;

        const io = {
          ignition: ioElements.find(io => io.label === 'Ignition')?.value || 0,
          mouvement: ioElements.find(io => io.label === 'Movement')?.value || 0,
          gnss_statut: ioElements.find(io => io.label === 'GNSS Status')?.value || 1,
        };

        const timestampIso = toMysqlDatetime(new Date(timestamp).toISOString());

        const values = [
          gps.latitude.toString(),
          gps.longitude.toString(),
          gps.speed || 0,
          gps.altitude.toString(),
          timestampIso,
          gps.angle.toString(),
          gps.satellites.toString(),
          io.mouvement,
          io.gnss_statut,
          imei,
          io.ignition
        ];

        console.log('🧾 Parsed JSON Data:', JSON.stringify({
          imei,
          timestamp: timestampIso,
          latitude: gps.latitude,
          longitude: gps.longitude,
          speed: gps.speed,
          altitude: gps.altitude,
          angle: gps.angle,
          satellites: gps.satellites,
          ignition: io.ignition,
          mouvement: io.mouvement,
          gnss_statut: io.gnss_statut,
        }, null, 2));

        const ignitionChanged = state.lastIgnition !== null && state.lastIgnition !== io.ignition;

        if (io.ignition === 1 && state.lastIgnition !== 1) {
          const startTime = formatDateForFilename(timestamp);
          const fileName = `trip_${startTime}.geojson`;
          const tripFilePath = path.join(IMEI_FOLDER_BASE, imei, fileName);
          state.trip = {
            path: tripFilePath,
            points: []
          };
          console.log(`📁 New trip started for IMEI ${imei} → ${fileName}`);
        }

        if (io.ignition === 1 && state.trip) {
          state.trip.points.push({
            geometry: {
              type: "Point",
              coordinates: [gps.longitude, gps.latitude]
            },
            properties: {
              timestamp: timestampIso,
              speed: gps.speed,
              altitude: gps.altitude,
              angle: gps.angle,
              satellites: gps.satellites
            }
          });
        }

        await insertTrackingData(values);
        state.lastIgnition = io.ignition;

        if (io.ignition === 0 && ignitionChanged && state.trip) {
          const geojson = {
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: {
                  type: "LineString",
                  coordinates: state.trip.points.map(p => p.geometry.coordinates)
                },
                properties: {
                  imei,
                  startTime: state.trip.points[0]?.properties.timestamp,
                  endTime: state.trip.points[state.trip.points.length - 1]?.properties.timestamp,
                  totalPoints: state.trip.points.length
                }
              }
            ]
          };

          fs.writeFileSync(state.trip.path, JSON.stringify(geojson, null, 2));
          console.log(`✅ Trip saved to ${state.trip.path}`);

          try {
            const insertGeoPathQuery = `
              INSERT INTO path_histo_trajet_geojson (
                DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE
              ) VALUES (?, ?, ?, ?)
            `;
            await db.execute(insertGeoPathQuery, [
              imei,
              geojson.features[0].properties.startTime,
              geojson.features[0].properties.endTime,
              state.trip.path
            ]);
            console.log(`✅ Trip metadata saved to path_histo_trajet_geojson for IMEI: ${imei}`);
          } catch (metaErr) {
            console.error('❌ Failed to insert GeoJSON path metadata:', metaErr.message);
          }

          try {
            await db.execute('DELETE FROM tracking_data WHERE device_uid = ?', [imei]);
            console.log(`🧹 DB cleaned for IMEI: ${imei}`);
          } catch (err) {
            console.error('❌ Failed to delete data from DB:', err.message);
          }

          delete state.trip;
        }
      }
    } catch (err) {
      console.error('❗ Error processing data for IMEI:', imei, err);
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`🚀 TCP Server listening on port ${TCP_PORT}`);
});
