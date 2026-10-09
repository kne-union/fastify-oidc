const fp = require('fastify-plugin');

/**
 * 前端登录方式发现：免登录，只返回公开信息，不能包含任何密钥
 */
module.exports = fp(async (fastify, options) => {
  const { runtime } = options;

  fastify.get(
    `${options.prefix}/config`,
    {
      schema: { tags: ['OIDC 配置'], summary: '获取前端登录配置（免登录）' }
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
