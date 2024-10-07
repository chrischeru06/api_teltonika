const net = require('net');
const Parser = require('teltonika-parser-ex');
const mysql = require("mysql");
const util = require("util");

// Configuration MySQL
const connection = mysql.createConnection({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
});

// Open MySQL connection
connection.connect((error) => {
  if (error) throw error;
  console.log("Successfully connected to the database.");
});

const query = util.promisify(connection.query).bind(connection);

let lastIgnitionChange = null;
let lastIgnition = null;
let intervalId = null;
let sentDataWithSpeedZero = false; // Flag pour contrôle envoi unique vitesse = 0
let lastSpeedZeroDataId = null; // ID de la dernière donnée envoyée avec vitesse = 0
let timeSinceLastSpeedZeroDataSent = null; // Temps depuis la dernière donnée envoyée avec vitesse = 0

// Fonction pour envoyer les données vers la base de données
async function sendData(detailsData) {
  const dataToInsert = detailsData.map((data) => [
    data.gps.latitude,
    data.gps.longitude,
    data.gps.altitude,
    data.gps.angle,
    data.gps.satellites,
    data.gps.speed,
    data.ioElements.find(e => e.id === 'ignition')?.value,
    data.ioElements.find(e => e.id === 'mouvement')?.value,
    data.ioElements.find(e => e.id === 'gnss_statut')?.value,
    data.ioElements.find(e => e.id === 'CEINTURE')?.value,
    'some_device_uid', // Ajouter ici l'UID du device
    JSON.stringify(data),
    'some_code_course' // Ajouter ici le code course
  ]);

  try {
    const result = await query('INSERT INTO tracking_data (latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [dataToInsert]);
    lastSpeedZeroDataId = result.insertId; // Enregistrer l'ID de la dernière insertion
  } catch (err) {
    console.error("Error inserting data:", err);
  }
}

// Fonction pour vérifier si les données doivent être envoyées
function shouldSendData(lastIgnition, currentIgnition) {
  const currentTime = new Date();
  
  if (lastIgnition !== currentIgnition) {
    if (!lastIgnitionChange || currentTime - lastIgnitionChange > 60 * 1000) {
      lastIgnitionChange = currentTime;
      return true;
    }
    return false; // Ignition a changé trop rapidement (< 1 min)
  }
  
  return true; // Aucune transition rapide d'ignition
}

// Vérification pour supprimer la donnée si aucune nouvelle donnée avec vitesse différente de 0 n'est reçue
function checkSpeedZeroData(currentTime) {
  if (lastSpeedZeroDataId) {
    const timeSinceLastData = currentTime - timeSinceLastSpeedZeroDataSent;
    if (timeSinceLastData >= 60 * 1000) { // Si plus d'une minute s'est écoulée
      deleteDataFromDB(lastSpeedZeroDataId); // Supprimer la donnée de la base de données
      lastSpeedZeroDataId = null; // Réinitialiser l'ID
    }
  }
}

// Fonction pour supprimer une donnée de la base de données
async function deleteDataFromDB(dataId) {
  try {
    await query('DELETE FROM tracking_data WHERE id = ?', [dataId]);
    console.log("Deleted data from DB with ID:", dataId);
  } catch (err) {
    console.error("Error deleting data:", err);
  }
}

// Serveur Teltonika
let server = net.createServer((c) => {
  console.log("Client connected");
  let imei;
  
  c.on('data', async (data) => {
    let buffer = data;
    let parser = new Parser(buffer);

    if (parser.isImei) {
      imei = parser.imei;
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); // ACK IMEI
    } else {
      let avl = parser.getAvl();
      let gpsData = avl.records.map(({ gps, ioElements }) => ({ gps, ioElements }));
      let ignition = gpsData[0]?.ioElements.find(e => e.id === 'ignition')?.value;
      let speed = gpsData[0]?.gps?.speed;
      
      if (imei && gpsData.length) {
        let currentIgnition = ignition;
        const currentTime = new Date();

        // Cas 1: Ignition = 1, vitesse > 0, envoyer toutes les 5 secondes
        if (speed > 0 && ignition === 1 && shouldSendData(lastIgnition, currentIgnition)) {
          sentDataWithSpeedZero = false; // Réinitialiser
          clearInterval(intervalId);
          intervalId = setInterval(() => {
            sendData(gpsData); 
          }, 5 * 1000); // 5 secondes
        } 
        // Cas 2: Ignition = 1, vitesse = 0, envoyer une seule fois
        else if (ignition === 1 && speed === 0 && !sentDataWithSpeedZero) {
          clearInterval(intervalId);
          await sendData(gpsData); // Envoyer une seule fois
          sentDataWithSpeedZero = true; // Empêcher d'envoyer à nouveau jusqu'à changement
          timeSinceLastSpeedZeroDataSent = currentTime; // Réinitialiser le temps
        }
        // Cas 3: Ignition = 0, vitesse = 0, envoyer toutes les 10 minutes
        else if (ignition === 0 && speed === 0) {
          sentDataWithSpeedZero = false; // Réinitialiser
          clearInterval(intervalId);
          intervalId = setInterval(() => {
            sendData(gpsData); 
          }, 10 * 60 * 1000); // 10 minutes
        }

        // Vérifier et éventuellement supprimer la donnée de vitesse = 0
        checkSpeedZeroData(currentTime);
      }
      
      lastIgnition = ignition; // Mettre à jour l'état de l'ignition
    }
  });

  c.on('end', () => {
    console.log("Client disconnected");
    clearInterval(intervalId);
  });
});

// Démarrer le serveur
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on 2354");
});
