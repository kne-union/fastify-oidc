const { jwtVerify, createRemoteJWKSet } = require('jose');
const { createError } = require('../utils/intl');
const { TENANT_SYNC_EVENT } = require('../utils/app-permissions');

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * standalone 模式直接用本进程的公钥集验签；central 模式从主项目的 jwks_uri 拉取（jose 内置缓存与按 kid 刷新）
 */
module.exports = ({ options, getLocalJWKS }) => {
  const { runtime } = options;
  let remote;

  const getJWKS = () => {
    const local = getLocalJWKS && getLocalJWKS();
    if (local) {
      return local;
    }
    remote = remote || createRemoteJWKSet(new URL(runtime.jwksUri));
    return remote;
  };

  const verifyAccessToken = async (token, { audience = runtime.audience } = {}) => {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: runtime.issuer,
      audience,
      typ: 'at+jwt',
      clockTolerance: options.clockTolerance
    });
    return payload;
  };

  const verifyLogoutToken = async (token, { audience }) => {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: runtime.issuer,
      audience,
      clockTolerance: options.clockTolerance
    });
    if (!payload.events || typeof payload.events[LOGOUT_EVENT] !== 'object') {
      throw createError(null, 'logoutTokenEventMissing');
    }
    if (payload.nonce !== undefined) {
      throw createError(null, 'logoutTokenNonceNotAllowed');
    }
    if (!payload.sid && !payload.sub) {
      throw createError(null, 'logoutTokenSubjectMissing');
    }
    return payload;
  };

  const verifyTenantSyncToken = async (token, { audience }) => {
    const { payload } = await jwtVerify(token, getJWKS(), {
      issuer: runtime.issuer,
      audience,
      typ: 'tenant-sync+jwt',
      clockTolerance: options.clockTolerance,
      requiredClaims: ['jti', 'exp', 'tenant_id']
    });
    if (!payload.events || typeof payload.events[TENANT_SYNC_EVENT] !== 'object') {
      throw createError(null, 'tenantSyncTokenInvalid');
    }
    return payload;
  };

  return { verifyAccessToken, verifyLogoutToken, verifyTenantSyncToken };
};
