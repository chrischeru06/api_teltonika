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

const server = net.createServer((c) => {
  console.log("Client connected");

  let imei; // Déclare imei ici pour qu'il soit accessible dans tout le serveur
  let ignitionState = null; 
  let lastIgnitionChangeTime = null; 
  let speedZeroCount = 0; 
  let speedWasZero = false; 
  let zeroValues = []; 

  c.on('end', () => {
    console.log("Client disconnected");
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

        if (detail.latitude !== 0 && detail.longitude !== 0) {
          const currentIgnition = ioElements[0].value;
          const currentSpeed = ioElements[5].value; 

          // Vérifier les changements d'état de l'ignition
          if (ignitionState !== currentIgnition) {
            const currentTime = Date.now();
            if (ignitionState === 0 && currentIgnition === 1) {
              if (lastIgnitionChangeTime && (currentTime - lastIgnitionChangeTime < 60000)) {
                console.log("Data ignored: Ignition changed from 0 to 1 within a minute.");
                return; 
              }
            }
            lastIgnitionChangeTime = currentTime; 
            ignitionState = currentIgnition; 
          }

          // Enregistrement des données si l'ignition est à 0
          if (ignitionState === 0) {
            zeroValues.push(donneGps[0]);
            if (zeroValues.length > 3) {
              zeroValues.shift(); 
            }
            queueData(imei, donneGps[0], ignitionState);
          }

          // Gestion de la vitesse
          if (currentSpeed === 0) {
            if (!speedWasZero) {
              speedZeroCount = 0; 
            }

            if (speedZeroCount < 2) {
              queueData(imei, donneGps[0], ignitionState);
              speedZeroCount++;
            }

            speedWasZero = true;
          } else {
            speedWasZero = false;
          }

          // Enregistrer les données si l'ignition est à 1
          if (ignitionState === 1) {
            queueData(imei, donneGps[0], ignitionState);
          }
        } else {
          console.log("Latitude or Longitude is zero, no insertion.");
        }
      }

      const writer = new binutils.BinaryWriter();
      writer.WriteInt32(avl.number_of_data);
      c.write(writer.ByteBuffer); 
      c.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
    }
  });
});

// Process the data queue at regular intervals
setInterval(async () => {
  if (dataQueue.length > 0) {
    const dataToInsert = dataQueue.splice(0, dataQueue.length); // Take all data to insert
    await saveBatchData(dataToInsert);
  }
}, 5000); // Adjust the interval as needed

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});

function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

function queueData(imei, gpsData, ignition) {
  const detail = gpsData.gps;
  const ioElements = gpsData.ioElements;

  query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [imei])
    .then(lastData => {
      const codeunique = lastData.length && lastData[0].ignition !== ignition 
        ? generateUniqueCode() 
        : lastData.length ? lastData[0].CODE_COURSE : generateUniqueCode();

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
        codeunique
      ];

      dataQueue.push(record);
    })
    .catch(error => {
      console.error("Error fetching last data:", error);
    });
}

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
