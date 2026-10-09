const httpErrors = require('http-errors');
const { normalizeClaims, normalizeLegacy } = require('./normalize-user');
const { createError } = require('../utils/intl');

const { Unauthorized, Forbidden } = httpErrors;

const extractToken = request => {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }
  const index = header.indexOf(' ');
  const scheme = header.slice(0, index).toLowerCase();
  const token = header.slice(index + 1).trim();
  if (!['bearer', 'dpop'].includes(scheme) || !token) {
    return null;
  }
  return { scheme, token };
};

/**
 * 与 fastify.account.authenticate 同形的认证中间件：
 * 填充 request.user（统一结构）以及兼容字段 request.userInfo / request.authenticatePayload / request.tenantUserInfo
 */
module.exports = ({ fastify, options, verifier, dpop, revocation, userMirror, serviceClient, translator }) => {
  const { runtime } = options;
  const account = () => fastify[options.accountNamespace];
  const tenant = () => fastify[options.tenantNamespace];

  const tenantSource = () => {
    if (options.tenantSource) {
      return options.tenantSource;
    }
    return runtime.idpEnabled && tenant() ? 'local' : 'claims';
  };

  const getRequestUrl = request => (options.getRequestUrl ? options.getRequestUrl(request) : `${runtime.origin}${request.raw.url}`);

  const verifyRequest = async (request, { audience } = {}) => {
    const extracted = extractToken(request);
    if (!extracted) {
      return null;
    }
    let payload;
    try {
      payload = await verifier.verifyAccessToken(extracted.token, audience ? { audience } : undefined);
    } catch (e) {
      throw createError(Unauthorized, 'authenticationFailed');
    }
    if (payload.cnf?.jkt) {
      if (extracted.scheme !== 'dpop') {
        throw createError(Unauthorized, 'dpopSchemeRequired');
      }
      try {
        await dpop.verify({
          proof: request.headers.dpop,
          method: request.method,
          url: getRequestUrl(request),
          accessToken: extracted.token,
          jkt: payload.cnf.jkt
        });
      } catch (e) {
        throw createError(Unauthorized, e.messageId || 'dpopInvalid');
      }
    } else if (extracted.scheme === 'dpop') {
      throw createError(Unauthorized, 'tokenNotDPoPBound');
    } else if (options.requireDPoP) {
      throw createError(Unauthorized, 'dpopRequired');
    }
    if (await revocation.isRevoked(payload)) {
      throw createError(Unauthorized, 'tokenRevoked');
    }
    return payload;
  };

  const resolveUserInfo = async userId => {
    if (!account()) {
      return { id: userId };
    }
    if (runtime.idpEnabled) {
      return account().services.user.getUser({ id: userId });
    }
    return userMirror.ensure(userId);
  };

  const user = async request => {
    const payload = await verifyRequest(request);
    if (!payload) {
      if (options.legacyToken && account()) {
        const { tokenUser, user: accountUser } = account().authenticate;
        await (tokenUser || accountUser)(request);
        request.user = normalizeLegacy(request);
        return;
      }
      throw createError(Unauthorized, 'accessTokenMissing');
    }
    const normalized = normalizeClaims(payload, runtime.claims);
    if (normalized.isClient) {
      throw createError(Unauthorized, 'userTokenRequired');
    }
    request.user = normalized;
    request.authenticatePayload = { id: normalized.userId, tenantId: normalized.tenantId };
    request.userInfo = await resolveUserInfo(normalized.userId);
    request.appName = request.headers['x-app-name'];
  };

  const buildTenantUserFromClaims = currentUser => ({
    id: currentUser.tenantUserId,
    tenantId: currentUser.tenantId,
    userId: currentUser.userId,
    status: 'open',
    roles: currentUser.roles,
    roleDetails: currentUser.roles.map(code => ({ code })),
    permissions: currentUser.permissions || [],
    tenant: { id: currentUser.tenantId, status: 'open' }
  });

  const tenantUser = async request => {
    const contextName = options.tenantUserContextName;
    if (request[contextName]) {
      return;
    }
    if (!request.user) {
      throw createError(Unauthorized, 'userNotAuthenticated');
    }
    if (request.user.legacy && tenant()) {
      await tenant().authenticate.tenantUser(request);
      return;
    }
    if (!request.user.tenantId) {
      throw createError(Forbidden, 'tenantNotSelected');
    }
    const source = tenantSource();
    if (source === 'local') {
      request[contextName] = await tenant().services.user.getTenantUserInfo({ id: request.user.userId, tenantId: request.user.tenantId });
      return;
    }
    if (source === 'remote') {
      request[contextName] = await serviceClient.getTenantUser({ userId: request.user.userId, tenantId: request.user.tenantId });
      return;
    }
    request[contextName] = buildTenantUserFromClaims(request.user);
  };

  const admin = async request => {
    if (!account()) {
      throw createError(Forbidden, 'accountPluginMissing');
    }
    await account().authenticate.admin(request);
  };

  const scope =
    (...required) =>
    async request => {
      const granted = new Set(request.user?.scope || []);
      const missing = required.filter(item => !granted.has(item));
      if (missing.length) {
        throw createError(Forbidden, 'scopeMissing', { scopes: missing.join(' ') });
      }
    };

  const permission =
    (...codes) =>
    async request => {
      let permissions = request.user?.permissions;
      if (tenantSource() !== 'claims' || !permissions) {
        await tenantUser(request);
        const info = request[options.tenantUserContextName];
        permissions = (info && typeof info.get === 'function' ? info.get('permissions') : info?.permissions) || [];
      }
      const missing = codes.filter(code => !permissions.includes(code));
      if (missing.length) {
        throw createError(Forbidden, 'permissionMissing', { permissions: missing.join(', ') });
      }
    };

  const client =
    (...scopes) =>
    async request => {
      const payload = await verifyRequest(request, { audience: runtime.serviceAudience });
      if (!payload) {
        throw createError(Unauthorized, 'accessTokenMissing');
      }
      const normalized = normalizeClaims(payload, runtime.claims);
      if (!normalized.isClient) {
        throw createError(Unauthorized, 'clientTokenRequired');
      }
      request.user = normalized;
      await scope(...scopes)(request);
    };

  const { wrap } = translator;
  return {
    user: wrap(user),
    tenantUser: wrap(tenantUser),
    admin: wrap(admin),
    scope: (...args) => wrap(scope(...args)),
    permission: (...args) => wrap(permission(...args)),
    client: (...args) => wrap(client(...args))
  };
};

module.exports.extractToken = extractToken;
