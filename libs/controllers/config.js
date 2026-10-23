const fp = require('fastify-plugin');
const { str, bool, success } = require('../schema/response');

/**
 * 前端登录方式发现：免登录，只返回公开信息，不能包含任何密钥
 */
module.exports = fp(async (fastify, options) => {
  const { runtime } = options;

  fastify.get(
    `${options.prefix}/config`,
    {
      schema: {
        tags: ['OIDC-配置'],
        summary: '获取前端登录配置（免登录）',
        description: '前端据此决定登录方式（发起 OIDC 授权的 issuer、client_id、resource），只包含公开信息',
        response: success('前端登录配置', {
          type: 'object',
          properties: {
            mode: str('部署模式：standalone 独立部署（本项目即 IdP），central 由主项目统一登录'),
            isMain: bool('standalone 模式下是否为主项目'),
            issuer: str('OIDC issuer 地址'),
            clientId: str('前端使用的 client_id'),
            audience: str('申请 access_token 时的 resource（API 资源标识）')
          }
        })
      }
    },
    async () => ({
      mode: options.mode,
      isMain: options.mode === 'standalone' && !!options.isMain,
      issuer: runtime.issuer,
      clientId: runtime.clientId,
      audience: runtime.audience
    })
  );
});
