const { v5: uuidv5 } = require('uuid');

const nameToUUID = (name) => {
  const namespace =  '699d9c07-b965-4399-bafd-18a3cacf073c';
  return uuidv5(name, namespace);
};

/**
 * 判断一个字符串中是否包含字母
 * @param {String} str
 */
const hasLetter = (str) => {
  for (let i in str) {
    let asc = str.charCodeAt(i);
    if ((asc >= 65 && asc <= 90 || asc >= 97 && asc <= 122)) {
      return true;
    }
  }
  return false;
};

/**
 * DLsite uses eight-digit RJ codes for works at or above one million, while
 * the local database stores those same codes as numbers without the leading 0.
 */
const toDlsiteWorkCode = id => {
  const numericId = Number(id);
  return numericId >= 1000000 ? String(numericId).padStart(8, '0') : String(numericId);
};

module.exports = {
  nameToUUID, hasLetter, toDlsiteWorkCode
};
