const fp = require('fastify-plugin');

/**
 * 模拟 independent 子应用本地的 @kne/fastify-tenant：services.managed 记录宿主快照，
 * getTenantUserInfo 按本地默认租户（首次同步时设置）读取托管租户成员
 */
module.exports = fp(async (fastify, { permissions = { modules: [] } } = {}) => {
  const tenants = new Map();
  const defaults = new Map();
  const snapshots = [];
  let seq = 0;

  const findByHostTenantId = async ({ issuer, hostTenantId }) => [...tenants.values()].find(tenant => tenant.options.managedBy.issuer === issuer && tenant.options.managedBy.hostTenantId === String(hostTenantId)) || null;

  const applySnapshot = async ({ issuer, snapshot }) => {
    snapshots.push(snapshot);
    let tenant = await findByHostTenantId({ issuer, hostTenantId: snapshot.tenant.id });
    if (!tenant && !snapshot.enabled) {
      return null;
    }
    if (!tenant) {
      tenant = { id: `local-${++seq}`, roles: [], orgs: [], members: [], permissions: [] };
      tenants.set(tenant.id, tenant);
    }
    const files = snapshot.files || tenant.options?.managedBy?.files;
    Object.assign(tenant, {
      name: snapshot.tenant.name,
      status: snapshot.enabled && snapshot.tenant.status !== 'closed' ? 'open' : 'closed',
      options: { managedBy: Object.assign({ issuer, hostTenantId: String(snapshot.tenant.id), syncedAt: new Date().toISOString() }, files ? { files } : {}) }
    });
    ['logo', 'company'].forEach(key => snapshot.tenant[key] !== undefined && (tenant[key] = snapshot.tenant[key]));
    if (snapshot.enabled) {
      Object.assign(tenant, { permissions: snapshot.permissions, roles: snapshot.roles, orgs: snapshot.orgs, members: snapshot.members });
      tenant.members.forEach(member => !defaults.has(member.userId) && defaults.set(member.userId, tenant.id));
    }
    return tenant;
  };

  const getTenantUserInfo = async ({ id, tenantId }) => {
    const tenant = tenants.get(tenantId || defaults.get(String(id)));
    const member = tenant?.status === 'open' && tenant.members.find(item => item.userId === String(id));
    if (!member) {
      throw new Error('defaultTenantNotSet');
    }
    const roleDetails = tenant.roles.filter(role => member.roleCodes.includes(role.code));
    const granted = new Set(roleDetails.flatMap(role => role.permissions));
    return {
      id: `local-member-${member.id}`,
      tenantId: tenant.id,
      userId: String(id),
      roleDetails,
      permissions: tenant.permissions.filter(code => granted.has(code)),
      tenant: { id: tenant.id, name: tenant.name, status: tenant.status, options: tenant.options }
    };
  };

  fastify.decorate('tenant', {
    permissions,
    tenants,
    snapshots,
    services: { managed: { findByHostTenantId, applySnapshot }, user: { getTenantUserInfo } }
  });
});
