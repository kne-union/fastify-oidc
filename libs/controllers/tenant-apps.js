const fp = require('fastify-plugin');

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
      schema: { tags: ['OIDC 应用中心'], summary: '当前租户已开通的子应用' }
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
