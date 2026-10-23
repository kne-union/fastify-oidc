const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { createError } = require('../utils/intl');
const { wrapAppTree, countPermissions, hashPermissions } = require('../utils/app-permissions');

const { NotFound, BadRequest, Forbidden } = httpErrors;

const TENANT_MODES = ['client', 'independent'];
const plain = item => item.get({ plain: true });

/**
 * 应用中心：子应用注册的权限树挂到宿主 fastify-tenant 的 apps 节点下，按租户开关
 * 应用缓存在内存（含停用 / 已删除），交互与签发 token 时按 clientId / resource 同步查找：
 * 停用或删除的应用仍要拦住其 client，不能退化成不按应用过滤
 */
module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { Op } = fastify.sequelize.Sequelize;
  const sourceKey = code => `oidc-app:${code}`;
  let cache = [];
  let loaded = new Map();

  const getTenant = () => (options.runtime.tenantRole === 'host' ? options.getTenant() : null);
  const listOpen = () => cache.filter(app => app.status === 'open');

  // 只对权限树有变化的应用重设来源，避免周期重载时反复重建宿主权限树
  const loadIntoTenant = () => {
    const tenant = getTenant();
    if (!tenant || typeof tenant.setPermissionSource !== 'function') {
      return;
    }
    const next = new Map();
    listOpen().forEach(app => {
      const signature = `${app.name}:${app.permissionsHash}`;
      if (loaded.get(app.code) !== signature) {
        tenant.setPermissionSource(sourceKey(app.code), wrapAppTree({ prefix: options.appPermissionPrefix, centerName: options.appCenterName, app }), { defaultDisabled: true });
      }
      next.set(app.code, signature);
    });
    loaded.forEach((signature, code) => !next.has(code) && tenant.removePermissionSource(sourceKey(code)));
    loaded = next;
  };

  const reload = async () => {
    cache = (await models.app.findAll()).map(plain);
    loadIntoTenant();
  };

  // 停用 / 启用 / 删除后通知 independent 子应用回拉，及时关闭或恢复托管租户；后台执行，不阻塞管理操作
  const notifyApp = app => {
    if (app.tenantMode !== 'independent' || !app.tenantSyncUri || !services.tenantPush) {
      return;
    }
    services.tenantPush.notifyApp(app).catch(err => fastify.log.warn({ err, app: app.code }, 'fastify-oidc: 通知子应用应用状态变化失败'));
  };

  const format = item => {
    const data = plain(item);
    data.clientIds = data.clientIds || [];
    data.permissionCount = countPermissions(data.permissions);
    return data;
  };

  const getInstance = async ({ id }) => {
    const item = await models.app.findByPk(id);
    if (!item || item.status === 'removed') {
      throw createError(NotFound, 'appNotFound');
    }
    return item;
  };

  const register = async ({ serviceClientId, code, name, description, tenantMode = 'client', clientId, resource, permissions, tenantSyncUri }) => {
    if (!code || !/^[A-Za-z0-9_-]+$/.test(code)) {
      throw createError(BadRequest, 'appCodeInvalid');
    }
    if (!TENANT_MODES.includes(tenantMode)) {
      throw createError(BadRequest, 'appTenantModeInvalid');
    }
    const item = await models.app.findOne({ where: { code } });
    const removed = item?.status === 'removed';
    if (item && !removed && item.serviceClientId !== serviceClientId) {
      throw createError(Forbidden, 'appCodeTaken', { code });
    }
    const tree = permissions && typeof permissions === 'object' ? permissions : { modules: [] };
    const permissionsHash = hashPermissions(tree);
    const values = {
      name: name || code,
      description,
      tenantMode,
      clientIds: clientId ? [clientId] : [],
      resource,
      permissions: tree,
      permissionsHash,
      tenantSyncUri: tenantMode === 'independent' ? tenantSyncUri || null : null,
      registeredAt: new Date()
    };
    const changed = !item || removed || item.permissionsHash !== permissionsHash;
    // 已删除的应用重新注册时恢复启用，并可由新的服务 client 接手
    const row = item ? await item.update(removed ? Object.assign({ serviceClientId, status: 'open' }, values) : values) : await models.app.create(Object.assign({ code, serviceClientId, status: 'open' }, values));
    await reload();
    if (removed) {
      notifyApp(plain(row));
    }
    return { code, status: row.status, permissionsHash, changed };
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
    if (filter.keyword) {
      where[Op.or] = [{ code: { [Op.like]: `%${filter.keyword}%` } }, { name: { [Op.like]: `%${filter.keyword}%` } }];
    }
    where.status = filter.status && filter.status !== 'removed' ? filter.status : { [Op.ne]: 'removed' };
    if (filter.tenantMode) {
      where.tenantMode = filter.tenantMode;
    }
    const { rows, count } = await models.app.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows.map(format), totalCount: count };
  };

  const detail = async ({ id }) => format(await getInstance({ id }));

  const setStatus = async ({ id, status }) => {
    const item = await getInstance({ id });
    const previous = item.status;
    await item.update({ status });
    await reload();
    if (previous !== status) {
      notifyApp(plain(item));
    }
  };

  // 只标记删除不删行：保留 clientIds 继续拦住该应用的 client；子应用下次启动注册时恢复
  const remove = async ({ id }) => {
    const item = await getInstance({ id });
    await item.update({ status: 'removed' });
    await reload();
    notifyApp(plain(item));
  };

  // 含停用 / 已删除的应用：independent 子应用回拉快照得到 enabled=false，据此关闭托管租户
  const getByCode = async code => {
    const item = code ? await models.app.findOne({ where: { code } }) : null;
    return item ? plain(item) : null;
  };

  const findByCode = code => cache.find(app => app.code === code) || null;
  const findByClientId = clientId => (clientId ? cache.find(app => (app.clientIds || []).includes(clientId)) || null : null);
  const findByResource = resource => (resource ? cache.find(app => app.resource === resource) || null : null);
  // 交互 / 签发 token 用的应用范围：appOpen=false 时该 client 没有可用租户
  const toScope = app => (app ? { appCode: app.code, appOpen: app.status === 'open' } : {});
  const scopeOfClient = clientId => toScope(findByClientId(clientId));
  const scopeOfResource = resource => toScope(findByResource(resource));

  services.app = {
    register,
    list,
    detail,
    setStatus,
    remove,
    reload,
    loadIntoTenant,
    getByCode,
    findByCode,
    findByClientId,
    findByResource,
    scopeOfClient,
    scopeOfResource,
    listOpen
  };
});
