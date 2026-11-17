const crypto = require('node:crypto');
const { SignJWT, jwtVerify, createRemoteJWKSet, importJWK } = require('jose');

const ASSERTION_TYP = 'platform-link+jwt';
const DEFAULT_TTL = 5 * 60;

/**
 * 主平台签发「平台身份断言」：远程 redeem / activate 用登记 origin 的 JWKS 验签，不信任请求体自报 origin。
 */
const createPlatformAssertionSigner = ({ getPrivateJwk, issuer, clockTolerance = 5 }) => {
  if (typeof getPrivateJwk !== 'function') {
    throw new Error('fastify-oidc: createPlatformAssertionSigner 需要 getPrivateJwk');
  }
  if (!issuer) {
    throw new Error('fastify-oidc: createPlatformAssertionSigner 需要 issuer');
  }

  const sign = async ({ audience, ttl = DEFAULT_TTL, extra = {} } = {}) => {
    if (!audience) {
      throw new Error('fastify-oidc: platform assertion 需要 audience（远程 baseUrl）');
    }
    const jwk = await getPrivateJwk();
    if (!jwk) {
      throw new Error('fastify-oidc: IdP 私钥尚未就绪，无法签发平台断言');
    }
    const key = await importJWK(jwk, jwk.alg || 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT(Object.assign({}, extra))
      .setProtectedHeader({ alg: jwk.alg || 'RS256', typ: ASSERTION_TYP, kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + ttl)
      .setJti(crypto.randomUUID())
      .sign(key);
  };

  return { sign, typ: ASSERTION_TYP };
};

/**
 * 远程侧验签：用登记时的 jwksUri 验签；jtiStore 可选防重放（async has/add）。
 */
const createPlatformAssertionVerifier = ({ clockTolerance = 5, jtiStore = null } = {}) => {
  const jwksCache = new Map();

  const getJWKS = jwksUri => {
    let set = jwksCache.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri));
      jwksCache.set(jwksUri, set);
    }
    return set;
  };

  const verify = async (token, { issuer, audience, jwksUri } = {}) => {
    if (!token || !issuer || !audience || !jwksUri) {
      throw new Error('fastify-oidc: verifyPlatformAssertion 需要 token、issuer、audience、jwksUri');
    }
    const { payload, protectedHeader } = await jwtVerify(token, getJWKS(jwksUri), {
      issuer,
      audience,
      clockTolerance,
      typ: ASSERTION_TYP
    });
    if (!payload.jti) {
      throw new Error('fastify-oidc: platform assertion 缺少 jti');
    }
    if (jtiStore) {
      if (await jtiStore.has(payload.jti)) {
        throw new Error('fastify-oidc: platform assertion jti 已使用');
      }
      const ttlMs = Math.max(1000, ((payload.exp || 0) - Math.floor(Date.now() / 1000) + clockTolerance) * 1000);
      await jtiStore.add(payload.jti, ttlMs);
    }
    return { payload, protectedHeader };
  };

  return { verify, typ: ASSERTION_TYP };
};

/** 内存 jti 防重放（单进程）；生产可换 Redis */
const createMemoryJtiStore = () => {
  const map = new Map();
  const has = async jti => {
    const exp = map.get(jti);
    if (!exp) {
      return false;
    }
    if (exp <= Date.now()) {
      map.delete(jti);
      return false;
    }
    return true;
  };
  const add = async (jti, ttlMs) => {
    map.set(jti, Date.now() + ttlMs);
  };
  return { has, add };
};

module.exports = {
  ASSERTION_TYP,
  DEFAULT_TTL,
  createPlatformAssertionSigner,
  createPlatformAssertionVerifier,
  createMemoryJtiStore
};
