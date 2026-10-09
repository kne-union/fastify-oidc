const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services, translator } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { wrap } = translator;
  const base = `${options.prefix}/interaction/:uid`;
  const params = { type: 'object', required: ['uid'], properties: { uid: { type: 'string' } } };
  const tags = ['OIDC 登录交互'];

  fastify.get(
    base,
    {
      schema: { tags, summary: '交互入口，跳转到前端登录交互页', params }
    },
    async (request, reply) => {
      const target = new URL(options.interactionPage, options.runtime.origin);
      target.searchParams.set('uid', request.params.uid);
      return reply.redirect(target.toString(), 303);
    }
  );

  fastify.get(
    `${base}/details`,
    {
      schema: { tags, summary: '获取当前交互详情（步骤、client、用户、可选租户）', params }
    },
    wrap(async (request, reply) => services.interaction.details({ request, reply, uid: request.params.uid }))
  );

  fastify.post(
    `${base}/login`,
    {
      schema: {
        tags,
        summary: '账号密码登录',
        params,
        body: {
          type: 'object',
          required: ['password'],
          properties: {
            type: { type: 'string', enum: ['email', 'phone'], default: 'email' },
            email: { type: 'string' },
            phone: { type: 'string' },
            password: { type: 'string' },
            remember: { type: 'boolean', default: true }
          }
        }
      }
    },
    wrap(async (request, reply) => {
      const { remember, ...credentials } = request.body;
      return services.interaction.login({ request, reply, uid: request.params.uid, credentials, remember });
    })
  );

  fastify.post(
    `${base}/tenant`,
    {
      schema: {
        tags,
        summary: '选择租户',
        params,
        body: { type: 'object', required: ['tenantId'], properties: { tenantId: { type: 'string' } } }
      }
    },
    wrap(async (request, reply) => services.interaction.selectTenant({ request, reply, uid: request.params.uid, tenantId: request.body.tenantId }))
  );

  fastify.post(
    `${base}/confirm`,
    {
      schema: { tags, summary: '确认授权（consent）', params }
    },
    wrap(async (request, reply) => services.interaction.confirm({ request, reply, uid: request.params.uid }))
  );

  fastify.post(
    `${base}/abort`,
    {
      schema: { tags, summary: '取消登录', params }
    },
    wrap(async (request, reply) => services.interaction.abort({ request, reply, uid: request.params.uid }))
  );
});
