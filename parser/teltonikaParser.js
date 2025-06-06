const Parser = require('teltonika-parser-ex');

function parseData(data) {
  const parser = new Parser(data);

  if (parser.isImei) {
    const cleanedImei = String(parser.imei).replace(/[^\d]/g, '');
    return cleanedImei.length === 15 ? { imei: cleanedImei } : null;
  }

  const avl = parser.getAvl();
  return avl || null;
}

module.exports = {
  parseData,
};
