const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require('mysql');
const util = require('util');

// Database connection pool
const pool = mysql.createPool({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
  connectionLimit: 10,
});
const query = util.promisify(pool.query).bind(pool);

// Utility to generate unique trip codes
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16); // Base 16 timestamp
  const randomNum = Math.floor(Math.random() * 1000); // Random number (0-999)
  return timestamp + randomNum;
}

// Function to save a record to the database
async function saveRecord(detail, ioElements, imei, codeunique, json) {
  const dataToInsert = [
    detail.latitude,
    detail.longitude,
    detail.altitude,
    detail.angle,
    detail.satellites,
    detail.speed,
    ioElements?.[0]?.value || 0, // Ignition
    ioElements?.[1]?.value || 0,
    ioElements?.[2]?.value || 0,
    ioElements?.[5]?.value || 0,
    imei,
    json,
    codeunique,
  ];

  try {
    await query(
      `INSERT INTO tracking_data(
        latitude, longitude, altitude, angle, satellites, vitesse, 
        ignition, mouvement, gnss_statut, CEINTURE, 
        device_uid, json, CODE_COURSE
      ) VALUES (?)`,
      [dataToInsert]
    );
    console.log("Record successfully inserted into the database.");
  } catch (err) {
    console.error("Error saving data to the database: ", err);
  }
}

// Main server logic
let server = net.createServer((socket) => {
  console.log("Client connected");
  let imei = null;
  let saveForIgnition0 = false; // Timer flag for saving when ignition is 0
  let codeunique = null;

  socket.on('data', async (data) => {
    const parser = new Parser(data);

    if (parser.isImei) {
      imei = parser.imei;
      console.log("IMEI:", imei);
      socket.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
      return;
    }

    const avl = parser.getAvl();
    if (!avl || !avl.records || avl.records.length === 0) {
      console.log("No AVL records found");
      return;
    }

    const record = avl.records[0];
    const { gps: detail, ioElements } = record;

    if (!detail || detail.latitude === 0 || detail.longitude === 0) {
      console.log("Invalid GPS coordinates, skipping insertion.");
      return;
    }

    const ignitionStatus = ioElements?.[0]?.value || 0;
    const jsonData = JSON.stringify(avl.records);

    // Retrieve the last record for the device
    const lastData = (await query(
      'SELECT ignition, CODE_COURSE FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1',
      [imei]
    ))[0];

    if (!codeunique) {
      codeunique = lastData?.CODE_COURSE || generateUniqueCode();
    }

    if (lastData && lastData.ignition !== ignitionStatus) {
      if (ignitionStatus === 0) {
        console.log("Ignition changed to 0: Starting 23 seconds saving.");
        saveForIgnition0 = true;

        // Save for 23 seconds, then stop
        setTimeout(() => {
          saveForIgnition0 = false;
          console.log("Stopped saving for ignition 0 after 23 seconds.");
        }, 23000);
      } else if (ignitionStatus === 1) {
        console.log("Ignition changed to 1: Resuming data saving.");
        codeunique = generateUniqueCode();
      }
    }

    // Save records based on the conditions
    if (saveForIgnition0 || ignitionStatus === 1) {
      await saveRecord(detail, ioElements, imei, codeunique, jsonData);
    }

    // Send ACK for AVL DATA
    const writer = new binutils.BinaryWriter();
    writer.WriteInt32(avl.number_of_data);
    socket.write(writer.ByteBuffer);
  });

  socket.on('end', () => {
    console.log("Client disconnected");
  });

  socket.on('error', (err) => {
    console.error("Socket error:", err);
  });
});

// Start server
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
