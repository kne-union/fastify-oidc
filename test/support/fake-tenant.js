const fp = require('fastify-plugin');

const mergeModules = (target, modules = []) => {
  modules.forEach(module => {
    const existing = target.find(item => item.code === module.code);
    if (!existing) {
      target.push(JSON.parse(JSON.stringify(module)));
      return;
    }
    existing.permissions = [...(existing.permissions || []), ...(module.permissions || [])];
    existing.modules = existing.modules || [];
    mergeModules(existing.modules, module.modules);
  });
  return target;
};

/**
 * 模拟 @kne/fastify-tenant 的 services.user.tenantList / getTenantUserInfo、authenticate.tenantUser，以及应用中心需要的
 * setPermissionSource / onChange / permission.list / tenant.detail 和 role / org / user 模型的只读查询
 * memberships: { [userId]: [{ id, tenantId, name, roles: [code], permissions: [code], orgIds: [orgId] }] }
 * tenantPermissions: { [tenantId]: [code] }，roles: { [tenantId]: [{ id, code, name, permissions }] }，orgs: { [tenantId]: [{ id, parentId, name, leaderUserId }] }
 * profiles: { [tenantId]: { logo, company } } 覆盖 tenant.detail 的返回
 */
module.exports = fp(async (fastify, { memberships = {}, tenantPermissions = {}, roles = {}, orgs = {}, profiles = {}, permissions = { modules: [] } } = {}) => {
  const listOf = userId => memberships[String(userId)] || [];
  const sources = new Map();
  const listeners = new Set();

  const membersOf = tenantId => Object.entries(memberships).flatMap(([userId, items]) => items.filter(item => item.tenantId === String(tenantId)).map(item => Object.assign({ userId }, item)));
  const tenantName = tenantId => membersOf(tenantId)[0]?.name || tenantId;
  const roleIdOf = (tenantId, code) => (roles[tenantId] || []).find(role => role.code === code)?.id || null;
  const deletedTenants = new Set();
  const tenantIds = () => [...new Set([...Object.keys(tenantPermissions), ...Object.values(memberships).flatMap(items => items.map(item => String(item.tenantId)))])].filter(id => !deletedTenants.has(id));

  const ns = {
    memberships,
    tenantPermissions,
    sources,
    get permissions() {
      return [...sources.values()].reduce((result, source) => ({ modules: mergeModules(result.modules, source.tree.modules) }), { modules: mergeModules([], permissions.modules) });
    },
    setPermissionSource: (key, tree, { defaultDisabled = false } = {}) => sources.set(key, { tree, defaultDisabled }),
    removePermissionSource: key => sources.delete(key),
    onChange: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emitChange: event => listeners.forEach(listener => listener(event)),
    deletedTenants,
    models: {
      tenant: {
        findByPk: async id => (tenantIds().includes(String(id)) ? { id: String(id) } : null),
        findAll: async () => tenantIds().map(id => ({ id }))
      },
      role: { findAll: async ({ where }) => roles[where.tenantId] || [] },
      org: { findAll: async ({ where }) => orgs[where.tenantId] || [] },
      user: {
        findAndCountAll: async ({ where, offset = 0, limit = 20 }) => {
          const rows = membersOf(where.tenantId).map(item => ({
            id: item.id,
            userId: item.userId,
            name: item.memberName || `成员 ${item.userId}`,
            avatar: item.avatar || null,
            status: item.status || 'open',
            roles: (item.roles || []).map(code => roleIdOf(where.tenantId, code)).filter(Boolean),
            tenantOrgIds: item.orgIds || []
          }));
          return { rows: rows.slice(offset, offset + limit), count: rows.length };
        }
      }
    },
    services: {
      tenant: {
        detail: async ({ id }) => Object.assign({ id, name: tenantName(id), status: 'open', company: { name: `${tenantName(id)} 公司` } }, profiles[id])
      },
      permission: {
        list: async ({ tenantId }) => ({ codes: tenantPermissions[tenantId] || [] }),
        save: async ({ tenantId, permissions: codes }) => {
          tenantPermissions[tenantId] = codes;
          ns.emitChange({ tenantId: String(tenantId), type: 'tenant-permission' });
        }
      },
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
            permissions: item.permissions || [],
            tenant: { id: item.tenantId, name: item.name, status: 'open' }
          };
        }
      }
    }
  };

  ns.authenticate = {
    tenantUser: async request => {
      if (!request.tenantUserInfo) {
        const tenantId = request.authenticatePayload?.tenantId;
        request.tenantUserInfo = await ns.services.user.getTenantUserInfo({ id: request.authenticatePayload?.id, tenantId });
      }
    }
  };

  fastify.decorate('tenant', ns);
});
