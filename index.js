const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require("mysql");
const util = require("util");

// Create a connection to the database
let server = net.createServer((c) => {
  console.log("client connected");
  const connection = mysql.createConnection({
    host: "localhost",
    port: "3306",
    user: "cartrackingdvs",
    password: "63p85x:RsU+A/Dd(e7",
    database: "car_trucking",
  });

  // Open the MySQL connection
  connection.connect((error) => {
    if (error) throw error;
    console.log("Successfully connected to the database.");
  });

  const query = util.promisify(connection.query).bind(connection);
  
  c.on('end', () => {
    console.log("client disconnected");
  });

  function generateUniqueCode() {
    const timestamp = new Date().getTime().toString(16);
    const randomNum = Math.floor(Math.random() * 1000);
    const uniqueCode = timestamp + randomNum;
    return uniqueCode;
  }

  let imei;
  let lastCodeCourse; // Stocke le dernier CODE_COURSE pour gestion de l'ignition

  c.on('data', async (data) => {
    let buffer = data;
    let parser = new Parser(buffer);

    if (parser.isImei) {
      imei = parser.imei;
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); // send ACK for IMEI
    } else {
      let avl = parser.getAvl();
      let donneGps = avl?.records?.map(({ gps, timestamp, ioElements }) => {
        return { gps, timestamp, ioElements };
      });

      if (donneGps) {
        let detail = donneGps[0].gps;
        let detail2 = donneGps[0].ioElements[0]; // Ignition
        let detail3 = donneGps[0].ioElements[1]; // Some other input (e.g., speed)
        let detail4 = donneGps[0].ioElements[2]; // Some other input (e.g., movement)
        let detail5 = donneGps[0].ioElements[5]; // Seatbelt status
        console.log("Details:", detail, detail2, detail3);

        if (detail.latitude !== 0 && detail.longitude !== 0) {
          const lastData = (await query('SELECT * FROM tracking_data WHERE device_uid =? ORDER BY date DESC LIMIT 1', [imei]))[0];
          let codeunique;

          if (lastData) {
            // Gestion de la transition ignition
            if (lastData.ignition !== detail2.value) {
              // Si ignition passe de 1 à 0
              if (lastData.ignition === 1 && detail2.value === 0) {
                codeunique = generateUniqueCode(); // Nouveau CODE_COURSE pour ignition = 0
                await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [[[
                  detail.latitude,
                  detail.longitude,
                  detail.altitude,
                  detail.angle,
                  detail.satellites,
                  0, // vitesse à 0
                  0, // ignition à 0
                  detail3.value, // mouvement
                  detail4.value,
                  detail5.value,
                  imei,
                  JSON.stringify(avl.records),
                  codeunique // Nouveau CODE_COURSE
                ]]]);
              }
              // Si ignition passe de 0 à 1
              if (lastData.ignition === 0 && detail2.value === 1) {
                // Insérer une entrée avec ignition à 0 avant de passer à 1
                await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [[[
                  detail.latitude,
                  detail.longitude,
                  detail.altitude,
                  detail.angle,
                  detail.satellites,
                  0, // vitesse à 0
                  0, // ignition à 0
                  detail3.value,
                  detail4.value,
                  detail5.value,
                  imei,
                  JSON.stringify(avl.records),
                  lastData.CODE_COURSE // Garder le même CODE_COURSE que pour l'ignition précédente
                ]]]);

                // Insérer une entrée avec ignition à 1 et nouveau CODE_COURSE
                codeunique = generateUniqueCode(); // Nouveau CODE_COURSE pour ignition = 1
                await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [[[
                  detail.latitude,
                  detail.longitude,
                  detail.altitude,
                  detail.angle,
                  detail.satellites,
                  detail3.value, // vitesse actuelle
                  detail2.value, // ignition à 1
                  detail4.value, // mouvement
                  detail5.value, // ceinture
                  imei,
                  JSON.stringify(avl.records),
                  codeunique // Nouveau CODE_COURSE
                ]]]);
              }
            }
          } else {
            // Premier enregistrement
            codeunique = generateUniqueCode();
            await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES ?', [[[
              detail.latitude,
              detail.longitude,
              detail.altitude,
              detail.angle,
              detail.satellites,
              detail3.value, // vitesse actuelle
              detail2.value, // ignition
              detail4.value, // mouvement
              detail5.value, // ceinture
              imei,
              JSON.stringify(avl.records),
              codeunique // Nouveau CODE_COURSE
            ]]]);
          }
        } else {
          console.log("Latitude ou longitude non valides, pas d'insertion.");
        }
      }

      let writer = new binutils.BinaryWriter();
      writer.WriteInt32(avl.number_of_data);
      let response = writer.ByteBuffer;
      c.write(response); // Send ACK for AVL DATA
    }
  });
});

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});
