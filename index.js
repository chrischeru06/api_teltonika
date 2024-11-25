/** Writen by Cerubala Christian Wann'y
 * email: wanny@mediabox.bi
 * tel: +25762442698
 * This code is an API that helps to take data from Teltonika devices and insert the data into a MySQL server
 */

const net = require('net');
const Parser = require('teltonika-parser-ex');
const binutils = require('binutils64');
const mysql = require('mysql');
const util = require('util');

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

  let ignitionState = null; // Track ignition state
  let speed = 0; // Track speed
  let currentCodeCourse = null; // Track current course code
  let intervalId = null; // Interval for periodic data recording

  c.on('end', () => {
    console.log("Client disconnected");
    clearInterval(intervalId); // Clear the interval on client disconnect
  });

  c.on('data', async (data) => {
    const parser = new Parser(data);

    if (parser.isImei) {
      const imei = parser.imei;
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
    } else {
      await handleAVLData(parser, c, ignitionState, speed, currentCodeCourse);
    }
  });
});

server.listen(2354, '141.94.194.193', () => {
  console.log("Server started on port 2354");
});

async function handleAVLData(parser, client, ignitionState, speed, currentCodeCourse) {
  const avl = parser.getAvl();
  const donneGps = avl.records;

  if (donneGps.length > 0) {
    const detail = donneGps[0].gps;
    const ioElements = donneGps[0].ioElements;
    const currentIgnition = ioElements[0].value; // Assumed ignition is first
    speed = detail.speed || 0; // Update speed

    // Update ignition state and handle data recording
    if (ignitionState !== currentIgnition) {
      ignitionState = currentIgnition;
      currentCodeCourse = await handleIgnitionChange(imei, donneGps[0], ignitionState, currentCodeCourse);
    }

    // Record data if ignition is ON
    if (ignitionState === 1) {
      // If speed is 0, record once and wait for speed to exceed 0
      if (speed > 0) {
        // If speed is greater than 0, continue recording every 5 seconds
        if (!intervalId) {
          console.log("Speed is > 0. Starting periodic recording every 5 seconds.");
          intervalId = setInterval(async () => {
            await saveData(imei, donneGps[0], currentCodeCourse);
            console.log("Periodic data recorded with ignition = 1.");
          }, 5000);
        }
      } else {
        // If speed is 0, record once
        await saveData(imei, donneGps[0], currentCodeCourse);
        console.log("Data recorded with ignition = 1 and speed = 0. Waiting for speed > 0.");
      }
    } else if (ignitionState === 0) {
      // If ignition is OFF, clear the interval and record once
      await saveData(imei, donneGps[0], currentCodeCourse);
      console.log("Data recorded with ignition = 0.");
      clearInterval(intervalId); // Stop periodic recording
      intervalId = null; // Reset intervalId
    }
  }

  const writer = new binutils.BinaryWriter();
  writer.WriteInt32(avl.number_of_data);
  client.write(writer.ByteBuffer); // Send ACK for AVL DATA
  client.write(Buffer.from('000000000000000F0C010500000007676574696E666F0100004312', 'hex'));
}

async function handleIgnitionChange(imei, gpsData, ignitionState, currentCodeCourse) {
  if (ignitionState === 0) {
    await saveData(imei, gpsData, currentCodeCourse);
    console.log("Data recorded with ignition = 0.");
  } else if (ignitionState === 1) {
    console.log("Ignition is ON, will continue to record data.");
    currentCodeCourse = await generateUniqueCodeForDevice(imei);
  }
  return currentCodeCourse;
}

function generateUniqueCode() {
  const timestamp = new Date().getTime().toString(16);
  const randomNum = Math.floor(Math.random() * 1000);
  return timestamp + randomNum;
}

async function generateUniqueCodeForDevice(deviceUid) {
  const lastData = await query('SELECT * FROM tracking_data WHERE device_uid = ? ORDER BY date DESC LIMIT 1', [deviceUid]);
  return lastData.length && lastData[0].ignition !== ioElements[0].value 
    ? generateUniqueCode() 
    : lastData.length ? lastData[0].CODE_COURSE : generateUniqueCode();
}

async function saveData(imei, gpsData, codeCourse) {
  const detail = gpsData.gps;
  const ioElements = gpsData.ioElements;

  const detailsData = [
    detail.latitude,
    detail.longitude,
    detail.altitude,
    detail.angle,
    detail.satellites,
    detail.speed,
    ioElements[0].value,
    ioElements[1]?.value || null,
    ioElements[2]?.value || null,
    ioElements[5]?.value || null,
    imei,
    JSON.stringify(gpsData.records),
    codeCourse
  ];

  try {
    await query('INSERT INTO tracking_data(latitude, longitude, altitude, angle, satellites, vitesse, ignition, mouvement, gnss_statut, CEINTURE, device_uid, json, CODE_COURSE) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', detailsData);
  } catch (error) {
    console.error("Error inserting data:", error);
  }
}
