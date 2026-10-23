const fp = require('fastify-plugin');
const { str, num, any, list, obj, success, empty, pageResult, client, resourceServer, app, key } = require('../schema/response');

const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string', description: '记录 ID' } } };
const listQuery = {
  type: 'object',
  properties: {
    filter: {
      type: 'object',
      additionalProperties: true,
      description: '筛选条件',
      properties: {
        keyword: { description: '关键字，模糊匹配编码 / 名称' },
        status: { description: '状态：open 启用，closed 停用' }
      }
    },
    perPage: { type: 'number', default: 20, description: '每页条数' },
    currentPage: { type: 'number', default: 1, description: '页码，从 1 开始' }
  }
};
const statusBody = {
  type: 'object',
  required: ['id', 'status'],
  properties: { id: { type: 'string', description: '记录 ID' }, status: { type: 'string', enum: ['open', 'closed'], description: '目标状态：open 启用，closed 停用' } }
};

module.exports = fp(async (fastify, options) => {
  const { services, translator } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { wrap } = translator;
  const admin = `${options.prefix}/admin`;

  const clientBody = {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记录 ID，修改时必填，创建时忽略' },
      clientId: { type: 'string', description: 'client_id，仅创建时生效，不传随机生成；不能与已有 client 重复' },
      clientName: { type: 'string', description: '应用名称；修改时不传保持原值' },
      clientSecret: { type: 'string', description: 'client secret，仅创建 confidential client 时生效，不传随机生成；修改请用重置 secret 接口' },
      metadata: {
        type: 'object',
        additionalProperties: true,
        description: 'OIDC client metadata（redirect_uris、post_logout_redirect_uris、grant_types、response_types、token_endpoint_auth_method 等，snake_case），未传的字段使用 public SPA 默认值；修改时传入则整体替换，不传保持原值'
      },
      allowedResources: { type: 'array', items: { type: 'string' }, description: '允许申请的资源服务 identifier 列表；修改时不传保持原值' },
      description: { type: 'string', description: '描述；修改时不传保持原值' }
    }
  };

  const resourceServerBody = {
    type: 'object',
    properties: {
      id: { type: 'string', description: '记录 ID，修改时必填，创建时忽略' },
      identifier: { type: 'string', description: 'resource indicator（URL），即 access_token 的 aud；仅创建时生效，不能与已有资源服务重复' },
      name: { type: 'string', description: '资源名称' },
      scope: { type: 'string', description: '支持的 scope，空格分隔；为空使用默认 scope（defaultResourceScope）' },
      accessTokenTTL: { type: 'number', description: 'access_token 有效期（秒），为空使用全局配置' },
      includePermissions: { type: 'boolean', description: 'access_token 中是否携带 permissions，为空使用全局配置' },
      description: { type: 'string', description: '描述' }
    }
  };

  const crud = ({ path, tag, name, service, body, item, createDescription, saveDescription }) => {
    const tags = [tag];
    const onRequest = options.getAuthenticate(`${path}:manage`);
    fastify.get(
      `${admin}/${path}/list`,
      {
        onRequest,
        schema: { tags, summary: `${name}列表`, description: '分页查询，按创建时间倒序', query: listQuery, response: success(`${name}分页列表`, pageResult(name, item)) }
      },
      wrap(async request => service().list(request.query))
    );
    fastify.get(
      `${admin}/${path}/detail`,
      { onRequest, schema: { tags, summary: `${name}详情`, query: idSchema, response: success(`${name}详情`, Object.assign({}, item, { nullable: false })) } },
      wrap(async request => service().detail(request.query))
    );
    fastify.post(
      `${admin}/${path}/create`,
      { onRequest, schema: { tags, summary: `创建${name}`, description: createDescription, body, response: success(`创建后的${name}`, Object.assign({}, item, { nullable: false })) } },
      wrap(async request => service().create(request.body))
    );
    fastify.post(
      `${admin}/${path}/save`,
      { onRequest, schema: { tags, summary: `修改${name}`, description: saveDescription, body: Object.assign({}, body, { required: ['id'] }), response: empty('保存成功') } },
      wrap(async request => {
        await service().save(request.body);
        return {};
      })
    );
    fastify.post(
      `${admin}/${path}/set-status`,
      { onRequest, schema: { tags, summary: `启用 / 停用${name}`, description: `停用后该${name}不再参与 OIDC 授权`, body: statusBody, response: empty('设置成功') } },
      wrap(async request => {
        await service().setStatus(request.body);
        return {};
      })
    );
    fastify.post(
      `${admin}/${path}/remove`,
      { onRequest, schema: { tags, summary: `删除${name}`, description: `物理删除该${name}`, body: idSchema, response: empty('删除成功') } },
      wrap(async request => {
        await service().remove(request.body);
        return {};
      })
    );
  };

  crud({
    path: 'client',
    tag: 'OIDC管理后台-Client',
    name: 'OIDC Client',
    service: () => services.client,
    body: clientBody,
    item: client,
    createDescription: '创建接入应用。metadata 会经 oidc-provider 校验；confidential client（token_endpoint_auth_method 不为 none）返回中额外带一次 clientSecret 明文，之后不再返回',
    saveDescription: '修改接入应用；clientId 与 clientSecret 不可通过本接口修改。改为 public client 时清除 secret，改为 confidential 且原来没有 secret 时自动生成（不返回明文，需再调用重置 secret）'
  });
  crud({
    path: 'resource-server',
    tag: 'OIDC管理后台-资源服务',
    name: '资源服务',
    service: () => services.resourceServer,
    body: resourceServerBody,
    item: resourceServer,
    createDescription: '注册一个可申请 access_token 的资源服务（API），identifier 必须是合法 URL',
    saveDescription: '修改资源服务；identifier 不可修改，未传的字段保持原值；scope 未传或为空时重置为默认 scope'
  });

  // 应用由子应用通过服务接口注册，管理端只能查看、启停与删除
  const appTags = ['OIDC管理后台-子应用'];
  const appOnRequest = options.getAuthenticate('app:manage');
  const appListQuery = Object.assign({}, listQuery, {
    properties: Object.assign({}, listQuery.properties, {
      filter: Object.assign({}, listQuery.properties.filter, {
        properties: Object.assign({}, listQuery.properties.filter.properties, {
          status: { description: '状态：open 启用，closed 停用；不传返回未删除的全部应用' },
          tenantMode: { description: '租户模式：client / independent' }
        })
      })
    })
  });
  fastify.get(
    `${admin}/app/list`,
    {
      onRequest: appOnRequest,
      schema: {
        tags: appTags,
        summary: '子应用列表',
        description: '分页查询已注册的子应用（不含已删除），按创建时间倒序',
        query: appListQuery,
        response: success('子应用分页列表', pageResult('子应用', app))
      }
    },
    wrap(async request => services.app.list(request.query))
  );
  fastify.get(
    `${admin}/app/detail`,
    {
      onRequest: appOnRequest,
      schema: { tags: appTags, summary: '子应用详情（含权限树）', query: idSchema, response: success('子应用详情，permissions 为完整权限树', Object.assign({}, app, { nullable: false })) }
    },
    wrap(async request => services.app.detail(request.query))
  );
  fastify.post(
    `${admin}/app/set-status`,
    {
      onRequest: appOnRequest,
      schema: {
        tags: appTags,
        summary: '启用 / 停用子应用（停用后从权限树移除）',
        description: '停用后该应用的 client 没有可用租户；状态变化时后台通知 independent 子应用回拉快照',
        body: statusBody,
        response: empty('设置成功')
      }
    },
    wrap(async request => {
      await services.app.setStatus(request.body);
      return {};
    })
  );
  fastify.post(
    `${admin}/app/remove`,
    {
      onRequest: appOnRequest,
      schema: {
        tags: appTags,
        summary: '删除子应用（子应用下次启动会重新注册）',
        description: '只标记为 removed，保留记录以继续拦截该应用的 client；后台通知 independent 子应用关闭托管租户',
        body: idSchema,
        response: empty('删除成功')
      }
    },
    wrap(async request => {
      await services.app.remove(request.body);
      return {};
    })
  );

  fastify.post(
    `${admin}/client/rotate-secret`,
    {
      onRequest: options.getAuthenticate('client:manage'),
      schema: {
        tags: ['OIDC管理后台-Client'],
        summary: '重置 client secret（明文只返回一次）',
        description: '为 confidential client 生成新的 secret，旧 secret 立即失效；public client 调用返回 400',
        body: idSchema,
        response: success('新的 client secret', { type: 'object', properties: { clientId: str('client_id'), clientSecret: str('新的 client secret 明文，只返回这一次') } })
      }
    },
    wrap(async request => services.client.rotateSecret(request.body))
  );

  const keyList = { type: 'array', items: key };
  fastify.get(
    `${admin}/key/list`,
    {
      onRequest: options.getAuthenticate('key:manage'),
      schema: { tags: ['OIDC管理后台-签名密钥'], summary: '签名密钥列表', description: '按 active、next、retired 排序，不返回私钥', response: success('签名密钥列表', keyList) }
    },
    wrap(async () => services.key.list())
  );

  fastify.post(
    `${admin}/key/rotate`,
    {
      onRequest: options.getAuthenticate('key:manage'),
      schema: {
        tags: ['OIDC管理后台-签名密钥'],
        summary: '轮换签名密钥',
        description: '当前 active 密钥退役（仍用于验签），next 密钥启用，并生成新的 next 密钥；清理超过保留期的退役密钥后重载 provider',
        response: success('轮换后的签名密钥列表', keyList)
      }
    },
    wrap(async () => services.key.rotate())
  );

  fastify.get(
    `${admin}/session/list`,
    {
      onRequest: options.getAuthenticate('session:manage'),
      schema: {
        tags: ['OIDC管理后台-会话'],
        summary: '用户登录会话列表',
        description: '列出用户在 IdP 的登录会话及已授权的 client',
        query: { type: 'object', required: ['userId'], properties: { userId: { type: 'string', description: '用户 ID' } } },
        response: success('会话列表', {
          type: 'array',
          items: obj('登录会话', {
            uid: str('会话 uid，结束会话时使用'),
            loginAt: any('登录时间'),
            expiresAt: any('会话过期时间'),
            clients: list('已授权的 client', obj('授权', { clientId: str('client_id'), sid: str('该 client 的会话 sid') }))
          })
        })
      }
    },
    wrap(async request => services.grant.listSessions(request.query))
  );

  fastify.post(
    `${admin}/session/revoke`,
    {
      onRequest: options.getAuthenticate('session:manage'),
      schema: {
        tags: ['OIDC管理后台-会话'],
        summary: '结束指定会话',
        description: '撤销该会话下全部授权与令牌，向已授权 client 发送 back-channel logout 通知并删除会话',
        body: { type: 'object', required: ['uid'], properties: { uid: { type: 'string', description: '会话 uid（来自会话列表）' } } },
        response: empty('会话已结束')
      }
    },
    wrap(async request => {
      await services.grant.revokeSession(request.body);
      return {};
    })
  );

  fastify.post(
    `${admin}/session/revoke-user`,
    {
      onRequest: options.getAuthenticate('session:manage'),
      schema: {
        tags: ['OIDC管理后台-会话'],
        summary: '撤销用户全部令牌（logout=true 时同时强制下线）',
        description: '撤销用户已签发的全部令牌与授权；logout=true 时同时结束全部会话并发送 back-channel logout',
        body: {
          type: 'object',
          required: ['userId'],
          properties: {
            userId: { type: 'string', description: '用户 ID' },
            logout: { type: 'boolean', default: true, description: '是否同时结束会话（强制下线），默认 true；false 时保留会话，前端可静默重新获取令牌' }
          }
        },
        response: success('撤销结果', { type: 'object', properties: { grants: num('撤销的授权数量'), sessions: num('结束的会话数量') } })
      }
    },
    wrap(async request => services.grant.revokeByAccount(request.body.userId, { logout: request.body.logout }))
  );
});
