/** Writen by Cerubala Christian Wann'y
 * email: wanny@mediabox.bi
 * tel: +25762442698
 * This code is an API that helps to take data from Teltonika devices and insert the data into a MySQL server
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
    const parser = new Parser(data);
    
    if (parser.isImei) {
      const imei = parser.imei;
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
    } else {
      const avl = parser.getAvl();
      const donneGps = avl.records;

      if (donneGps.length > 0) {
        const detail = donneGps[0].gps;
        const ioElements = donneGps[0].ioElements;
        const currentIgnition = ioElements[0].value; // Assuming ignition is the first value of ioElements

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
            console.log("Saved with speed = 0");
          }

          ignitionState = currentIgnition; // Update ignition state

          if (ignitionState === 1) {
            console.log("Ignition is ON, will continue to record data.");
          }
        }

        // Enregistrer les données uniquement si l'allumage est activé
        if (ignitionState === 1 && detail.latitude !== 0 && detail.longitude !== 0 && detail.speed > 0) {
          try {
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Données enregistrées avec l'allumage = 1 et vitesse diff de 0");
          } catch (error) {
            console.error("Erreur lors de l'enregistrement des données :", error);
          }
        } else {
          console.log("Conditions non remplies pour l'enregistrement des données.");
        }
      }

      const writer = new binutils.BinaryWriter();
      writer.WriteInt32(avl.number_of_data);
      c.write(writer.ByteBuffer); // Send ACK for AVL DATA
      c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
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
    const detail = gpsData.gps;
    const ioElements = gpsData.ioElements;

    let lastData;
    try {
        lastData = await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]);
        console.log("Last data fetched:", lastData);
    } catch (error) {
        console.error("Database query error:", error);
        return; // Exit the function if there's an error
    }

    // Check if lastData is valid
    if (!lastData || !Array.isArray(lastData)) {
        console.error("No last data found for IMEI:", imei);
        return; // Exit or handle as needed
    }

    let codeunique;
    if (lastData.length > 0) {
        if (lastData[0].ignition !== ignition) {
            codeunique = generateUniqueCode();
        } else {
            codeunique = lastData[0].CODE_COURSE;
        }
    } else {
        codeunique = generateUniqueCode(); // Handle case where lastData is empty
    }

    const detailsData = [
        detail.latitude,
        detail.longitude,
        detail.altitude,
        detail.angle,
        detail.satellites,
        detail.speed,
        ignition,
        ioElements[1]?.value, // Optional chaining to avoid undefined errors
        ioElements[2]?.value,
        ioElements[5]?.value,
        imei,
        JSON.stringify(gpsData.records),
        codeunique
    ];

    try {
        await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', detailsData);
        console.log("Data successfully saved for IMEI:", imei);
    } catch (error) {
        console.error("Error inserting data:", error);
    }
}
