/** Writen by Cerubala Christian Wann'y

email: wanny@mediabox.bi
tel: +25762442698
This code is an API that helps to take data from Teltonika devices and insert the data into a MySQL server
*/
const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Create a single MySQL connection
const connection = mysql.createConnection({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
});

// Connect to the database
connection.connect((error) => {
  if (error) {
    console.error("Error connecting to the database:", error);
    return;
  }
  console.log("Successfully connected to the database.");
});

const query = util.promisify(connection.query).bind(connection);

const server = net.createServer((c) => {
  console.log("Client connected");

  let ignitionState = null; // Variable to track ignition state

  c.on('end', () => {
    console.log("Client disconnected");
  });

  c.on('data', async (data) => {
    try {
      const parser = new Parser(data);

      if (parser.isImei) {
        const imei = parser.imei;
        console.log("IMEI:", imei);
        c.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
      } else {
        const avl = parser.getAvl();

        // Validate AVL data
        if (!avl || !avl.records) {
          console.error("Invalid AVL data or missing records:", avl);
          return; // Exit if no records
        }

        const donneGps = avl.records;

        // Validate GPS data
        if (!donneGps.length) {
          console.error("No GPS data in AVL records:", donneGps);
          return; // Exit if no valid GPS data
        }

        const detail = donneGps[0].gps || {};
        const ioElements = donneGps[0].ioElements || [];
        const currentIgnition = ioElements?.[0]?.value;

        if (currentIgnition === undefined) {
          console.error("Missing ignition data in IO elements:", ioElements);
          return; // Exit if ignition data is missing
        }

        // Handle ignition transitions
        if (ignitionState === null || currentIgnition !== ignitionState) {
          if (ignitionState === 1 && currentIgnition === 0) {
            // Record data when ignition goes from ON to OFF
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Data recorded with ignition = 0.");
          }

          if (ignitionState === 1 && detail.speed === 0) {
            // Record speed == 0
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Save with speed = 0.");
          }

          ignitionState = currentIgnition; // Update ignition state

          if (ignitionState === 1) {
            console.log("Ignition is ON, will continue to record data.");
          }
        }

        // Record data when ignition is ON and speed > 0
        if (ignitionState === 1 && detail.latitude && detail.longitude && detail.speed > 0) {
          try {
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Data saved with ignition = 1 and speed > 0.");
          } catch (error) {
            console.error("Error saving data:", error);
          }
        } else {
          console.log("Conditions not met for data recording.");
        }

        const writer = new binutils.BinaryWriter();
        writer.WriteInt32(avl.number_of_data);
        c.write(writer.ByteBuffer); // Send ACK for AVL DATA
        c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
      }
    } catch (error) {
      console.error("Error processing data:", error);
    }
  });
});

// Server listening
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});

// Function to generate a unique code
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

// Function to save data to the database
async function saveData(imei, gpsData, ignition) {
  const detail = gpsData.gps || {};
  const ioElements = gpsData.ioElements || [];

  let lastData;
  try {
    lastData = await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]);
    console.log("Last data fetched:", lastData); // Log to check what is fetched
  } catch (error) {
    console.error("Database query error:", error);
    return; // Exit the function if there's an error
  }

  let codeunique;
  if (Array.isArray(lastData) && lastData.length) {
    if (lastData[0].ignition !== ignition) {
      codeunique = generateUniqueCode();
    } else {
      codeunique = lastData[0].CODE_COURSE;
    }
  } else {
    codeunique = generateUniqueCode(); // Handle case where lastData is empty or undefined
  }

  const detailsData = [
    detail.latitude || 0,
    detail.longitude || 0,
    detail.altitude || 0,
    detail.angle || 0,
    detail.satellites || 0,
    detail.speed || 0,
    ignition,
    ioElements[1]?.value || null,
    ioElements[2]?.value || null,
    ioElements[5]?.value || null,
    imei,
    JSON.stringify(gpsData.records || []),
    codeunique,
  ];

  try {
    await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', detailsData);
  } catch (error) {
    console.error("Error inserting data:", error);
  }
}
