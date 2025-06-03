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

db?.on('error', err => {
  console.error('MySQL connection error:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('Reconnecting to MySQL...');
    initDbPool();
  } else {
    throw err;
  }
});

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

async function deleteTripFromDB(imei) {
  const deleteQuery = `DELETE FROM tracking_data WHERE device_uid = ?`;
  try {
    await db.execute(deleteQuery, [imei]);
    console.log(`🗑️ Old trip data deleted from DB for IMEI ${imei}`);
  } catch (err) {
    console.error('❌ Error deleting trip data from DB:', err.message);
  }
}

async function saveTripAsGeoJSON(imei, tripPoints) {
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          imei,
          start: tripPoints[0].timestamp,
          end: tripPoints[tripPoints.length - 1].timestamp
        },
        geometry: {
          type: 'LineString',
          coordinates: tripPoints.map(p => [p.longitude, p.latitude])
        }
      }
    ]
  };

  const filePath = path.join(IMEI_FOLDER_BASE, imei, `trip-${Date.now()}.geojson`);
  fs.writeFileSync(filePath, JSON.stringify(geojson, null, 2));
  console.log(`🗺️ Trip saved for IMEI ${imei} at ${filePath}`);
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
          deviceState.set(imei, { lastIgnition: null, currentTripData: [] });

          const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(imeiFolder)) {
            fs.mkdirSync(imeiFolder, { recursive: true });
            console.log(`📁 Folder created for IMEI at: ${imeiFolder}`);
          }
        }
        return;
      }

      const avl = parser.getAvl();
      if (!avl || !avl.records || avl.records.length === 0) {
        console.warn('⚠️ No AVL records found for IMEI:', imei);
        return;
      }

      const state = deviceState.get(imei);
      for (const record of avl.records) {
        const { gps, timestamp, ioElements } = record;

        if (!gps || gps.latitude === 0 || gps.longitude === 0) {
          console.log('❌ Skipping invalid GPS data for IMEI:', imei);
          continue;
        }

        const io = {
          ignition: ioElements.find(io => io.id === 0x01)?.value || 0,
          mouvement: ioElements.find(io => io.id === 0x02)?.value || 0,
          gnss_statut: ioElements.find(io => io.id === 0x03)?.value || 1,
        };

        const timestampIso = new Date(timestamp).toISOString();

        if (io.ignition === 1) {
          if (state.lastIgnition === 0 || !state.currentTripData) {
            state.currentTripData = [];
          }

          state.currentTripData.push({
            latitude: gps.latitude,
            longitude: gps.longitude,
            timestamp: timestampIso
          });

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

          await insertTrackingData(values);
        }
        else if (io.ignition === 0 && state.lastIgnition === 1) {
          const tripPoints = state.currentTripData || [];
          if (tripPoints.length > 1) {
            await saveTripAsGeoJSON(imei, tripPoints);
            await deleteTripFromDB(imei);
          }
          state.currentTripData = [];
        }

        state.lastIgnition = io.ignition;
      }
    } catch (err) {
      console.error('❗ Error processing data for IMEI:', imei, err);
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  console.log(`🚀 TCP Server listening on port ${TCP_PORT}`);
});
