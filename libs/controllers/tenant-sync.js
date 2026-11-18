const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { decodeJwt } = require('jose');
const { createError } = require('../utils/intl');
const { empty } = require('../schema/response');

const { BadRequest } = httpErrors;

/**
 * independent 子应用接收宿主的租户变更通知：验签 + jti 防重放后后台回拉快照，立即返回。
 * standalone 应用接收已配对平台的通知：按令牌 iss 找到平台，以该平台的服务 client 为 audience 验签
 */
module.exports = fp(async (fastify, options) => {
  const independent = options.runtime.tenantRole === 'independent';
  if (!independent && !options.runtime.idpEnabled) {
    return;
  }
  const { verifier, tenantSync, platformContexts, translator } = fastify[options.name];

  const resolveTarget = token => {
    if (independent) {
      return { audience: options.serviceClient.clientId, tenantSync };
    }
    let iss;
    try {
      iss = decodeJwt(token).iss;
    } catch (e) {
      return null;
    }
    const context = platformContexts?.forIssuer(iss);
    return context?.tenantSync ? { audience: context.platform.serviceClientId, tenantSync: context.tenantSync } : null;
  };
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
          tags: ['OIDC-服务接口'],
          summary: '接收宿主租户变更通知（independent 子应用 / 已配对平台的 standalone 应用）',
          description: '验签并校验 jti 防重放后立即返回，后台回拉该租户快照；令牌无效或重放返回 400',
          body: { type: 'object', required: ['tenant_sync_token'], properties: { tenant_sync_token: { type: 'string', description: '宿主签发的租户同步令牌（JWT），含 tenant_id' } } },
          response: empty('已接收，后台同步')
        }
      },
      translator.wrap(async (request, reply) => {
        const token = request.body.tenant_sync_token;
        const target = resolveTarget(token);
        let payload;
        try {
          if (!target?.audience) {
            throw new Error('tenant sync target not found');
          }
          payload = await verifier.verifyTenantSyncToken(token, { audience: target.audience });
        } catch (e) {
          throw createError(BadRequest, 'tenantSyncTokenInvalid');
        }
        if (!consumeJti(payload.jti, payload.exp)) {
          throw createError(BadRequest, 'tenantSyncTokenReplayed');
        }
        target.tenantSync.syncInBackground(payload.tenant_id);
        reply.header('cache-control', 'no-store');
        return {};
      })
    );
  });
});
