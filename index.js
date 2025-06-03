/**
 * Teltonika GPS Tracker Server - Local Development Version
 * Author: Cerubala Christian Wann'y
 * Email: wanny@mediabox.bi
 */
const net = require('net');
const Parser = require('teltonika-parser-ex');
const fs = require('fs');
const path = require('path');

// === State Memory ===
const deviceState = new Map();

// === Ports ===
const TCP_PORT = 2354;
const TCP_TIMEOUT = 300000; // 5 minutes

// === Define where IMEI folders should be created ===
const IMEI_FOLDER_BASE = '/var/www/html/IMEI';

// Ensure the base directory exists
if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

// === TCP Server ===
const tcpServer = net.createServer((socket) => {
  console.log(" TCP client connected");
  let imei = null;

  socket.setTimeout(TCP_TIMEOUT);

  socket.on('timeout', () => {
    console.log(" TCP connection timed out");
    socket.end();
  });

  socket.on('end', () => {
    console.log(" TCP client disconnected");
    if (imei) {
      deviceState.delete(imei);
    }
  });

  socket.on('data', async (data) => {
    try {
      console.log(" Raw data received (hex):", data.toString('hex'));

      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        console.log(" IMEI connected:", imei);
        socket.write(Buffer.from([0x01])); // Acknowledge IMEI

        if (!deviceState.has(imei)) {
          deviceState.set(imei, { lastIgnition: null, currentCodeCourse: null });

          // Create IMEI folder inside /var/www/html/IMEI/
          const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(imeiFolder)) {
            fs.mkdirSync(imeiFolder, { recursive: true });
            console.log(` Folder created for IMEI at: ${imeiFolder}`);
          }
        }

        return;
      }

      const avl = parser.getAvl();
      console.log(" Parsed AVL:", JSON.stringify(avl, null, 2));

      if (!avl || !avl.records || avl.records.length === 0) {
        console.warn(" No AVL records found for IMEI:", imei);
        return;
      }

      const state = deviceState.get(imei);
      for (const record of avl.records) {
        const { gps, timestamp, ioElements } = record;

        if (!gps || gps.latitude === 0 || gps.longitude === 0) {
          console.log(" Skipping invalid GPS data for IMEI:", imei);
          continue;
        }

        const io = {
          ignition: (ioElements.find(io => io.id === 0x01)?.value) || 0,
          mouvement: (ioElements.find(io => io.id === 0x02)?.value) || 0,
          gnss_statut: (ioElements.find(io => io.id === 0x03)?.value) || 1,
          CEINTURE: (ioElements.find(io => io.id === 0x05)?.value) || 0,
        };

        if ((io.ignition === 1 && state.lastIgnition === 0) || (io.ignition === 0 && state.lastIgnition === 1)) {
          state.currentCodeCourse = generateUniqueCode();
        }

        const dataToLog = {
          imei: imei,
          record: {
            latitude: gps.latitude,
            longitude: gps.longitude,
            altitude: gps.altitude,
            angle: gps.angle,
            satellites: gps.satellites,
            speed: gps.speed,
            ignition: io.ignition,
            mouvement: io.mouvement,
            gnss_statut: io.gnss_statut,
            CEINTURE: io.CEINTURE,
            currentCodeCourse: state.currentCodeCourse,
            timestamp: new Date(timestamp).toISOString(),
          },
        };

        console.log(" Data:", JSON.stringify(dataToLog, null, 2));
        state.lastIgnition = io.ignition;
      }

    } catch (err) {
      console.error(" Error processing data for IMEI:", imei, err);
    }
  });
});

// === Start TCP Server ===
tcpServer.listen(TCP_PORT, () => {
  console.log(` TCP Server listening on port ${TCP_PORT}`);
});

// === Unique Code Generator ===
function generateUniqueCode() {
  const timestamp = new Date().toISOString();
  const randomNum = Math.floor(Math.random() * 1000);
  return `${timestamp}-${randomNum}`;
}


