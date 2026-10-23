const { scopePermissions, isAppEnabledIn } = require('../utils/app-permissions');
const { COMPANY_FIELDS } = require('../utils/tenant-images');

const ACTIVE_USER_STATUS = [0, 1];
const SNAPSHOT_TENANT_FIELDS = ['themeColor', 'description', 'accountCount', 'supportLanguage', 'defaultLanguage', 'serviceStartTime', 'serviceEndTime'];

const plain = item => (item && typeof item.get === 'function' ? item.get({ plain: true }) : item);
const pickFields = (item, fields) => Object.fromEntries(fields.filter(key => item[key] !== undefined).map(key => [key, item[key]]));
const toOrgIds = member => (Array.isArray(member.tenantOrgIds) ? member.tenantOrgIds : member.tenantOrgId ? [member.tenantOrgId] : []).map(String);

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
  const tenant = () => options.getTenant();
  const prefix = options.appPermissionPrefix;

  const tenantEnabled = () => !!tenant();

  const getTenantPermissionCodes = async tenantId => {
    try {
      return (await tenant().services.permission.list({ tenantId })).codes || [];
    } catch (e) {
      return [];
    }
  };

  const isAppEnabled = async (tenantId, appCode) => isAppEnabledIn(await getTenantPermissionCodes(tenantId), appCode, prefix);

  const scopeAppPermissions = (permissions, appCode) => scopePermissions(permissions, appCode, prefix);

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

  // appCode：只保留已开通该子应用的租户；appOpen=false（应用已停用 / 删除）时没有可用租户
  const listTenants = async (accountId, { appCode, appOpen = true } = {}) => {
    if (!tenantEnabled() || (appCode && !appOpen)) {
      return { list: [], defaultTenantId: null };
    }
    const { list, defaultTenantId } = await tenant().services.user.tenantList({ id: accountId });
    let result = list
      .map(plain)
      .filter(item => item.status === 'open' && (!item.tenant || item.tenant.status === 'open'))
      .map(item => ({
        tenantId: String(item.tenantId),
        tenantUserId: String(item.id),
        name: item.tenant?.name,
        logo: item.tenant?.logo,
        companyName: item.tenant?.company?.name
      }));
    if (appCode) {
      const enabled = await Promise.all(result.map(item => isAppEnabled(item.tenantId, appCode)));
      result = result.filter((item, index) => enabled[index]);
    }
    const normalizedDefault = defaultTenantId ? String(defaultTenantId) : null;
    return {
      list: result,
      defaultTenantId: result.some(item => item.tenantId === normalizedDefault) ? normalizedDefault : result[0]?.tenantId || null
    };
  };

  const isTenantMember = async (accountId, tenantId, scope = {}) => {
    const { list } = await listTenants(accountId, scope);
    return list.some(item => item.tenantId === String(tenantId));
  };

  const getTenantUserInfo = async ({ accountId, tenantId, appCode }) => {
    const info = plain(await tenant().services.user.getTenantUserInfo({ id: accountId, tenantId }));
    if (!appCode) {
      return info;
    }
    return Object.assign({}, info, { permissions: scopeAppPermissions(info.permissions, appCode) });
  };

  const getTenantContext = async ({ accountId, tenantId, appCode, appOpen = true }) => {
    if (!tenantEnabled() || !tenantId || (appCode && !appOpen)) {
      return null;
    }
    if (appCode && !(await isAppEnabled(tenantId, appCode))) {
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
      permissions: appCode ? scopeAppPermissions(info.permissions, appCode) : info.permissions || []
    };
  };

  // independent 子应用回拉的租户快照，id 均为宿主侧 id，权限已按应用去前缀；成员另走分页接口
  const getTenantSnapshot = async ({ tenantId, appCode, appOpen = true }) => {
    const { models, services } = tenant();
    // 宿主已删除该租户：返回 removed，子应用据此关闭托管租户（否则回拉一直失败，托管租户停在 open）
    if (!(await models.tenant.findByPk(tenantId))) {
      return { tenant: { id: String(tenantId), status: 'closed' }, enabled: false, removed: true, permissions: [], roles: [], orgs: [] };
    }
    const hostTenant = plain(await services.tenant.detail({ id: tenantId, withTenantSetting: false }));
    const codes = await getTenantPermissionCodes(tenantId);
    const enabled = appOpen && isAppEnabledIn(codes, appCode, prefix);
    const snapshot = {
      tenant: Object.assign(pickFields(hostTenant, SNAPSHOT_TENANT_FIELDS), {
        id: String(hostTenant.id),
        name: hostTenant.name,
        status: hostTenant.status,
        logo: hostTenant.logo || null,
        companyName: hostTenant.tenantCompany?.name || hostTenant.company?.name,
        company: pickFields(plain(hostTenant.tenantCompany || hostTenant.company) || {}, COMPANY_FIELDS)
      }),
      enabled,
      permissions: [],
      roles: [],
      orgs: []
    };
    if (!enabled) {
      return snapshot;
    }
    snapshot.permissions = scopeAppPermissions(codes, appCode);
    const roles = await models.role.findAll({ where: { tenantId } });
    snapshot.roles = roles.map(plain).map(role => ({
      id: String(role.id),
      code: role.code || `role-${role.id}`,
      name: role.name,
      description: role.description,
      type: role.type,
      status: role.status,
      permissions: scopeAppPermissions(role.permissions, appCode)
    }));
    const orgs = await models.org.findAll({ where: { tenantId } });
    snapshot.orgs = orgs.map(plain).map(org => ({
      id: String(org.id),
      parentId: org.parentId != null ? String(org.parentId) : null,
      name: org.name,
      description: org.description,
      index: org.index,
      status: org.status,
      leaderTenantUserId: org.leaderUserId != null ? String(org.leaderUserId) : null
    }));
    return snapshot;
  };

  // 只同步已关联账号的成员（未加入的邀请没有 userId，子应用无法建立镜像用户）
  const listTenantMembers = async ({ tenantId, currentPage = 1, perPage = 200 }) => {
    const { models } = tenant();
    const { Op } = fastify.sequelize.Sequelize;
    const roleCodes = new Map((await models.role.findAll({ where: { tenantId } })).map(plain).map(role => [String(role.id), role.code || `role-${role.id}`]));
    const { rows, count } = await models.user.findAndCountAll({
      where: { tenantId, userId: { [Op.ne]: null } },
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'ASC']]
    });
    return {
      pageData: rows.map(plain).map(member => ({
        id: String(member.id),
        userId: String(member.userId),
        name: member.name,
        email: member.email,
        phone: member.phone,
        avatar: member.avatar,
        status: member.status,
        roleCodes: (member.roles || []).map(id => roleCodes.get(String(id))).filter(Boolean),
        tenantOrgIds: toOrgIds(member)
      })),
      totalCount: count
    };
  };

  return {
    tenant,
    tenantEnabled,
    getUser,
    isSuperAdmin,
    toProfileClaims,
    findAccount,
    verifyCredentials,
    listTenants,
    isTenantMember,
    getTenantUserInfo,
    getTenantContext,
    isAppEnabled,
    scopePermissions: scopeAppPermissions,
    getTenantSnapshot,
    listTenantMembers
  };
};
