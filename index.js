// Import required modules
const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Create a connection to the database
const dbConfig = {
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
};

// Utility function to generate a unique code for each trip
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

// Function to handle AVL data insertion
async function handleAvlData(avl, imei, query) {
  if (!avl || !avl.records || avl.records.length === 0) {
    console.log("No AVL records found");
    return;
  }

  for (let record of avl.records) {
    const { gps, timestamp, ioElements } = record;

    // Skip if GPS coordinates are 0,0
    if (gps.latitude === 0 && gps.longitude === 0) {
      console.log("Lat, Long are 0. Skipping...");
      continue;
    }

    let ignition = ioElements.find(io => io.id === 1)?.value; // Assuming ID 1 is ignition

    // Retrieve the last record for the given IMEI
    let lastData;
    try {
      lastData = (await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]))[0];
    } catch (error) {
      console.error("Error retrieving last data:", error);
      continue;
    }

    // Determine CODE_COURSE value
    let codeunique;
    if (lastData) {
      codeunique = lastData.CODE_COURSE;
      if (lastData.ignition !== ignition) {
        codeunique = generateUniqueCode();
      }
    } else {
      codeunique = generateUniqueCode();
    }

    const detailsData = [
      gps.latitude,
      gps.longitude,
      gps.altitude,
      gps.angle,
      gps.satellites,
      gps.speed,
      ignition,
      ioElements[1]?.value || null,  // mouvement
      ioElements[2]?.value || null,  // gnss_statut
      ioElements[5]?.value || null,  // CEINTURE
      imei,
      JSON.stringify(record),
      codeunique
    ];

    try {
      await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?)', [detailsData]);
      console.log("Data inserted successfully for IMEI:", imei);
    } catch (error) {
      console.error("Error inserting data:", error);
    }
  }
}

// Create TCP server
const server = net.createServer((client) => {
  console.log("Client connected");

  // Establish MySQL connection
  const connection = mysql.createConnection(dbConfig);
  const query = util.promisify(connection.query).bind(connection);

  connection.connect((error) => {
    if (error) {
      console.error("Database connection error:", error);
      client.end();
      return;
    }
    console.log("Successfully connected to the database");
  });

  let imei;

  // Handle client data
  client.on('data', async (data) => {
    try {
      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        console.log("IMEI:", imei);
        client.write(Buffer.alloc(1, 1)); // send ACK for IMEI
      } else {
        const avl = parser.getAvl();
        await handleAvlData(avl, imei, query);

        // Send ACK for AVL data
        const writer = new binutils.BinaryWriter();
        writer.WriteInt32(avl.number_of_data);
        client.write(writer.ByteBuffer);
      }
    } catch (error) {
      console.error("Error processing client data:", error);
    }
  });
  client.on('end', () => {
    console.log("Client disconnected");
    connection.end(); // Close the database connection
  });

  client.on('error', (error) => {
    console.error("Client connection error:", error);
    connection.end(); // Ensure the database connection is closed in case of an error
  });
});

// Start the server
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
