const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { pick } = require('lodash');
const { createError } = require('../utils/intl');
const { collectTenantImages } = require('../utils/tenant-images');

const { NotFound, Forbidden } = httpErrors;

const PROFILE_FIELDS = ['id', 'nickname', 'avatar', 'email', 'phone', 'gender', 'birthday', 'description', 'status'];

/**
 * 供 central 子项目以 client_credentials 令牌调用的服务接口
 */
module.exports = fp(async (fastify, options) => {
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { authenticate, translator, services } = fastify[options.name];
  const { wrap } = translator;
  const getIdp = () => fastify[options.name].idp;
  const tags = ['OIDC 服务接口'];

  // 头像、租户 logo 是主项目文件库的 id，子项目无法解析，额外给出可直接下载的地址
  const resolveFileUrl = async fileId => {
    if (!fileId) {
      return null;
    }
    if (/^https?:\/\//.test(fileId)) {
      return fileId;
    }
    const getFileUrl = fastify[options.fileNamespace]?.services?.getFileUrl;
    if (typeof getFileUrl !== 'function') {
      return null;
    }
    try {
      const url = await getFileUrl({ id: fileId });
      return url ? new URL(url, options.runtime.origin).href : null;
    } catch (e) {
      fastify.log.warn({ err: e, fileId }, 'fastify-oidc: 解析主项目文件地址失败');
      return null;
    }
  };

  // { 宿主文件 id: 可下载地址 }，解析不到的不返回
  const resolveFileUrls = async fileIds => {
    const ids = [...new Set(fileIds.filter(Boolean))];
    const urls = await Promise.all(ids.map(resolveFileUrl));
    return Object.fromEntries(ids.map((id, index) => [id, urls[index]]).filter(([, url]) => url));
  };

  fastify.get(
    `${options.prefix}/service/user`,
    {
      onRequest: [authenticate.client('user:read')],
      schema: { tags, summary: '获取用户资料', query: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }
    },
    wrap(async request => {
      const { identity } = getIdp();
      const user = await identity.getUser(request.query.id);
      if (!user) {
        throw createError(NotFound, 'userNotFound');
      }
      return Object.assign(pick(user, PROFILE_FIELDS), {
        id: String(user.id),
        avatarUrl: await resolveFileUrl(user.avatar),
        isSuperAdmin: await identity.isSuperAdmin(user.id)
      });
    })
  );

  const assertTenantEnabled = () => {
    if (!getIdp().identity.tenantEnabled()) {
      throw createError(NotFound, 'tenantNotEnabled');
    }
  };

  // 只能以注册该应用的服务 client 身份读取应用相关数据
  const resolveApp = async (request, code) => {
    if (!code) {
      return null;
    }
    const app = await services.app.getByCode(code);
    if (!app) {
      throw createError(NotFound, 'appNotFound');
    }
    if (app.serviceClientId !== request.user.clientId) {
      throw createError(Forbidden, 'appClientMismatch', { code });
    }
    return app;
  };

  const appQuery = { app: { type: 'string', description: '子应用 code，传入后只返回已开通该应用的数据，权限去掉 apps:<code>: 前缀' } };

  fastify.get(
    `${options.prefix}/service/tenant-user`,
    {
      onRequest: [authenticate.client('tenant:read')],
      schema: {
        tags,
        summary: '获取用户在租户内的身份、角色与权限',
        query: { type: 'object', required: ['userId', 'tenantId'], properties: Object.assign({ userId: { type: 'string' }, tenantId: { type: 'string' } }, appQuery) }
      }
    },
    wrap(async request => {
      assertTenantEnabled();
      const { userId, tenantId } = request.query;
      const app = await resolveApp(request, request.query.app);
      const { identity } = getIdp();
      if (app && app.status !== 'open') {
        throw createError(NotFound, 'appNotEnabled');
      }
      if (!(await identity.isTenantMember(userId, tenantId, { appCode: app?.code }))) {
        throw createError(NotFound, app ? 'appNotEnabled' : 'tenantMemberNotFound');
      }
      return identity.getTenantUserInfo({ accountId: userId, tenantId, appCode: app?.code });
    })
  );

  fastify.get(
    `${options.prefix}/service/tenant-list`,
    {
      onRequest: [authenticate.client('tenant:read')],
      schema: { tags, summary: '用户可用租户列表', query: { type: 'object', required: ['userId'], properties: Object.assign({ userId: { type: 'string' } }, appQuery) } }
    },
    wrap(async request => {
      assertTenantEnabled();
      const app = await resolveApp(request, request.query.app);
      if (app && app.status !== 'open') {
        return { list: [], defaultTenantId: null };
      }
      return getIdp().identity.listTenants(request.query.userId, { appCode: app?.code });
    })
  );

  fastify.post(
    `${options.prefix}/service/app/register`,
    {
      onRequest: [authenticate.client('app:register')],
      schema: {
        tags,
        summary: '子应用注册权限树到应用中心',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            tenantMode: { type: 'string', enum: ['client', 'independent'] },
            clientId: { type: 'string' },
            resource: { type: 'string' },
            permissions: { type: 'object', additionalProperties: true },
            tenantSyncUri: { type: 'string' }
          }
        }
      }
    },
    wrap(async request => services.app.register(Object.assign({}, request.body, { serviceClientId: request.user.clientId })))
  );

  fastify.get(
    `${options.prefix}/service/tenant-snapshot`,
    {
      onRequest: [authenticate.client('tenant:sync')],
      schema: {
        tags,
        summary: '租户快照（基本信息、租户权限、角色、组织），供 independent 子应用接管',
        query: { type: 'object', required: ['tenantId', 'app'], properties: Object.assign({ tenantId: { type: 'string' } }, appQuery) }
      }
    },
    wrap(async request => {
      assertTenantEnabled();
      const app = await resolveApp(request, request.query.app);
      const snapshot = await getIdp().identity.getTenantSnapshot({ tenantId: request.query.tenantId, appCode: app.code, appOpen: app.status === 'open' });
      if (!snapshot.removed) {
        snapshot.fileUrls = await resolveFileUrls(collectTenantImages(snapshot.tenant));
      }
      return snapshot;
    })
  );

  fastify.get(
    `${options.prefix}/service/tenant-members`,
    {
      onRequest: [authenticate.client('tenant:sync')],
      schema: {
        tags,
        summary: '租户成员分页（含角色 code 与所属组织），供 independent 子应用接管',
        query: {
          type: 'object',
          required: ['tenantId', 'app'],
          properties: Object.assign({ tenantId: { type: 'string' }, currentPage: { type: 'number', default: 1 }, perPage: { type: 'number', default: 200, maximum: 1000 } }, appQuery)
        }
      }
    },
    wrap(async request => {
      assertTenantEnabled();
      const app = await resolveApp(request, request.query.app);
      const { identity } = getIdp();
      const { tenantId, currentPage, perPage } = request.query;
      if (app.status !== 'open' || !(await identity.isAppEnabled(tenantId, app.code))) {
        return { pageData: [], totalCount: 0 };
      }
      const result = await identity.listTenantMembers({ tenantId, currentPage, perPage });
      return Object.assign(result, { fileUrls: await resolveFileUrls(result.pageData.map(member => member.avatar)) });
    })
  );
});
