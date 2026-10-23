const fp = require('fastify-plugin');
const { str, any, list, obj, success } = require('../schema/response');

const FORWARD_HEADERS = ['content-type', 'accept', 'accept-language', 'x-app-name'];

/**
 * client 子应用的 /api/tenant 代理：getUserInfo、available-list 走服务接口（权限已去前缀、租户已按应用过滤），
 * 其余请求以 token exchange 换成宿主 API 的令牌后转发给宿主 fastify-tenant。只转发 JSON 请求
 */
module.exports = fp(async (fastify, options) => {
  if (options.runtime.tenantRole !== 'client' || !options.tenantProxy) {
    return;
  }
  const { runtime } = options;
  const { authenticate, serviceClient } = fastify[options.name];
  const proxy = Object.assign({ prefix: '/api/tenant', resource: `${runtime.issuerOrigin}/api`, target: null }, options.tenantProxy === true ? {} : options.tenantProxy);
  const target = proxy.target || `${runtime.issuerOrigin}${proxy.prefix}`;
  const exchanged = new Map();

  const getHostToken = async subjectToken => {
    const now = Date.now();
    exchanged.forEach((item, key) => item.expiresAt <= now && exchanged.delete(key));
    const cached = exchanged.get(subjectToken);
    if (cached && cached.expiresAt - 30 * 1000 > now) {
      return cached.accessToken;
    }
    const data = await serviceClient.exchangeToken({ subjectToken, resource: proxy.resource });
    exchanged.set(subjectToken, { accessToken: data.access_token, expiresAt: now + data.expires_in * 1000 });
    return data.access_token;
  };

  // 与 fastify-tenant available-list 同形，前端无需区分
  const toTenantList = ({ list = [], defaultTenantId = null }) => ({
    list: list.map(item => ({
      id: item.tenantUserId,
      tenantId: item.tenantId,
      status: 'open',
      tenant: { id: item.tenantId, name: item.name, logo: item.logo, status: 'open', company: item.companyName ? { name: item.companyName } : null }
    })),
    defaultTenantId
  });

  const tags = ['OIDC-租户代理'];

  fastify.get(
    `${proxy.prefix}/getUserInfo`,
    {
      onRequest: [authenticate.user, authenticate.tenantUser],
      schema: {
        tags,
        summary: '获取当前用户与当前租户信息',
        description: 'client 子应用使用，与 fastify-tenant getUserInfo 同形；租户信息经服务接口获取，权限已去掉 apps:<code>: 前缀',
        response: success('当前用户与租户信息', {
          type: 'object',
          additionalProperties: true,
          properties: {
            userInfo: any('当前用户'),
            tenantUserInfo: any('当前租户成员信息'),
            company: any('当前租户的公司信息'),
            tenant: any('当前租户')
          }
        })
      }
    },
    async request => {
      const info = request[options.tenantUserContextName];
      return { userInfo: request.userInfo, tenantUserInfo: info, company: info?.tenant?.tenantCompany || info?.tenant?.company || null, tenant: info?.tenant || null };
    }
  );

  fastify.get(
    `${proxy.prefix}/available-list`,
    {
      onRequest: [authenticate.user],
      schema: {
        tags,
        summary: '当前用户可用租户列表',
        description: 'client 子应用使用，经服务接口获取（只含已开通本应用的租户），与 fastify-tenant available-list 同形',
        response: success('可用租户列表', {
          type: 'object',
          additionalProperties: true,
          properties: {
            list: list(
              '可用租户',
              obj('租户成员身份', {
                id: str('用户在该租户的成员 ID'),
                tenantId: str('租户 ID'),
                status: str('成员状态，固定 open'),
                tenant: obj('租户', {
                  id: str('租户 ID'),
                  name: str('租户名称'),
                  logo: any('租户 logo 文件 ID'),
                  status: str('租户状态，固定 open'),
                  company: obj('公司，没有时为 null', { name: str('公司名称') })
                })
              })
            ),
            defaultTenantId: str('默认租户 ID')
          }
        })
      }
    },
    async request => toTenantList(await serviceClient.getTenantList({ userId: request.user.userId }))
  );

  fastify.all(
    `${proxy.prefix}/*`,
    {
      onRequest: [authenticate.user],
      schema: {
        tags,
        summary: '转发到宿主 fastify-tenant',
        description: '以 token exchange 把当前令牌换成宿主 API 令牌后，原样转发 JSON 请求（路径、query、body）到宿主 /api/tenant，按宿主响应的状态码与内容返回'
      }
    },
    async (request, reply) => {
      const subjectToken = String(request.headers.authorization || '').replace(/^(bearer|dpop)\s+/i, '');
      const headers = { authorization: `Bearer ${await getHostToken(subjectToken)}` };
      FORWARD_HEADERS.forEach(name => request.headers[name] && (headers[name] = request.headers[name]));
      const url = new URL(`${target}/${request.params['*']}`);
      url.search = new URL(request.raw.url, 'http://localhost').search;
      const hasBody = !['GET', 'HEAD'].includes(request.method) && request.body !== undefined;
      const response = await fetch(url, { method: request.method, headers, body: hasBody ? JSON.stringify(request.body) : undefined });
      reply.code(response.status);
      const contentType = response.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }
      return reply.send(Buffer.from(await response.arrayBuffer()));
    }
  );
});
