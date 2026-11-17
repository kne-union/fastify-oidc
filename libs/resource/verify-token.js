const { jwtVerify, createRemoteJWKSet, decodeJwt } = require('jose');
const { createError } = require('../utils/intl');
const { TENANT_SYNC_EVENT } = require('../utils/app-permissions');

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

/**
 * standalone：本进程 JWKS。
 * central 单平台：主项目 jwks_uri。
 * central 多平台：先读 token.iss，命中 platforms 后用对应 JWKS + audience 验签。
 */
module.exports = ({ options, getLocalJWKS, getPlatforms }) => {
  const { runtime } = options;
  const remoteByUri = new Map();

  const getRemoteJWKS = jwksUri => {
    let set = remoteByUri.get(jwksUri);
    if (!set) {
      set = createRemoteJWKSet(new URL(jwksUri));
      remoteByUri.set(jwksUri, set);
    }
    return set;
  };

  const resolveVerifyContext = (token, { audience } = {}) => {
    const local = getLocalJWKS && getLocalJWKS();
    if (local) {
      return { jwks: local, issuer: runtime.issuer, audience: audience || runtime.audience };
    }

    const platforms = typeof getPlatforms === 'function' ? getPlatforms() : [];
    if (platforms && platforms.length) {
      let iss;
      try {
        iss = decodeJwt(token).iss;
      } catch (e) {
        throw createError(null, 'authenticationFailed');
      }
      const platform = platforms.find(p => p.issuer === iss || p.issuer === String(iss || '').replace(/\/+$/, ''));
      if (!platform || platform.status !== 'paired') {
        throw createError(null, 'authenticationFailed');
      }
      return {
        jwks: getRemoteJWKS(platform.jwksUri || `${platform.issuer}/jwks`),
        issuer: platform.issuer,
        audience: audience || platform.audience || runtime.audience
      };
    }

    return {
      jwks: getRemoteJWKS(runtime.jwksUri),
      issuer: runtime.issuer,
      audience: audience || runtime.audience
    };
  };

  const verifyAccessToken = async (token, { audience } = {}) => {
    const ctx = resolveVerifyContext(token, { audience });
    const { payload } = await jwtVerify(token, ctx.jwks, {
      issuer: ctx.issuer,
      audience: ctx.audience,
      typ: 'at+jwt',
      clockTolerance: options.clockTolerance
    });
    return payload;
  };

  const verifyLogoutToken = async (token, { audience }) => {
    const ctx = resolveVerifyContext(token, { audience });
    const { payload } = await jwtVerify(token, ctx.jwks, {
      issuer: ctx.issuer,
      audience: ctx.audience || audience,
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
    const ctx = resolveVerifyContext(token, { audience });
    const { payload } = await jwtVerify(token, ctx.jwks, {
      issuer: ctx.issuer,
      audience: ctx.audience || audience,
      typ: 'tenant-sync+jwt',
      clockTolerance: options.clockTolerance,
      requiredClaims: ['jti', 'exp', 'tenant_id']
    });
    if (!payload.events || typeof payload.events[TENANT_SYNC_EVENT] !== 'object') {
      throw createError(null, 'tenantSyncTokenInvalid');
    }
    return payload;
  };

  return { verifyAccessToken, verifyLogoutToken, verifyTenantSyncToken, resolveVerifyContext };
};
