const Parser = require('teltonika-parser-ex');

function parseData(data) {
  const parser = new Parser(data);

  if (parser.isImei) {
    return { imei: parser.imei };
  }

  const avl = parser.getAvl();
  return avl || null;
}

module.exports = {
  parseData,
};
