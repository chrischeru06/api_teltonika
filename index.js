/**
 * Teltonika GPS Tracker Server - Version corrigée
 * Auteur: Cerubala Christian Wann'y
 */

const net = require('net');
const Parser = require('teltonika-parser-ex');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const winston = require('winston');

// === Configuration ===
const TCP_PORT = 2354;
const TCP_TIMEOUT = 300000; // 5 minutes
const IMEI_FOLDER_BASE = '/var/www/html/IMEI';
const MAX_GEOJSON_SIZE_BYTES = 100 * 1024 * 1024; // 100 Mo

// Création du dossier IMEI si inexistant
if (!fs.existsSync(IMEI_FOLDER_BASE)) {
  fs.mkdirSync(IMEI_FOLDER_BASE, { recursive: true });
}

// Logger structuré avec Winston
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

// Etat par IMEI
const deviceState = new Map();

const dbConfig = {
  host: 'localhost',
  user: 'root',
  password: 'Chris@1996..',
  database: 'car_trucking_v3',
  waitForConnections: true,
  connectionLimit: 50,
  queueLimit: 0,
};

let db;

async function initDbPool() {
  try {
    db = await mysql.createPool(dbConfig);
    logger.info('MySQL pool created');
  } catch (err) {
    logger.error('MySQL pool creation failed: ' + err.message);
    setTimeout(initDbPool, 5000);
  }
}
initDbPool();

db?.on('error', err => {
  logger.error('MySQL connection error: ' + err.message);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    logger.info('Reconnecting to MySQL...');
    initDbPool();
  } else {
    throw err;
  }
});

function toMysqlDatetime(isoDate) {
  return isoDate.replace('T', ' ').replace('Z', '').split('.')[0];
}

async function insertTrackingData(values) {
  const insertQuery = `
    INSERT INTO tracking_data (
      latitude, longitude, vitesse, altitude, date,
      angle, satellites, mouvement, gnss_statut,
      device_uid, ignition
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  try {
    await db.execute(insertQuery, values);
    logger.info(`Data inserted into DB for IMEI: ${values[9]}`);
  } catch (dbErr) {
    logger.error('MySQL Insert Error: ' + dbErr.message);
  }
}

function getNewGeojsonFilePath(imei, baseName, index = 0) {
  const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
  if (!fs.existsSync(imeiFolder)) fs.mkdirSync(imeiFolder, { recursive: true });

  const suffix = index > 0 ? `_${index}` : '';
  return path.join(imeiFolder, `${baseName}${suffix}.geojson`);
}

async function writeGeojsonFile(imei, baseName, points) {
  let index = 0;
  let filePath = getNewGeojsonFilePath(imei, baseName, index);

  // Construire GeoJSON
  const geojson = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: points.map(p => p.geometry.coordinates),
        },
        properties: {
          imei,
          startTime: points[0]?.properties.timestamp,
          endTime: points[points.length - 1]?.properties.timestamp,
          totalPoints: points.length,
        }
      }
    ]
  };

  let jsonStr = JSON.stringify(geojson, null, 2);
  let size = Buffer.byteLength(jsonStr);

  // Si taille > 100 Mo, découper en plusieurs fichiers
  if (size > MAX_GEOJSON_SIZE_BYTES) {
    // On découpe les points en morceaux (approximation)
    const maxPointsPerFile = Math.floor(points.length * (MAX_GEOJSON_SIZE_BYTES / size));
    let start = 0;

    while (start < points.length) {
      const chunkPoints = points.slice(start, start + maxPointsPerFile);
      const chunkGeojson = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: chunkPoints.map(p => p.geometry.coordinates),
            },
            properties: {
              imei,
              startTime: chunkPoints[0]?.properties.timestamp,
              endTime: chunkPoints[chunkPoints.length - 1]?.properties.timestamp,
              totalPoints: chunkPoints.length,
            }
          }
        ]
      };

      filePath = getNewGeojsonFilePath(imei, baseName, index);
      await fs.promises.writeFile(filePath, JSON.stringify(chunkGeojson, null, 2));
      logger.info(`GeoJSON chunk saved: ${filePath}`);

      // Enregistrer en base le chemin
      try {
        await db.execute(
          `INSERT INTO path_histo_trajet_geojson (DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE)
           VALUES (?, ?, ?, ?)`,
          [imei, chunkGeojson.features[0].properties.startTime, chunkGeojson.features[0].properties.endTime, filePath]
        );
        logger.info(`Metadata saved to DB for chunk #${index} IMEI ${imei}`);
      } catch (err) {
        logger.error('Failed to save chunk metadata: ' + err.message);
      }

      index++;
      start += maxPointsPerFile;
    }

  } else {
    // Taille ok, écrire fichier unique
    await fs.promises.writeFile(filePath, jsonStr);
    logger.info(`GeoJSON file saved: ${filePath}`);

    // Enregistrer en base
    try {
      await db.execute(
        `INSERT INTO path_histo_trajet_geojson (DEVICE_UID, TRIP_START, TRIP_END, PATH_FILE)
         VALUES (?, ?, ?, ?)`,
        [imei, geojson.features[0].properties.startTime, geojson.features[0].properties.endTime, filePath]
      );
      logger.info(`Metadata saved to DB for IMEI ${imei}`);
    } catch (err) {
      logger.error('Failed to save metadata: ' + err.message);
    }
  }
}

const tcpServer = net.createServer(socket => {
  logger.info('TCP client connected');
  let imei = null;
  socket.setTimeout(TCP_TIMEOUT);

  socket.on('timeout', () => {
    logger.info('TCP connection timed out');
    socket.end();
  });

  socket.on('end', () => {
    logger.info('TCP client disconnected');
    if (imei) deviceState.delete(imei);
  });

  socket.on('error', err => {
    logger.error('Socket error: ' + err.message);
    if (imei) deviceState.delete(imei);
  });

  socket.on('data', async data => {
    try {
      logger.info('Raw data received (hex): ' + data.toString('hex'));
      const parser = new Parser(data);

      if (parser.isImei) {
        imei = parser.imei;
        logger.info('IMEI connected: ' + imei);
        socket.write(Buffer.from([0x01]));

        if (!deviceState.has(imei)) {
          deviceState.set(imei, { lastIgnition: null, points: [] });
          const imeiFolder = path.join(IMEI_FOLDER_BASE, imei);
          if (!fs.existsSync(imeiFolder)) {
            fs.mkdirSync(imeiFolder, { recursive: true });
            logger.info(`Folder created for IMEI at: ${imeiFolder}`);
          }
        }
        return;
      }

      const avl = parser.getAvl();
      if (!avl?.records?.length) {
        logger.warn('No AVL records found for IMEI: ' + imei);
        return;
      }

      const state = deviceState.get(imei);
      if (!state) {
        logger.warn('State not found for IMEI: ' + imei);
        return;
      }

      for (const record of avl.records) {
        const { gps, timestamp, ioElements } = record;
        if (!gps || gps.latitude === 0 || gps.longitude === 0) continue;

        // Validation simple vitesse raisonnable (ex: max 200 km/h)
        if (gps.speed && (gps.speed < 0 || gps.speed > 200)) {
          logger.warn(`Vitesse aberrante ignorée: ${gps.speed} km/h IMEI ${imei}`);
          continue;
        }

        const io = {
          ignition: ioElements.find(io => io.label === 'Ignition')?.value || 0,
          mouvement: ioElements.find(io => io.label === 'Movement')?.value || 0,
          gnss_statut: ioElements.find(io => io.label === 'GNSS Status')?.value || 1,
        };

        const timestampIso = toMysqlDatetime(new Date(timestamp).toISOString());

        const values = [
          gps.latitude.toString(),
          gps.longitude.toString(),
          gps.speed || 0,
          gps.altitude.toString(),
          timestampIso,
          gps.angle.toString(),
          gps.satellites.toString(),
          io.mouvement,
          io.gnss_statut,
          imei,
          io.ignition
        ];

        // Début du trajet (ignition 0 → 1)
        if (state.lastIgnition === 0 && io.ignition === 1) {
          state.points = [];
          logger.info(`Nouveau trajet démarré pour IMEI ${imei}`);
        }

        if (io.ignition === 1) {
          // Collecte en mémoire et insertion en base
          state.points.push({
            geometry: { type: "Point", coordinates: [gps.longitude, gps.latitude] },
            properties: {
              timestamp: timestampIso,
              speed: gps.speed,
              altitude: gps.altitude,
              angle: gps.angle,
              satellites: gps.satellites,
            }
          });

          await insertTrackingData(values);
        }

        // Fin du trajet (ignition 1 → 0)
        if (state.lastIgnition === 1 && io.ignition === 0) {
          logger.info(`Fin du trajet pour IMEI ${imei}, génération fichier GeoJSON`);

          const startTimeForFile = state.points[0]?.properties.timestamp.replace(/[:.]/g, '-');
          if (state.points.length > 0) {
            await writeGeojsonFile(imei, `trip_${startTimeForFile}`, state.points);
          } else {
            logger.warn(`Pas de points GPS collectés pour IMEI ${imei}, pas de fichier généré.`);
          }

          // Suppression des données dans tracking_data
          try {
            await db.execute('DELETE FROM tracking_data WHERE device_uid = ?', [imei]);
            logger.info(`Données supprimées en base pour IMEI ${imei}`);
          } catch (err) {
            logger.error('Erreur suppression données en base: ' + err.message);
          }

          state.points = [];
        }

        state.lastIgnition = io.ignition;
      }
    } catch (err) {
      logger.error(`Erreur traitement données pour IMEI ${imei}: ${err.message}`);
    }
  });
});

tcpServer.listen(TCP_PORT, () => {
  logger.info(`TCP Server listening on port ${TCP_PORT}`);
});
