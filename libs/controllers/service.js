const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { pick } = require('lodash');
const { createError } = require('../utils/intl');
const { collectTenantImages } = require('../utils/tenant-images');
const { str, num, bool, any, list, obj, success, tenantList } = require('../schema/response');

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
  const tags = ['OIDC-服务接口'];
  const SERVICE_HINT = '供 central 子项目以 client_credentials 令牌（Bearer）调用';

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
      schema: {
        tags,
        summary: '获取用户资料',
        description: `${SERVICE_HINT}，需要 user:read scope。用户不存在返回 404`,
        query: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: '用户 ID' } } },
        response: success('用户资料', {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: str('用户 ID'),
            nickname: str('昵称'),
            avatar: any('头像文件 ID（主项目文件库）'),
            avatarUrl: str('头像可直接下载的地址，无法解析时为 null'),
            email: str('邮箱'),
            phone: str('手机号'),
            gender: str('性别：F 女，M 男'),
            birthday: any('出生日期'),
            description: str('个人简介'),
            status: any('用户状态：0 正常'),
            isSuperAdmin: bool('是否为平台超级管理员；账号插件不支持判断时不返回')
          }
        })
      }
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

  const appQuery = { app: { type: 'string', description: '子应用 code，传入后只返回已开通该应用的数据，权限去掉 apps:<code>: 前缀；必须是当前服务 client 注册的应用' } };

  fastify.get(
    `${options.prefix}/service/tenant-user`,
    {
      onRequest: [authenticate.client('tenant:read')],
      schema: {
        tags,
        summary: '获取用户在租户内的身份、角色与权限',
        description: `${SERVICE_HINT}，需要 tenant:read scope。用户不是该租户成员（或租户未开通该应用）返回 404`,
        query: {
          type: 'object',
          required: ['userId', 'tenantId'],
          properties: Object.assign({ userId: { type: 'string', description: '用户 ID' }, tenantId: { type: 'string', description: '租户 ID' } }, appQuery)
        },
        response: success(
          '租户成员信息（fastify-tenant getTenantUserInfo 原样返回，传 app 时 permissions 已去前缀）',
          obj('租户成员信息', {
            id: any('租户成员 ID'),
            tenantId: any('租户 ID'),
            permissions: any('权限 code 列表'),
            roleDetails: any('角色详情列表'),
            tenant: any('租户信息')
          })
        )
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
      schema: {
        tags,
        summary: '用户可用租户列表',
        description: `${SERVICE_HINT}，需要 tenant:read scope。传 app 且应用已停用时返回空列表`,
        query: { type: 'object', required: ['userId'], properties: Object.assign({ userId: { type: 'string', description: '用户 ID' } }, appQuery) },
        response: success('可用租户列表', tenantList)
      }
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
        description: `${SERVICE_HINT}，需要 app:register scope。同一 code 只能由首次注册的服务 client 更新；已删除的应用重新注册时恢复启用`,
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', description: '应用编码，只能包含字母、数字、_、-' },
            name: { type: 'string', description: '应用名称，不传使用 code' },
            description: { type: 'string', description: '应用描述' },
            tenantMode: { type: 'string', enum: ['client', 'independent'], description: '租户模式：client 租户由宿主提供（默认），independent 子应用本地租户' },
            clientId: { type: 'string', description: '子应用登录用的 client_id' },
            resource: { type: 'string', description: '子应用资源服务 identifier（access_token 的 aud）' },
            permissions: { type: 'object', additionalProperties: true, description: '权限树（不含 apps 前缀），不传视为空树 { modules: [] }' },
            tenantSyncUri: { type: 'string', description: 'independent 模式接收租户变更通知的地址，client 模式忽略' }
          }
        },
        response: success('注册结果', {
          type: 'object',
          properties: {
            code: str('应用编码'),
            status: str('应用状态：open 启用，closed 停用'),
            permissionsHash: str('权限树摘要'),
            changed: bool('权限树是否有变化（新注册、恢复或权限树变更）')
          }
        })
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
        description: `${SERVICE_HINT}，需要 tenant:sync scope。id 均为宿主侧 id；租户未开通应用时 enabled=false 且不返回权限、角色、组织；宿主已删除租户时 removed=true`,
        query: { type: 'object', required: ['tenantId', 'app'], properties: Object.assign({ tenantId: { type: 'string', description: '宿主租户 ID' } }, appQuery) },
        response: success('租户快照', {
          type: 'object',
          additionalProperties: true,
          properties: {
            tenant: obj('租户基本信息', {
              id: str('租户 ID'),
              name: str('租户名称'),
              status: any('租户状态'),
              logo: any('租户 logo 文件 ID（宿主文件库）'),
              companyName: str('公司名称'),
              company: any('公司信息')
            }),
            enabled: bool('租户是否已开通且应用处于启用状态'),
            removed: bool('宿主是否已删除该租户；未删除时不返回'),
            permissions: any('租户已开通的应用权限 code（已去前缀）'),
            roles: list(
              '角色列表',
              obj('角色', {
                id: str('角色 ID'),
                code: str('角色 code，没有 code 时为 role-<id>'),
                name: any('角色名称'),
                description: any('角色描述'),
                type: any('角色类型'),
                status: any('角色状态'),
                permissions: any('角色权限 code（已去前缀）')
              })
            ),
            orgs: list(
              '组织列表',
              obj('组织', {
                id: str('组织 ID'),
                parentId: str('上级组织 ID，根组织为 null'),
                name: any('组织名称'),
                description: any('组织描述'),
                index: any('排序'),
                status: any('组织状态'),
                leaderTenantUserId: str('负责人租户成员 ID')
              })
            ),
            fileUrls: obj('快照中图片文件的下载地址：{ 宿主文件 id: 地址 }，解析不到的不返回；租户已删除时不返回')
          }
        })
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
        description: `${SERVICE_HINT}，需要 tenant:sync scope。只返回已关联账号的成员，按加入时间正序；应用停用或租户未开通时返回空列表`,
        query: {
          type: 'object',
          required: ['tenantId', 'app'],
          properties: Object.assign(
            {
              tenantId: { type: 'string', description: '宿主租户 ID' },
              currentPage: { type: 'number', default: 1, description: '页码，从 1 开始' },
              perPage: { type: 'number', default: 200, maximum: 1000, description: '每页条数，最大 1000' }
            },
            appQuery
          )
        },
        response: success('租户成员分页', {
          type: 'object',
          additionalProperties: true,
          properties: {
            pageData: list(
              '当前页成员',
              obj('租户成员', {
                id: str('租户成员 ID'),
                userId: str('账号用户 ID'),
                name: any('成员姓名'),
                email: any('邮箱'),
                phone: any('手机号'),
                avatar: any('头像文件 ID（宿主文件库）'),
                status: any('成员状态'),
                roleCodes: any('角色 code 列表'),
                tenantOrgIds: any('所属组织 ID 列表')
              })
            ),
            totalCount: num('成员总数'),
            fileUrls: obj('头像下载地址：{ 宿主文件 id: 地址 }；返回空列表时不返回')
          }
        })
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
