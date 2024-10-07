const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const path = require('path');
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
let intervalId = null;
let sendDataInterval = 5 * 1000; // 5 secondes par défaut
let sentDataWithSpeedZero = false; // Flag pour contrôler l'envoi unique avec vitesse = 0

// Fonction pour envoyer les données vers la base de données
async function sendData(detailsData) {
  try {
    await query('INSERT INTO tracking_data (latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [detailsData]);
  } catch (err) {
    console.error("Error inserting data:", err);
  }
}

// Fonction pour vérifier l'état d'ignition
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

// Serveur Teltonika
let server = net.createServer((c) => {
  console.log("client connected");
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
      let ignition = gpsData[0]?.ioElements[0]?.value;
      let speed = gpsData[0]?.gps?.speed;
      
      if (imei && gpsData.length) {
        let currentIgnition = ignition;

        // Cas 1: Ignition = 1, vitesse > 0, envoyer toutes les 5 secondes
        if (speed > 0 && ignition === 1 && shouldSendData(lastIgnition, currentIgnition)) {
          sentDataWithSpeedZero = false; // Réinitialiser
          clearInterval(intervalId);
          sendDataInterval = 5 * 1000;
          intervalId = setInterval(() => {
            sendData(gpsData); 
          }, sendDataInterval);
        } 
        // Cas 2: Ignition = 1, vitesse = 0, envoyer une seule fois
        else if (ignition === 1 && speed === 0 && !sentDataWithSpeedZero) {
          clearInterval(intervalId);
          sendData(gpsData); // Envoyer une seule fois
          sentDataWithSpeedZero = true; // Empêcher d'envoyer à nouveau jusqu'à changement
        }
        // Cas 3: Ignition = 0, vitesse = 0, envoyer toutes les 10 minutes
        else if (ignition === 0 && speed === 0) {
          sentDataWithSpeedZero = false; // Réinitialiser
          clearInterval(intervalId);
          sendDataInterval = 10 * 60 * 1000; // 10 minutes
          intervalId = setInterval(() => {
            sendData(gpsData); 
          }, sendDataInterval);
        }
      }
      
      lastIgnition = currentIgnition;
    }
  });

  c.on('end', () => {
    console.log("client disconnected");
    clearInterval(intervalId);
  });
});

// Démarrer le serveur
server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on 2354");
});
