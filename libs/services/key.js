const fp = require('fastify-plugin');
const crypto = require('node:crypto');
const { encrypt, decrypt } = require('../utils/crypto');

const STATUS_ORDER = { active: 0, next: 1, retired: 2 };

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { Op } = fastify.sequelize.Sequelize;
  const secret = options.keyEncryptionSecret;

  const generate = async ({ status, transaction }) => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const kid = crypto.randomUUID();
    const alg = 'RS256';
    const privateJwk = Object.assign(privateKey.export({ format: 'jwk' }), { kid, alg, use: 'sig' });
    const publicJwk = Object.assign(publicKey.export({ format: 'jwk' }), { kid, alg, use: 'sig' });
    return models.key.create(
      {
        kid,
        alg,
        status,
        privateJwk: encrypt(secret, JSON.stringify(privateJwk)),
        publicJwk,
        activatedAt: status === 'active' ? new Date() : null
      },
      { transaction }
    );
  };

  const pruneRetired = async ({ transaction } = {}) => {
    await models.key.destroy({
      where: {
        status: 'retired',
        retiredAt: { [Op.lt]: new Date(Date.now() - options.retiredKeyTTL * 1000) }
      },
      transaction
    });
  };

  const ensureKeys = async () => {
    await fastify.sequelize.instance.transaction(async transaction => {
      if (!(await models.key.count({ where: { status: 'active' }, transaction }))) {
        await generate({ status: 'active', transaction });
      }
      if (!(await models.key.count({ where: { status: 'next' }, transaction }))) {
        await generate({ status: 'next', transaction });
      }
    });
  };

  const sortedKeys = async () => {
    const list = await models.key.findAll();
    return list.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt);
  };

  // active 必须排在第一位：oidc-provider 签名时选用第一把匹配算法的密钥
  const getPrivateJwks = async () => {
    return { keys: (await sortedKeys()).map(item => JSON.parse(decrypt(secret, item.privateJwk))) };
  };

  const getPublicJwks = async () => {
    return { keys: (await sortedKeys()).map(item => item.publicJwk) };
  };

  const fingerprint = async () => {
    return (await sortedKeys()).map(item => `${item.kid}:${item.status}`).join(',');
  };

  const list = async () => {
    return (await sortedKeys()).map(item => ({
      id: item.id,
      kid: item.kid,
      alg: item.alg,
      status: item.status,
      activatedAt: item.activatedAt,
      retiredAt: item.retiredAt,
      createdAt: item.createdAt
    }));
  };

  const rotate = async () => {
    await fastify.sequelize.instance.transaction(async transaction => {
      const now = new Date();
      await models.key.update({ status: 'retired', retiredAt: now }, { where: { status: 'active' }, transaction });
      const next = await models.key.findOne({ where: { status: 'next' }, order: [['createdAt', 'ASC']], transaction });
      if (next) {
        await next.update({ status: 'active', activatedAt: now }, { transaction });
      } else {
        await generate({ status: 'active', transaction });
      }
      await generate({ status: 'next', transaction });
      await pruneRetired({ transaction });
    });
    await fastify[options.name].idp.reload();
    return list();
  };

  services.key = { ensureKeys, getPrivateJwks, getPublicJwks, fingerprint, list, rotate, pruneRetired };
});
