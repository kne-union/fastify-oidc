const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { pick } = require('lodash');
const { createError } = require('../utils/intl');

const { NotFound } = httpErrors;

const PROFILE_FIELDS = ['id', 'nickname', 'avatar', 'email', 'phone', 'gender', 'birthday', 'description', 'status'];

/**
 * 供 central 子项目以 client_credentials 令牌调用的服务接口
 */
module.exports = fp(async (fastify, options) => {
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { authenticate, translator } = fastify[options.name];
  const { wrap } = translator;
  const getIdp = () => fastify[options.name].idp;
  const tags = ['OIDC 服务接口'];

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
      return Object.assign(pick(user, PROFILE_FIELDS), { id: String(user.id), isSuperAdmin: await identity.isSuperAdmin(user.id) });
    })
  );

  fastify.get(
    `${options.prefix}/service/tenant-user`,
    {
      onRequest: [authenticate.client('tenant:read')],
      schema: {
        tags,
        summary: '获取用户在租户内的身份、角色与权限',
        query: { type: 'object', required: ['userId', 'tenantId'], properties: { userId: { type: 'string' }, tenantId: { type: 'string' } } }
      }
    },
    wrap(async request => {
      const tenant = fastify[options.tenantNamespace];
      if (!tenant) {
        throw createError(NotFound, 'tenantNotEnabled');
      }
      const { userId, tenantId } = request.query;
      if (!(await getIdp().identity.isTenantMember(userId, tenantId))) {
        throw createError(NotFound, 'tenantMemberNotFound');
      }
      return tenant.services.user.getTenantUserInfo({ id: userId, tenantId });
    })
  );
});
