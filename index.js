const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Create a MySQL connection
const connection = mysql.createConnection({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
});

connection.connect((error) => {
  if (error) throw error;
  console.log("Successfully connected to the database.");
});

const query = util.promisify(connection.query).bind(connection);

// Create server
let server = net.createServer((c) => {
  console.log("Client connected");

  let imei;
  let intervalId = null;
  let previousIgnition = null;
  let codeunique = null; // Unique code for the current course
  let recordedIgnitionOff = false; // To track if the ignition off state has been recorded

  function generateUniqueCode() {
    const timestamp = new Date().getTime().toString(16);
    const randomNum = Math.floor(Math.random() * 1000);
    return timestamp + randomNum;
  }

  c.on('end', () => {
    console.log("Client disconnected");
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });

  c.on('data', async (data) => {
    try {
      let buffer = data;
      let parser = new Parser(buffer);

      if (parser.isImei) {
        imei = parser.imei;
        console.log("IMEI:", imei);
        c.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
      } else {
        let avl = parser.getAvl();
        var donneGps = avl?.records?.map(({ gps, timestamp, ioElements }) => {
          return { gps, timestamp, ioElements };
        });

        if (donneGps) {
          var detail = donneGps[0].gps;
          var ignition = donneGps[0].ioElements[0]?.value;
          var mouvement = donneGps[0].ioElements[1]?.value;

          if (detail.latitude !== 0 && detail.longitude !== 0) {
            // Check ignition state changes
            if (ignition === 1 && previousIgnition === 0) {
              // Ignition turned ON - Start a new course
              codeunique = generateUniqueCode(); // Generate new unique code for this course
              console.log("New course started, unique code:", codeunique);

              // Insert the second record with ignition OFF (starting new course)
              await query(
                'INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?',
                [[[  
                  detail.latitude,
                  detail.longitude,
                  detail.altitude,
                  detail.angle,
                  detail.satellites,
                  detail.speed,
                  ignition,
                  mouvement,
                  donneGps[0].ioElements[2]?.value,
                  donneGps[0].ioElements[5]?.value,
                  imei,
                  JSON.stringify(donneGps),
                  codeunique, // Use the current unique code for this course
                ]]]
              );
              console.log("Inserted data with ignition 0, starting new course.");

              // Start interval to collect data every 10 seconds
              if (intervalId) {
                clearInterval(intervalId);
              }
              intervalId = setInterval(async () => {
                await query(
                  'INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?',
                  [[[  
                    detail.latitude,
                    detail.longitude,
                    detail.altitude,
                    detail.angle,
                    detail.satellites,
                    detail.speed,
                    ignition,
                    mouvement,
                    donneGps[0].ioElements[2]?.value,
                    donneGps[0].ioElements[5]?.value,
                    imei,
                    JSON.stringify(donneGps),
                    codeunique, // Use the current unique code for this course
                  ]]]
                );
                console.log("Inserted data with ignition 1.");
              }, 10000);

              recordedIgnitionOff = false; // Reset the flag for recording ignition off state
            } else if (ignition === 0 && previousIgnition === 1) {
              // Ignition turned OFF - End the current course
              if (!recordedIgnitionOff) {
                // Insert the first record with ignition OFF
                await query(
                  'INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?',
                  [[[  
                    detail.latitude,
                    detail.longitude,
                    detail.altitude,
                    detail.angle,
                    detail.satellites,
                    detail.speed,
                    ignition,
                    mouvement,
                    donneGps[0].ioElements[2]?.value,
                    donneGps[0].ioElements[5]?.value,
                    imei,
                    JSON.stringify(donneGps),
                    codeunique, // Use the same unique code for this course
                  ]]]
                );
                console.log("Inserted data with ignition 0, ending course.");
                recordedIgnitionOff = true; // Mark that ignition off state has been recorded
              }

              // Stop interval when ignition turns off
              if (intervalId) {
                clearInterval(intervalId);
                intervalId = null;
              }

              codeunique = null; // Reset code for the next course
            }

            previousIgnition = ignition; // Update the previous ignition state
          } else {
            console.log("Lat, Lon is 0, no insertion");
          }
        }

        let writer = new binutils.BinaryWriter();
        writer.WriteInt32(avl.number_of_data);
        let response = writer.ByteBuffer;
        c.write(response); // send ACK for AVL DATA
      }
    } catch (error) {
      console.error("Error processing data:", error);
    }
  });
});

// Function to update the table based on imei
async function updateTable() {
  try {
    const sqlSelect = `
      SELECT * FROM tracking_data 
      WHERE device_uid = ? AND date >= NOW() - INTERVAL 1 MINUTE;`; // Utilisation de 'date' au lieu de 'timestamp'

    const sqlInsert = `
      INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) 
      VALUES ?;`;

    // Supposons que vous ayez de nouvelles données à insérer
    const newData = []; // Ajoutez ici les nouvelles données à insérer

    // Récupérer les données existantes pour l'IMEI donné
    for (const uid of [imei]) { // Utilisation de imei
      const existingRecords = await query(sqlSelect, [uid]);
      
      const filteredData = newData.filter((newRecord) => {
        const isDuplicate = existingRecords.some(existingRecord => {
          const isIgnitionSame = existingRecord.ignition === newRecord.ignition;
          const isSpeedSame = existingRecord.vitesse === newRecord.vitesse;

          // Vérifiez si les coordonnées GPS sont presque identiques
          const areGpsClose = Math.abs(existingRecord.latitude - newRecord.latitude) < 0.0001 && 
                              Math.abs(existingRecord.longitude - newRecord.longitude) < 0.0001;

          return isIgnitionSame && isSpeedSame && areGpsClose;
        });
        return !isDuplicate; // Garder seulement les enregistrements qui ne sont pas des doublons
      });

      if (filteredData.length > 0) {
        await query(sqlInsert, [filteredData.map(record => [
          record.latitude,
          record.longitude,
          record.altitude,
          record.angle,
          record.satellites,
          record.vitesse,
          record.ignition,
          record.mouvement,
          record.gnss_statut,
          record.CEINTURE,
          uid, // Utilisation de imei comme device_uid
          record.json,
          record.CODE_COURSE
        ])]);
        console.log(`Inserted ${filteredData.length} new records for IMEI: ${uid}`);
      } else {
        console.log(`No new records to insert for IMEI: ${uid}`);
      }
    }
    console.log("Table mise à jour avec succès.");
  } catch (error) {
    console.error("Erreur lors de la mise à jour de la table:", error);
  }
}

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
