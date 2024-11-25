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

// Queue for storing data to be saved
let dataQueue = [];
let intervalId = null;

const server = net.createServer((c) => {
  console.log("Client connected");

  let imei; // IMEI du dispositif
  let ignitionState = null; 
  let currentCodeCourse = null; // Code de course à utiliser pour les enregistrements

  c.on('end', () => {
    console.log("Client disconnected");
    clearInterval(intervalId); // Nettoyer l'intervalle lorsque le client se déconnecte
  });

  c.on('data', async (data) => {
    const parser = new Parser(data);
    
    if (parser.isImei) {
      imei = parser.imei; // Assigne la valeur à la variable imei
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); 
    } else {
      // Vérification que imei est défini avant de l'utiliser
      if (!imei) {
        console.error("IMEI is not defined. Cannot process data.");
        return; // Sortir si imei n'est pas défini
      }

      const avl = parser.getAvl();
      const donneGps = avl.records;

      if (donneGps.length > 0) {
        const detail = donneGps[0].gps;
        const ioElements = donneGps[0].ioElements;

        const currentIgnition = ioElements[0].value;

        // Gestion de l'ignition
        if (ignitionState !== currentIgnition) {
          if (ignitionState === 0 && currentIgnition === 1) {
            // L'ignition passe de 0 à 1
            console.log("Ignition ON. Start recording data every 5 seconds.");
            currentCodeCourse = await generateUniqueCodeForDevice(imei); // Générer un code de course unique
            intervalId = setInterval(() => {
              queueData(imei, donneGps[0], currentIgnition, currentCodeCourse);
            }, 5000);
          } else if (ignitionState === 1 && currentIgnition === 0) {
            // L'ignition passe de 1 à 0
            console.log("Ignition OFF. Immediate data recording.");
            queueData(imei, donneGps[0], currentIgnition, generateUniqueCode()); // Nouveau code de course
            clearInterval(intervalId); // Arrêter l'enregistrement toutes les 5 secondes
          }
          ignitionState = currentIgnition; // Mettre à jour l'état de l'ignition
        }
      }

      const writer = new binutils.BinaryWriter();
      writer.WriteInt32(avl.number_of_data);
      c.write(writer.ByteBuffer); 
      c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
    }
  });
});

// Fonction pour générer un code unique
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

// Fonction pour mettre en file les données
function queueData(imei, gpsData, ignition, codeCourse) {
  const detail = gpsData.gps;
  const ioElements = gpsData.ioElements;

  const record = [
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
    codeCourse
  ];

  dataQueue.push(record);
}

// Process the data queue at regular intervals
setInterval(async () => {
  if (dataQueue.length > 0) {
    const dataToInsert = dataQueue.splice(0, dataQueue.length); // Take all data to insert
    await saveBatchData(dataToInsert);
  }
}, 5000); // Ajuster l'intervalle si nécessaire

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});

// Fonction pour enregistrer les données par lots
async function saveBatchData(dataBatch) {
  const insertPromises = dataBatch.map(data => {
    return query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', data)
      .catch(error => {
        console.error("Error inserting data:", data, error);
        throw error; // Relancer l'erreur après l'avoir loguée
      });
  });

  try {
    await Promise.all(insertPromises);
    console.log(`Inserted ${insertPromises.length} records into the database.`);
  } catch (error) {
    console.error("Error saving data batch:", error);
  }
}
