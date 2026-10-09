const fp = require('fastify-plugin');

/**
 * 模拟 @kne/fastify-tenant 的 services.user.tenantList / getTenantUserInfo
 * memberships: { [userId]: [{ id, tenantId, name, roles: [code], permissions: [code] }] }
 */
module.exports = fp(async (fastify, { memberships = {} } = {}) => {
  const listOf = userId => memberships[String(userId)] || [];

  fastify.decorate('tenant', {
    memberships,
    services: {
      user: {
        tenantList: async ({ id }) => ({
          list: listOf(id).map(item => ({
            id: item.id,
            tenantId: item.tenantId,
            status: item.status || 'open',
            tenant: { name: item.name, status: 'open' }
          })),
          defaultTenantId: listOf(id)[0]?.tenantId || null
        }),
        getTenantUserInfo: async ({ id, tenantId }) => {
          const item = listOf(id).find(member => member.tenantId === String(tenantId)) || listOf(id)[0];
          if (!item) {
            throw new Error('用户不属于任何租户');
          }
          return {
            id: item.id,
            tenantId: item.tenantId,
            userId: String(id),
            roleDetails: (item.roles || []).map(code => ({ code })),
            permissions: item.permissions || []
          };
        }
      }
    }
  });
});
