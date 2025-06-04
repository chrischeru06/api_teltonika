const mysql = require('mysql2/promise');
const { dbConfig } = require('../config');
const logger = require('../logger/logger');

let pool;

async function initDbPool() {
  try {
    pool = await mysql.createPool(dbConfig);
    logger.info('MySQL pool created');
  } catch (err) {
    logger.error('MySQL pool creation failed:', err.message);
    setTimeout(initDbPool, 5000);
  }
}

initDbPool();

module.exports = {
  getPool: () => pool,
};
