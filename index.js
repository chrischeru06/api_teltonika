/**
 * Écrit par Cerubala Christian Wann'y
 * email: wanny@mediabox.bi
 * tel: +25762442698
 * API pour recevoir des données des appareils Teltonika et les insérer dans une base de données MySQL
 */

const net = require('net');
const Parser = require('teltonika-parser-ex');
const mysql = require("mysql");
const util = require("util");

// Création de la connexion MySQL avec un pool
const db = mysql.createPool({
  host: "localhost", // Remplacez par votre hôte
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
});

// Promisify pour exécuter des requêtes SQL
const query = util.promisify(db.query).bind(db);

// Génération d'un code unique
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

// Création du serveur
const server = net.createServer((socket) => {
  console.log("Client connecté :", socket.remoteAddress);

  let imei;
  let ignition = 0; // Suivi de l'état de l'ignition
  let isRecording = false; // Indique si les données doivent être enregistrées

  // Gestion des données reçues
  socket.on('data', async (data) => {
    if (!data || data.length === 0) {
      console.warn("Données vides reçues, ignorées.");
      return;
    }

    try {
      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        console.log("IMEI reçu :", imei);
        socket.write(Buffer.alloc(1, 1)); // Accusé de réception IMEI
      } else {
        const avl = parser.getAvl();
        const records = avl.records;

        for (const record of records) {
          const gps = record.gps;
          const ioElements = record.ioElements;
          const timestamp = record.timestamp;

          if (gps && gps.latitude !== 0 && gps.longitude !== 0) {
            const newIgnition = ioElements?.[0]?.value || 0; // Ignition actuelle
            const speed = gps.speed || 0;

            if (newIgnition === 1) {
              if (!isRecording && speed > 0) {
                isRecording = true;
                ignition = newIgnition;
                console.log("Ignition à 1 et vitesse > 0 : enregistrement activé.");
              }
            } else if (newIgnition === 0) {
              if (ignition !== 0) {
                ignition = 0;
                isRecording = false;
                console.log("Ignition à 0 : enregistrement immédiat.");
              }
            }

            if (isRecording) {
              const lastData = (await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei]))[0];
              let codeunique = lastData && lastData.ignition !== newIgnition ? generateUniqueCode() : lastData?.CODE_COURSE || generateUniqueCode();

              const detailsData = [
                [
                  gps.latitude,
                  gps.longitude,
                  gps.altitude,
                  gps.angle,
                  gps.satellites,
                  speed,
                  newIgnition,
                  ioElements?.[1]?.value || 0, // Mouvement
                  ioElements?.[2]?.value || 0, // GNSS Status
                  ioElements?.[5]?.value || 0, // Ceinture
                  imei,
                  JSON.stringify(record),
                  codeunique,
                ]
              ];

              await query(
                `INSERT INTO tracking_data (
                  latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE
                ) VALUES ?`,
                [detailsData]
              );

              console.log("Données insérées avec succès.");
            }
          } else {
            console.log("Données GPS invalides (lat/lon = 0), aucune insertion.");
          }
        }

        const response = Buffer.alloc(4);
        response.writeInt32BE(avl.number_of_data, 0);
        socket.write(response); // Accusé de réception des données AVL
      }
    } catch (err) {
      console.error("Erreur lors du traitement des données :", err);
    }
  });

  // Gestion des erreurs de socket
  socket.on('error', (err) => {
    if (err.code === 'ECONNRESET') {
      console.warn("Connexion réinitialisée par le client :", socket.remoteAddress);
    } else {
      console.error("Erreur de socket :", err);
    }
  });

  // Gestion de la fin de connexion
  socket.on('end', () => {
    console.log("Client déconnecté :", socket.remoteAddress);
  });

  // Gestion des délais
  socket.setTimeout(60000); // Timeout de 60 secondes
  socket.on('timeout', () => {
    console.warn("Délai dépassé pour le client :", socket.remoteAddress);
    socket.end();
  });
});

// Configuration du serveur
server.listen(2354, '141.94.194.193', () => {
  console.log("Serveur démarré sur le port 2354.");
});
