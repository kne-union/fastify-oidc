const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { createError } = require('../utils/intl');

const { BadRequest } = httpErrors;

/**
 * independent 子应用接收宿主的租户变更通知：验签 + jti 防重放后后台回拉快照，立即返回
 */
module.exports = fp(async (fastify, options) => {
  if (options.runtime.tenantRole !== 'independent') {
    return;
  }
  const { verifier, tenantSync, translator } = fastify[options.name];
  const usedJti = new Map();

  const consumeJti = (jti, exp) => {
    const now = Date.now();
    usedJti.forEach((expiresAt, key) => expiresAt < now && usedJti.delete(key));
    if (usedJti.has(jti)) {
      return false;
    }
    usedJti.set(jti, exp * 1000 + options.clockTolerance * 1000);
    return true;
  };

  fastify.register(async child => {
    if (!child.hasContentTypeParser('application/x-www-form-urlencoded')) {
      child.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body)));
      });
    }

    child.post(
      `${options.prefix}/tenant-sync`,
      {
        schema: {
          tags: ['OIDC 服务接口'],
          summary: '接收宿主租户变更通知（independent 子应用）',
          body: { type: 'object', required: ['tenant_sync_token'], properties: { tenant_sync_token: { type: 'string' } } }
        }
      },
      translator.wrap(async (request, reply) => {
        let payload;
        try {
          payload = await verifier.verifyTenantSyncToken(request.body.tenant_sync_token, { audience: options.serviceClient.clientId });
        } catch (e) {
          throw createError(BadRequest, 'tenantSyncTokenInvalid');
        }
        if (!consumeJti(payload.jti, payload.exp)) {
          throw createError(BadRequest, 'tenantSyncTokenReplayed');
        }
        tenantSync.syncInBackground(payload.tenant_id);
        reply.header('cache-control', 'no-store');
        return {};
      })
    );
  });
});
