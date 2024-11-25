const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Création d'une connexion MySQL
const connection = mysql.createConnection({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
});

// Connexion à la base de données
connection.connect((error) => {
  if (error) {
    console.error("Error connecting to the database:", error);
    return;
  }
  console.log("Successfully connected to the database.");
});

const query = util.promisify(connection.query).bind(connection);

// Queue pour stocker les données à enregistrer
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

      // Vérification si donneGps est un tableau et a des éléments
      if (Array.isArray(donneGps) && donneGps.length > 0) {
        const detail = donneGps[0].gps;
        const ioElements = donneGps[0].ioElements;

        // Vérification de la structure des données GPS
        if (!detail || !Array.isArray(ioElements) || ioElements.length === 0) {
          console.error("GPS data or IO elements are missing.");
          return;
        }

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
      } else {
        console.error("No GPS records found or records are not in the expected format.");
        console.log("Received AVL data:", avl); // Log des données AVL pour le débogage
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

// Fonction pour générer un code de course unique pour le dispositif
async function generateUniqueCodeForDevice(deviceUid) {
  const lastData = await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [deviceUid]);

  // Vérifier si lastData est défini et un tableau
  if (lastData && Array.isArray(lastData)) {
    return lastData.length > 0 && lastData[0].CODE_COURSE ? lastData[0].CODE_COURSE : generateUniqueCode();
  } else {
    return generateUniqueCode(); // Si lastData n'est pas valide, retourne un nouveau code unique
  }
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
    ioElements[1]?.value || null, // Utilisation de l'opérateur de coalescence
    ioElements[2]?.value || null,
    ioElements[5]?.value || null,
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
