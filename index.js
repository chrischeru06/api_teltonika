const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require('mysql');
const util = require('util');

// Base de données avec pool de connexions
const pool = mysql.createPool({
  host: "localhost",
  port: "3306",
  user: "cartrackingdvs",
  password: "63p85x:RsU+A/Dd(e7",
  database: "car_trucking",
  connectionLimit: 10,
});
const query = util.promisify(pool.query).bind(pool);

// Générateur de codes uniques
function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

// Fonction pour enregistrer les données
async function saveRecord(detail, ioElements, imei, codeunique, json) {
  const dataToInsert = [
    detail.latitude,
    detail.longitude,
    detail.altitude,
    detail.angle,
    detail.satellites,
    detail.speed,
    ioElements?.[0]?.value || 0, // Ignition
    ioElements?.[1]?.value || 0, // Mouvement
    ioElements?.[2]?.value || 0, // GNSS statut
    ioElements?.[5]?.value || 0, // Ceinture
    imei,
    json,
    codeunique,
  ];

  try {
    await query(
      `INSERT INTO tracking_data(
        latitude, longitude, altitude, angle, satellites, vitesse, 
        ignition, mouvement, gnss_statut, CEINTURE, 
        device_uid, json, CODE_COURSE
      ) VALUES (?)`,
      [dataToInsert]
    );
    console.log("Enregistrement inséré dans la base de données.");
  } catch (err) {
    console.error("Erreur lors de l'insertion des données :", err);
  }
}

// Serveur principal
let server = net.createServer((socket) => {
  console.log("Client connecté");
  let imei = null;
  let isPaused = true; // Pause par défaut
  let isSpeedStarted = false; // Indique si la vitesse > 0 a été détectée pour ignition `1`

  socket.on('data', async (data) => {
    const parser = new Parser(data);

    if (parser.isImei) {
      imei = parser.imei;
      console.log("IMEI:", imei);
      socket.write(Buffer.alloc(1, 1)); // ACK pour IMEI
      return;
    }

    const avl = parser.getAvl();
    if (!avl || !avl.records || avl.records.length === 0) {
      console.log("Pas d'enregistrements AVL trouvés");
      return;
    }

    const record = avl.records[0];
    const { gps: detail, ioElements } = record;

    if (!detail || detail.latitude === 0 || detail.longitude === 0) {
      console.log("Coordonnées GPS invalides, insertion ignorée.");
      return;
    }

    const ignitionStatus = ioElements?.[0]?.value || 0;
    const speed = detail.speed || 0;
    const jsonData = JSON.stringify(avl.records);

    // Récupération du dernier enregistrement
    const lastData = (await query(
      'SELECT ignition, CODE_COURSE FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1',
      [imei]
    ))[0];

    let codeunique = lastData?.CODE_COURSE || generateUniqueCode();
    if (lastData && lastData.ignition !== ignitionStatus) {
      codeunique = generateUniqueCode();
    }

    if (ignitionStatus === 0) {
      // Ignition passe à 0 : Enregistrement immédiat
      console.log("Ignition à 0 détectée : Enregistrement immédiat.");
      await saveRecord(detail, ioElements, imei, codeunique, jsonData);
      isPaused = true; // Pause jusqu'à ce que l'ignition repasse à 1
      isSpeedStarted = false; // Réinitialisation du contrôle de la vitesse
    } else if (ignitionStatus === 1) {
      if (!isSpeedStarted && speed > 0) {
        console.log("Ignition à 1 et vitesse > 0 : Début de l'enregistrement.");
        isPaused = false;
        isSpeedStarted = true;
      }

      if (!isPaused && speed > 0) {
        await saveRecord(detail, ioElements, imei, codeunique, jsonData);
      } else {
        console.log("En attente que la vitesse dépasse 0 pour commencer l'enregistrement.");
      }
    }

    // Envoi d'un ACK pour les données AVL
    const writer = new binutils.BinaryWriter();
    writer.WriteInt32(avl.number_of_data);
    socket.write(writer.ByteBuffer);
  });

  socket.on('end', () => {
    console.log("Client déconnecté");
  });

  socket.on('error', (err) => {
    console.error("Erreur sur le socket :", err);
  });
});

// Démarrage du serveur
server.listen(2354, '141.94.194.193', () => {
  console.log("Serveur démarré sur le port 2354");
});
