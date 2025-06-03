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

// === State Memory ===
const deviceState = new Map();

// === Configuration ===
const TCP_PORT = 2354;
const TCP_TIMEOUT = 300000;
const IMEI_FOLDER_BASE = '/var/www/html/IMEI';

// Ensure IMEI base directory exists
if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

// === MySQL DB connection ===
const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'Chris@1996..',  // 🔐 Replace with your actual password
  database: 'car_trucking_v3',
};

let db;
(async () => {
  db = await mysql.createPool(dbConfig);
})();

// === TCP Server ===
const tcpServer = net.createServer((socket) => {
  console.log("🟢 TCP client connected");
  let imei = null;

  socket.setTimeout(TCP_TIMEOUT);

  socket.on('timeout', () => {
    console.log("⏱️ TCP connection timed out");
    socket.end();
  });

  socket.on('end', () => {
    console.log("🔴 TCP client disconnected");
    if (imei) deviceState.delete(imei);
  });

  socket.on('data', async (data) => {
    try {
      console.log("📥 Raw data received (hex):", data.toString('hex'));

      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        console.log("✅ IMEI connected:", imei);
        socket.write(Buffer.from([0x01]));

        if (!deviceState.has(imei)) {
          deviceState.set(imei, { lastIgnition: null, currentCodeCourse: null });

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
        console.warn("⚠️ No AVL records found for IMEI:", imei);
        return;
      }

      const state = deviceState.get(imei);
      for (const record of avl.records) {
        const { gps, timestamp, ioElements } = record;

        if (!gps || gps.latitude === 0 || gps.longitude === 0) {
          console.log("❌ Skipping invalid GPS data for IMEI:", imei);
          continue;
        }

        const io = {
          ignition: (ioElements.find(io => io.id === 0x01)?.value) || 0,
          mouvement: (ioElements.find(io => io.id === 0x02)?.value) || 0,
          gnss_statut: (ioElements.find(io => io.id === 0x03)?.value) || 1,
        };
        if ((io.ignition === 1 && state.lastIgnition === 0) || (io.ignition === 0 && state.lastIgnition === 1)) {
          state.currentCodeCourse = generateUniqueCode();
        }

        const timestampIso = new Date(timestamp).toISOString();

        // Insert into MySQL
        try {
          const insertQuery = `
            INSERT INTO tracking_data (
              latitude, longitude, vitesse, altitude, date, json,
              angle, satellites, mouvement, gnss_statut,
              device_uid, ignition, CODE_COURSE, 
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `;

          const values = [
            gps.latitude.toString(),
            gps.longitude.toString(),
            gps.speed,
            gps.altitude.toString(),
            timestampIso,
            JSON.stringify(record),
            gps.angle.toString(),
            gps.satellites.toString(),
            io.mouvement,
            io.gnss_statut,
            imei,
            io.ignition,
            state.currentCodeCourse,
          ];

          await db.execute(insertQuery, values);
          console.log("✅ Data inserted into DB for IMEI:", imei);
        } catch (dbErr) {
          console.error("❌ MySQL Insert Error:", dbErr.message);
        }

        state.lastIgnition = io.ignition;
      }

    } catch (err) {
      console.error("❗ Error processing data for IMEI:", imei, err);
    }
  });
});

// === Start TCP Server ===
tcpServer.listen(TCP_PORT, () => {
  console.log(`🚀 TCP Server listening on port ${TCP_PORT}`);
});

// === Unique Code Generator ===
function generateUniqueCode() {
  const timestamp = new Date().toISOString();
  const randomNum = Math.floor(Math.random() * 1000);
  return `${timestamp}-${randomNum}`;
}
