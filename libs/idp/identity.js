const ACTIVE_USER_STATUS = [0, 1];

const plain = item => (item && typeof item.get === 'function' ? item.get({ plain: true }) : item);

/**
 * oidc-provider 与 kne 包之间的唯一桥接层：
 * 用户来自 fastify-account，租户 / 角色 / 权限来自 fastify-tenant（可选）
 */
module.exports = ({ fastify, options }) => {
  const account = () => {
    const ns = fastify[options.accountNamespace];
    if (!ns) {
      throw new Error(`fastify-oidc: 未找到 fastify.${options.accountNamespace}，IdP 模式需要先注册 @kne/fastify-account`);
    }
    return ns;
  };
  const tenant = () => fastify[options.tenantNamespace];

  const tenantEnabled = () => !!tenant();

  const getUser = async id => {
    try {
      return await account().services.user.getUser({ id });
    } catch (e) {
      return null;
    }
  };

  const isSuperAdmin = async id => {
    const check = account().services.admin?.checkIsSuperAdmin;
    if (!check) {
      return undefined;
    }
    try {
      return (await check({ id })) === true;
    } catch (e) {
      return undefined;
    }
  };

  const toProfileClaims = user => ({
    sub: String(user.id),
    name: user.nickname || undefined,
    nickname: user.nickname || undefined,
    picture: user.avatar || undefined,
    email: user.email || undefined,
    phone_number: user.phone || undefined,
    gender: user.gender || undefined,
    birthdate: user.birthday ? String(user.birthday).slice(0, 10) : undefined
  });

  const findAccount = async (ctx, sub) => {
    const user = await getUser(sub);
    if (!user || !ACTIVE_USER_STATUS.includes(user.status)) {
      return undefined;
    }
    return {
      accountId: String(user.id),
      async claims() {
        return toProfileClaims(user);
      }
    };
  };

  const verifyCredentials = async credentials => {
    const { services } = account();
    if (typeof services.account.verifyCredentials !== 'function') {
      throw new Error('fastify-oidc: 需要 @kne/fastify-account 提供 services.account.verifyCredentials，请升级 fastify-account');
    }
    return services.account.verifyCredentials(credentials);
  };

  const listTenants = async accountId => {
    if (!tenantEnabled()) {
      return { list: [], defaultTenantId: null };
    }
    const { list, defaultTenantId } = await tenant().services.user.tenantList({ id: accountId });
    return {
      list: list
        .map(plain)
        .filter(item => item.status === 'open' && (!item.tenant || item.tenant.status === 'open'))
        .map(item => ({
          tenantId: String(item.tenantId),
          tenantUserId: String(item.id),
          name: item.tenant?.name,
          logo: item.tenant?.logo,
          companyName: item.tenant?.company?.name
        })),
      defaultTenantId: defaultTenantId ? String(defaultTenantId) : null
    };
  };

  const isTenantMember = async (accountId, tenantId) => {
    const { list } = await listTenants(accountId);
    return list.some(item => item.tenantId === String(tenantId));
  };

  const getTenantContext = async ({ accountId, tenantId }) => {
    if (!tenantEnabled() || !tenantId) {
      return null;
    }
    let info;
    try {
      info = plain(await tenant().services.user.getTenantUserInfo({ id: accountId, tenantId }));
    } catch (e) {
      return null;
    }
    if (!info || String(info.tenantId) !== String(tenantId)) {
      return null;
    }
    return {
      tenantId: String(info.tenantId),
      tenantUserId: String(info.id),
      roles: (info.roleDetails || []).map(role => role.code || String(role.id)).filter(Boolean),
      permissions: info.permissions || []
    };
  };

  return { tenantEnabled, getUser, isSuperAdmin, toProfileClaims, findAccount, verifyCredentials, listTenants, isTenantMember, getTenantContext };
};
