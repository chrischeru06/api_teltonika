/** Writen by Cerubala Christian Wann'y
 * email: wanny@mediabox.bi
 * tel: +25762442698
 * This code is an API that helps to take data from Teltonika devices and insert the data into a MySQL server
 */

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

const server = net.createServer((c) => {
  console.log("Client connected");

  let ignitionState = null; // Variable to track ignition state

  c.on('end', () => {
    console.log("Client disconnected");
  });

  c.on('data', async (data) => {
    const parser = new Parser(data);
    
    if (parser.isImei) {
      const imei = parser.imei;
      console.log("IMEI:", imei);
      c.write(Buffer.alloc(1, 1)); // Send ACK for IMEI
    } else {
      const avl = parser.getAvl();
      const donneGps = avl.records;

      if (donneGps.length > 0) {
        const detail = donneGps[0].gps;
        const ioElements = donneGps[0].ioElements;
        const currentIgnition = ioElements[0].value; // Assuming ignition is the first value of ioElements

        // Handle ignition transitions
        if (ignitionState === null || currentIgnition !== ignitionState) {
          if (ignitionState === 1 && currentIgnition === 0) {
            // Record data when ignition goes from ON to OFF
            await saveData(imei, donneGps[0], currentIgnition);
            console.log("Data recorded with ignition = 0.");
          }

          ignitionState = currentIgnition; // Update ignition state

          if (ignitionState === 1) {
            console.log("Ignition is ON, will continue to record data.");
          }
        }

        // Save data only if ignition is ON
        if (ignitionState === 1 && detail.latitude !== 0 && detail.longitude !== 0) {
          await saveData(imei, donneGps[0], currentIgnition);
          console.log("Data recorded with ignition = 1.");
