const crypto = require('node:crypto');

const deriveKey = (secret, purpose = 'encryption') => crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();

const encrypt = (secret, plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), data.toString('base64url')].join('.');
};

const decrypt = (secret, text) => {
  const [version, iv, tag, data] = String(text).split('.');
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('无法识别的加密数据格式');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
};

const randomSecret = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

module.exports = { deriveKey, encrypt, decrypt, randomSecret };
