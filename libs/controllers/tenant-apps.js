const fp = require('fastify-plugin');
const { str, obj, success } = require('../schema/response');

/**
 * 宿主租户端：当前租户已开通且启用的子应用。当前租户与 fastify-tenant 的 tenantUser 一致（token 中的租户，否则默认租户）
 */
module.exports = fp(async (fastify, options) => {
  if (options.runtime.tenantRole !== 'host') {
    return;
  }
  const { authenticate, translator, services } = fastify[options.name];
  const { wrap } = translator;
  const resolveTenantUser = request => options.getTenant().authenticate.tenantUser(request);

  fastify.get(
    `${options.prefix}/tenant/apps`,
    {
      onRequest: [authenticate.user, resolveTenantUser],
      schema: {
        tags: ['OIDC-应用中心'],
        summary: '当前租户已开通的子应用',
        description: '宿主租户端使用：返回已启用且当前租户已开通权限的子应用；没有当前租户时返回空数组',
        response: success('子应用列表', {
          type: 'array',
          items: obj('子应用', {
            code: str('应用编码'),
            name: str('应用名称'),
            description: str('描述'),
            tenantMode: str('租户模式：client / independent')
          })
        })
      }
    },
    wrap(async request => {
      const tenantId = request[options.tenantUserContextName]?.tenantId;
      if (!tenantId) {
        return [];
      }
      const { identity } = fastify[options.name].idp;
      const apps = services.app.listOpen();
      const enabled = await Promise.all(apps.map(app => identity.isAppEnabled(String(tenantId), app.code)));
      return apps.filter((app, index) => enabled[index]).map(({ code, name, description, tenantMode }) => ({ code, name, description, tenantMode }));
    })
  );
});
