const crypto = require('node:crypto');
const { jwtVerify, EmbeddedJWK, calculateJwkThumbprint } = require('jose');
const { createMemoryStore } = require('./revocation');
const { createError } = require('../utils/intl');

const ALGORITHMS = ['ES256', 'ES384', 'ES512', 'EdDSA', 'Ed25519', 'PS256', 'RS256'];

const normalizeHtu = value => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
};

/**
 * 资源侧校验 DPoP proof（RFC 9449 第 7 节）
 */
module.exports = ({ maxAge = 300, clockTolerance = 5, replayStore } = {}) => {
  replayStore = replayStore || createMemoryStore();

  const verify = async ({ proof, method, url, accessToken, jkt }) => {
    if (!proof) {
      throw createError(null, 'dpopProofMissing');
    }
    const { payload, protectedHeader } = await jwtVerify(proof, EmbeddedJWK, {
      typ: 'dpop+jwt',
      algorithms: ALGORITHMS,
      maxTokenAge: maxAge,
      clockTolerance
    });
    if (payload.htm !== method) {
      throw createError(null, 'dpopHtmMismatch');
    }
    if (!payload.htu || normalizeHtu(payload.htu) !== normalizeHtu(url)) {
      throw createError(null, 'dpopHtuMismatch');
    }
    if (!payload.jti) {
      throw createError(null, 'dpopJtiMissing');
    }
    const ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
    if (payload.ath !== ath) {
      throw createError(null, 'dpopAthMismatch');
    }
    if ((await calculateJwkThumbprint(protectedHeader.jwk, 'sha256')) !== jkt) {
      throw createError(null, 'dpopKeyMismatch');
    }
    if (await replayStore.get(`dpop:${payload.jti}`)) {
      throw createError(null, 'dpopReplayed');
    }
    await replayStore.set(`dpop:${payload.jti}`, 1, maxAge + clockTolerance);
  };

  return { verify };
};
