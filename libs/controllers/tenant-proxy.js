const fp = require('fastify-plugin');

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

  fastify.get(`${proxy.prefix}/getUserInfo`, { onRequest: [authenticate.user, authenticate.tenantUser] }, async request => {
    const info = request[options.tenantUserContextName];
    return { userInfo: request.userInfo, tenantUserInfo: info, company: info?.tenant?.tenantCompany || info?.tenant?.company || null, tenant: info?.tenant || null };
  });

  fastify.get(`${proxy.prefix}/available-list`, { onRequest: [authenticate.user] }, async request => toTenantList(await serviceClient.getTenantList({ userId: request.user.userId })));

  fastify.all(`${proxy.prefix}/*`, { onRequest: [authenticate.user] }, async (request, reply) => {
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
  });
});
