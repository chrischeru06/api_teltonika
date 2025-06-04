require('dotenv').config();

module.exports = {
  TCP_PORT: process.env.TCP_PORT || 2354,
  TCP_TIMEOUT: parseInt(process.env.TCP_TIMEOUT) || 300000,
  IMEI_FOLDER_BASE: process.env.IMEI_FOLDER_BASE || '/var/www/html/IMEI',
  MAX_GEOJSON_SIZE: 100 * 1024 * 1024, // 100MB
  dbConfig: {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'password',
    database: process.env.DB_NAME || 'car_trucking_v3',
    waitForConnections: true,
    connectionLimit: 50,
    queueLimit: 0,
  }
};
