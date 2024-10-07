/** Writen by Cerubala Christian Wann'y
 * email: wanny@mediabox.bi
 * tel: +25762442698
 * This code is an API to take data from Teltonika devices and insert the data into a MySQL server.
 */

const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// MySQL Pool Creation
const pool = mysql.createPool({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
  connectionLimit: 10,
});

// Utility to promisify queries
const query = util.promisify(pool.query).bind(pool);

// Function to generate a unique code
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16); // Utilisation du timestamp en base 16
  const randomNum = Math.floor(Math.random() * 1000); // Génération d'un nombre aléatoire entre 0 et 999
  return timestamp + randomNum;
}

// TCP Server Creation
const server = net.createServer((c) => {
  console.log("Client connected");

  let imei;

  c.on('end', () => {
    console.log("Client disconnected");
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
        console.log(avl);
        let donneGps = avl?.records?.map(({ gps, timestamp, ioElements }) => ({ gps, timestamp, ioElements }));

        if (donneGps && donneGps.length > 0) {
          let detail = donneGps[0].gps;
          let detail2 = donneGps[0].ioElements[0];
          let detail3 = donneGps[0].ioElements[1];
          let detail4 = donneGps[0].ioElements[2];
          let detail5 = donneGps[0].ioElements[5];

          if (detail.latitude !== 0 && detail.longitude !== 0) {
            const lastData = (await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]))[0];
            let codeunique;

            if (lastData) {
              codeunique = lastData.CODE_COURSE;
              if (lastData.ignition !== detail2.value) {
                codeunique = generateUniqueCode();
              }
            } else {
              codeunique = generateUniqueCode();
            }

            const detailsData = [
              [
                detail.latitude,
                detail.longitude,
                detail.altitude,
                detail.angle,
                detail.satellites,
                detail.speed,
                detail2.value,
                detail3.value,
                detail4.value,
                detail5.value,
                imei,
                JSON.stringify(donneGps),
                codeunique
              ]
            ];

            await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [detailsData]);
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

// Server listening
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
