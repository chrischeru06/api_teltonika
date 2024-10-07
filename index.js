/** 
 * Written by Cerubala Christian Wann'y 
 * email: wanny@mediabox.bi 
 * tel: +25762442698 
 * This code is an API that helps to take data from Teltonika devices and insert the data into a MySQL server 
 */

const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Create a connection to the database
let server = net.createServer((c) => {
  console.log("Client connected");

  const connection = mysql.createConnection({
    host: "localhost",
    port: "3306",
    user: "cartrackingdvs",
    password: "63p85x:RsU+A/Dd(e7",
    database: "car_trucking",
  });

  // Open the MySQL connection
  connection.connect((error) => {
    if (error) throw error;
    console.log("Successfully connected to the database.");
  });

  const query = util.promisify(connection.query).bind(connection);

  c.on('end', () => {
    console.log("Client disconnected");
    connection.end();
  });

  function generateUniqueCode() {
    const timestamp = new Date().getTime().toString(16); // Use timestamp in base 16
    const randomNum = Math.floor(Math.random() * 1000); // Generate a random number between 0 and 999
    const uniqueCode = timestamp + randomNum;

    return uniqueCode;
  }

  let imei;
  let currentCodeUnique = null;
  let lastIgnition = null;
  let lastIgnitionChangeTime = null;
  let lastSpeedInsertTime = null;
  let lastInsertTime = null;

  async function insertTrackingData(detail, data, imei, codeunique, isTemporary) {
    const detailsData = [
      [
        detail.latitude,
        detail.longitude,
        detail.altitude,
        detail.angle,
        detail.satellites,
        detail.speed,
        data.ioElements[0]?.value || 0, // Ignition
        data.ioElements[1]?.value || 0, // Movement
        data.ioElements[2]?.value || 0, // GNSS status
        data.ioElements[5]?.value || 0, // Seat belt status
        imei,
        JSON.stringify(data),
        codeunique,
        isTemporary ? 1 : 0 // Flag to mark temporary records
      ]
    ];

    await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE, temporary) VALUES ?', [detailsData]);
  }

  async function deleteTemporaryData(imei) {
    await query('DELETE FROM tracking_data WHERE device_uid = ? AND temporary = 1', [imei]);
  }

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
        console.log(avl);
        let donneGps = avl?.records?.map(({ gps, timestamp, ioElements }) => ({ gps, timestamp, ioElements }));

        if (donneGps && donneGps.length > 0) {
          let detail = donneGps[0].gps;
          let ignition = donneGps[0].ioElements[0]?.value;
          let speed = detail.speed;

          if (detail.latitude !== 0 && detail.longitude !== 0) {
            const currentTime = new Date().getTime();

            if (lastIgnition !== null && lastIgnition !== ignition) {
              // Changement d'ignition : générer un nouveau code unique
              currentCodeUnique = generateUniqueCode();

              // Enregistrer les premières données temporairement
              await insertTrackingData(detail, donneGps[0], imei, currentCodeUnique, true);
              lastIgnitionChangeTime = currentTime;

              // Vérifier si le changement d'ignition s'est produit en moins d'une minute
              if (lastIgnitionChangeTime && currentTime - lastIgnitionChangeTime < 60 * 1000) {
                await deleteTemporaryData(imei);
                console.log("Changement d'ignition trop rapide, suppression des données temporaires.");
                return;
              }

              lastIgnition = ignition;
            }

            // Handle subsequent data points based on the conditions
            if (ignition === 1) {
              if (speed === 0) {
                console.log("Vitesse est 0, attendre avant enregistrement.");
              } else {
                // Insert data every 5 seconds if speed is non-zero
                if (!lastSpeedInsertTime || currentTime - lastSpeedInsertTime >= 5 * 1000) {
                  await insertTrackingData(detail, donneGps[0], imei, currentCodeUnique, false);
                  lastSpeedInsertTime = currentTime;
                }
              }
            } else if (ignition === 0 && speed === 0) {
              // Insert data every 10 minutes
              if (!lastInsertTime || currentTime - lastInsertTime >= 10 * 60 * 1000) {
                await insertTrackingData(detail, donneGps[0], imei, currentCodeUnique, false);
                lastInsertTime = currentTime;
              }
            }
          } else {
            console.log("Lat, log are 0, no insertion");
          }
        }

        let writer = new binutils.BinaryWriter();
        writer.WriteInt32(avl.number_of_data);
        let response = writer.ByteBuffer;

        c.write(response); // Send ACK for AVL DATA
        c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
      }
    } catch (error) {
      console.error("Error processing data: ", error);
    }
  });

});

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
