const fp = require('fastify-plugin');
const { str, bool, success } = require('../schema/response');

/**
 * 前端登录方式发现：免登录，只返回公开信息，不能包含任何密钥。
 * 多平台 central：附带 platforms[]，前端选平台或用 ?iss= / ?platform=。
 */
module.exports = fp(async (fastify, options) => {
  const { runtime } = options;
  const oidc = () => fastify[options.name];

  fastify.get(
    `${options.prefix}/config`,
    {
      schema: {
        tags: ['OIDC-配置'],
        summary: '获取前端登录配置（免登录）',
        description: '前端据此决定登录方式（发起 OIDC 授权的 issuer、client_id、resource），只包含公开信息；多平台时含 platforms',
        response: success('前端登录配置', {
          type: 'object',
          properties: {
            mode: str('部署模式：standalone 独立部署（本项目即 IdP），central 由主项目统一登录'),
            isMain: bool('standalone 模式下是否为主项目'),
            issuer: str('默认 OIDC issuer 地址（单平台或兼容字段）'),
            clientId: str('默认前端 client_id'),
            audience: str('默认 resource（API 资源标识）'),
            platforms: {
              type: 'array',
              description: '已配对的多个主平台（公开信息）；长度>1 时登录页应选择平台'
            }
          }
        })
      }
    },
    async request => {
      const platforms = oidc().platforms ? oidc().platforms.publicList() : [];
      const hintIss = request.query?.iss;
      const hintPlatform = request.query?.platform;
      let selected = null;
      if (platforms.length) {
        if (hintIss) {
          selected = platforms.find(p => p.issuer === hintIss || p.issuer === String(hintIss).replace(/\/+$/, ''));
        } else if (hintPlatform) {
          const key = String(hintPlatform).replace(/\/+$/, '').toLowerCase();
          selected = platforms.find(p => p.platformOrigin.toLowerCase() === key || p.platformName === hintPlatform);
        } else if (options.mode === 'central' && platforms.length === 1) {
          // central 单平台：默认用该平台登录
          selected = platforms[0];
        }
        // standalone：即使 hydrate 了配对主平台（供验运维令牌），默认登录仍用本进程 IdP，
        // 否则前端会去主平台拿 token，本地 account 用户对不上 → getSuperAdminInfo 401
      }
      const issuer = selected?.issuer || runtime.issuer;
      const clientId = selected?.clientId || runtime.clientId;
      const audience = selected?.audience || runtime.audience;
      return {
        mode: options.mode,
        isMain: options.mode === 'standalone' && !!options.isMain,
        issuer,
        clientId,
        audience,
        platforms
      };
    }
  );
});
