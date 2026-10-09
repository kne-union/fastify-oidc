const fp = require('fastify-plugin');

const idSchema = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const listQuery = {
  type: 'object',
  properties: {
    filter: { type: 'object', additionalProperties: true },
    perPage: { type: 'number', default: 20 },
    currentPage: { type: 'number', default: 1 }
  }
};
const statusBody = {
  type: 'object',
  required: ['id', 'status'],
  properties: { id: { type: 'string' }, status: { type: 'string', enum: ['open', 'closed'] } }
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
      id: { type: 'string' },
      clientId: { type: 'string' },
      clientName: { type: 'string' },
      clientSecret: { type: 'string' },
      metadata: { type: 'object', additionalProperties: true },
      allowedResources: { type: 'array', items: { type: 'string' } },
      description: { type: 'string' }
    }
  };

  const resourceServerBody = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      identifier: { type: 'string' },
      name: { type: 'string' },
      scope: { type: 'string' },
      accessTokenTTL: { type: 'number' },
      includePermissions: { type: 'boolean' },
      description: { type: 'string' }
    }
  };

  const crud = (path, tag, service, body) => {
    const tags = [tag];
    const onRequest = options.getAuthenticate(`${path}:manage`);
    fastify.get(
      `${admin}/${path}/list`,
      { onRequest, schema: { tags, summary: `${tag}列表`, query: listQuery } },
      wrap(async request => service().list(request.query))
    );
    fastify.get(
      `${admin}/${path}/detail`,
      { onRequest, schema: { tags, summary: `${tag}详情`, query: idSchema } },
      wrap(async request => service().detail(request.query))
    );
    fastify.post(
      `${admin}/${path}/create`,
      { onRequest, schema: { tags, summary: `创建${tag}`, body } },
      wrap(async request => service().create(request.body))
    );
    fastify.post(
      `${admin}/${path}/save`,
      { onRequest, schema: { tags, summary: `修改${tag}`, body: Object.assign({}, body, { required: ['id'] }) } },
      wrap(async request => {
        await service().save(request.body);
        return {};
      })
    );
    fastify.post(
      `${admin}/${path}/set-status`,
      { onRequest, schema: { tags, summary: `启用 / 停用${tag}`, body: statusBody } },
      wrap(async request => {
        await service().setStatus(request.body);
        return {};
      })
    );
    fastify.post(
      `${admin}/${path}/remove`,
      { onRequest, schema: { tags, summary: `删除${tag}`, body: idSchema } },
      wrap(async request => {
        await service().remove(request.body);
        return {};
      })
    );
  };

  crud('client', 'OIDC Client', () => services.client, clientBody);
  crud('resource-server', 'OIDC 资源服务', () => services.resourceServer, resourceServerBody);

  fastify.post(
    `${admin}/client/rotate-secret`,
    { onRequest: options.getAuthenticate('client:manage'), schema: { tags: ['OIDC Client'], summary: '重置 client secret（明文只返回一次）', body: idSchema } },
    wrap(async request => services.client.rotateSecret(request.body))
  );

  fastify.get(
    `${admin}/key/list`,
    { onRequest: options.getAuthenticate('key:manage'), schema: { tags: ['OIDC 签名密钥'], summary: '签名密钥列表' } },
    wrap(async () => services.key.list())
  );

  fastify.post(
    `${admin}/key/rotate`,
    { onRequest: options.getAuthenticate('key:manage'), schema: { tags: ['OIDC 签名密钥'], summary: '轮换签名密钥' } },
    wrap(async () => services.key.rotate())
  );

  fastify.get(
    `${admin}/session/list`,
    {
      onRequest: options.getAuthenticate('session:manage'),
      schema: { tags: ['OIDC 会话'], summary: '用户登录会话列表', query: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } } }
    },
    wrap(async request => services.grant.listSessions(request.query))
  );

  fastify.post(
    `${admin}/session/revoke`,
    {
      onRequest: options.getAuthenticate('session:manage'),
      schema: { tags: ['OIDC 会话'], summary: '结束指定会话', body: { type: 'object', required: ['uid'], properties: { uid: { type: 'string' } } } }
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
        tags: ['OIDC 会话'],
        summary: '撤销用户全部令牌（logout=true 时同时强制下线）',
        body: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' }, logout: { type: 'boolean', default: true } } }
      }
    },
    wrap(async request => services.grant.revokeByAccount(request.body.userId, { logout: request.body.logout }))
  );
});
