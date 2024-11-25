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

  let ignitionState = null; // Variable pour suivre l'état de l'ignition

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
        const currentIgnition = ioElements[0].value; // Supposons que l'ignition soit la première valeur de ioElements

        // Gérer les transitions d'ignition
        if (ignitionState === null || currentIgnition !== ignitionState) {
          if (ignitionState === 1 && currentIgnition === 0) {
            // Enregistrer la donnée lorsque l'ignition passe de 1 à 0
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Data recorded with ignition = 0.");
          }

          ignitionState = currentIgnition; // Met à jour l'état de l'ignition

          if (ignitionState === 1) {
            console.log("Ignition is ON, will continue to record data.");
          }
        }

        // Enregistrer les données uniquement si l'ignition est à 1
        if (ignitionState === 1 && detail.latitude !== 0 && detail.longitude !== 0) {
          await saveData(imei, donneGps[0], currentIgnition);
          console.log("Data recorded with ignition = 1.");
        }
      }

      const writer = new binutils.BinaryWriter();
      writer.WriteInt32(avl.number_of_data);
      c.write(writer.ByteBuffer); // Send ACK for AVL DATA
      c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
    }
  });
});

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});

function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

async function saveData(imei, gpsData, ignition) {
  const detail = gpsData.gps;
  const ioElements = gpsData.ioElements;

  const lastData = await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]);
  const codeunique = lastData.length && lastData[0].ignition !== ignition 
    ? generateUniqueCode() 
    : lastData.length ? lastData[0].CODE_COURSE : generateUniqueCode();

  const detailsData = [
    detail.latitude,
    detail.longitude,
    detail.altitude,
    detail.angle,
    detail.satellites,
    detail.speed,
    ignition,
    ioElements[1].value,
    ioElements[2].value,
    ioElements[5].value,
    imei,
    JSON.stringify(gpsData.records),
    codeunique
  ];

  await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', detailsData);
}
