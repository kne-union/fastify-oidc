const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { createError } = require('../utils/intl');

const { NotFound } = httpErrors;

const TOKEN_MODELS = ['AccessToken', 'AuthorizationCode', 'RefreshToken', 'DeviceCode', 'BackchannelAuthenticationRequest'];

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const getIdp = () => fastify[options.name].idp;
  const revocation = () => fastify[options.name].revocation;

  const revokeGrant = async grantId => {
    const idp = getIdp();
    for (const model of TOKEN_MODELS) {
      await idp.getAdapter(model).revokeByGrantId(grantId);
    }
    await idp.getAdapter('Grant').destroy(grantId);
  };

  const notifyBackchannel = async ({ accountId, authorizations }) => {
    const provider = getIdp().getProvider();
    for (const [clientId, { sid } = {}] of Object.entries(authorizations || {})) {
      if (sid) {
        await revocation().revokeSession(sid);
      }
      const client = provider && (await provider.Client.find(clientId));
      if (client && client.backchannelLogoutUri && sid) {
        await client.backchannelLogout(String(accountId), sid).catch(e => {
          fastify.log.warn({ err: e, clientId }, 'fastify-oidc: back-channel logout 通知失败');
        });
      }
    }
  };

  const listSessions = async ({ userId }) => {
    const adapter = getIdp().getAdapter('Session');
    if (typeof adapter.findByAccountId !== 'function') {
      throw createError(null, 'adapterSessionQueryMissing');
    }
    const sessions = await adapter.findByAccountId(String(userId));
    return sessions.map(session => ({
      uid: session.uid,
      loginAt: session.loginTs ? new Date(session.loginTs * 1000) : null,
      expiresAt: session.exp ? new Date(session.exp * 1000) : null,
      clients: Object.entries(session.authorizations || {}).map(([clientId, { sid }]) => ({ clientId, sid }))
    }));
  };

  const revokeSession = async ({ uid }) => {
    const adapter = getIdp().getAdapter('Session');
    const session = await adapter.findByUid(uid);
    if (!session) {
      throw createError(NotFound, 'sessionNotFound');
    }
    await notifyBackchannel({ accountId: session.accountId, authorizations: session.authorizations });
    let grants = 0;
    for (const { grantId } of Object.values(session.authorizations || {})) {
      if (grantId) {
        await revokeGrant(grantId);
        grants++;
      }
    }
    await adapter.destroy(session.jti);
    await services.sessionTenant.remove({ sessionUid: uid });
    return { grants };
  };

  /**
   * 撤销用户已签发的全部令牌。logout=false（权限变更）时保留 IdP 会话，前端可静默重新获取带新权限的令牌；
   * logout=true（禁用 / 强制下线）时同时结束会话并发送 back-channel logout。
   */
  const revokeByAccount = async (userId, { logout = false } = {}) => {
    const idp = getIdp();
    const grantAdapter = idp.getAdapter('Grant');
    if (typeof grantAdapter.findGrantIdsByAccountId !== 'function') {
      throw createError(null, 'adapterGrantQueryMissing');
    }
    await revocation().revokeSubject(String(userId));
    let sessions = 0;
    let grants = 0;
    if (logout) {
      const sessionAdapter = idp.getAdapter('Session');
      if (typeof sessionAdapter.findByAccountId !== 'function') {
        throw createError(null, 'adapterSessionQueryMissing');
      }
      for (const session of await sessionAdapter.findByAccountId(String(userId))) {
        grants += (await revokeSession({ uid: session.uid })).grants;
        sessions++;
      }
    }
    const grantIds = await grantAdapter.findGrantIdsByAccountId(String(userId));
    for (const grantId of grantIds) {
      await revokeGrant(grantId);
    }
    return { grants: grants + grantIds.length, sessions };
  };

  services.grant = { revokeGrant, revokeByAccount, listSessions, revokeSession };
});
