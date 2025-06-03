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

// Ensure IMEI base directory exists
if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

// === State Memory ===
const deviceState = new Map();

// === MySQL DB Connection Config & Pool ===
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

function toMysqlDatetime(isoDate) {
  return isoDate.replace('T', ' ').replace('Z', '').split('.')[0];
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
    console.log(`✅ Data inserted into DB for IMEI: ${values[10]}`);
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
          deviceState.set(imei, { lastIgnition: null, lastInsert: 0 });
          const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(imeiFolder)) {
            fs.mkdirSync(imeiFolder, { recursive: true });
          }
        }
        return;
      }

      const avl = parser.getAvl();
      if (!avl || !avl.records || avl.records.length === 0) return;

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

        const now = Date.now();
        const shouldInsert = io.ignition === 1 || (io.ignition === 0 && now - state.lastInsert > 180000);

        if (shouldInsert) {
          await insertTrackingData(values);
          state.lastInsert = now;
        }

        if (io.ignition === 1 && state.lastIgnition !== 1) {
          const startTime = new Date(timestamp).toISOString().replace(/[:.]/g, '-');
          const fileName = `trip_${startTime}.geojson`;
          const tripFilePath = path.join(IMEI_FOLDER_BASE, imei, fileName);
          state.trip = { path: tripFilePath, points: [], start: timestampIso };
        }

        if (io.ignition === 1 && state.trip) {
          state.trip.points.push({
            geometry: { type: "Point", coordinates: [gps.longitude, gps.latitude] },
            properties: { timestamp: timestampIso, speed: gps.speed, altitude: gps.altitude, angle: gps.angle, satellites: gps.satellites }
          });
        }

        const ignitionChanged = state.lastIgnition !== null && state.lastIgnition !== io.ignition;
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
                  startTime: state.trip.start,
                  endTime: timestampIso,
                  totalPoints: state.trip.points.length
                }
              }
            ]
          };

          fs.writeFileSync(state.trip.path, JSON.stringify(geojson, null, 2));
          console.log(`✅ Trip saved to ${state.trip.path}`);

          try {
            await db.execute(`DELETE FROM tracking_data WHERE device_uid = ?`, [imei]);
            console.log(`🧹 DB cleaned for IMEI: ${imei}`);

            await db.execute(`
              INSERT INTO path_histo_trajet_geojson (DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE)
              VALUES (?, ?, ?, ?)
            `, [imei, state.trip.start, timestampIso, state.trip.path]);
          } catch (err) {
            console.error('❌ Failed to insert GeoJSON path metadata:', err.message);
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
