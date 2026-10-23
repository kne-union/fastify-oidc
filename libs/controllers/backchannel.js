const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { createError } = require('../utils/intl');
const { empty } = require('../schema/response');

const { BadRequest } = httpErrors;

/**
 * central 子项目接收主项目的 back-channel logout 通知，把 sid / sub 加入本地撤销列表。
 * client 的 backchannel_logout_uri 配置为 `${ORIGIN}${prefix}/backchannel-logout`
 */
module.exports = fp(async (fastify, options) => {
  if (options.runtime.idpEnabled) {
    return;
  }
  const { verifier, revocation, translator } = fastify[options.name];

  fastify.register(async child => {
    child.removeAllContentTypeParsers();
    child.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body)));
    });

    child.post(
      `${options.prefix}/backchannel-logout`,
      {
        schema: {
          tags: ['OIDC-服务接口'],
          summary: '接收 back-channel logout 通知',
          description: 'central 子项目接收主项目的登出通知（application/x-www-form-urlencoded），验签后把 sid（或 sub）加入本地撤销列表；logout_token 无效返回 400',
          body: { type: 'object', required: ['logout_token'], properties: { logout_token: { type: 'string', description: '主项目签发的 logout token（JWT）' } } },
          response: empty('已处理')
        }
      },
      translator.wrap(async (request, reply) => {
        let payload;
        try {
          payload = await verifier.verifyLogoutToken(request.body.logout_token, { audience: options.runtime.clientId });
        } catch (e) {
          throw createError(BadRequest, e.messageId || 'logoutTokenInvalid');
        }
        if (payload.sid) {
          await revocation.revokeSession(payload.sid);
        } else {
          await revocation.revokeSubject(String(payload.sub));
        }
        reply.header('cache-control', 'no-store');
        return {};
      })
    );
  });
});
