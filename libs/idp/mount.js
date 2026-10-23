const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];

/**
 * 把 issuer 路径下的请求原样交给 oidc-provider（Koa）处理。
 * 必须以非 fastify-plugin 的方式注册：这里清空了 body 解析器，避免请求体被 fastify 提前读走。
 */
module.exports = async (fastify, { idp, mountPath, translator }) => {
  fastify.removeAllContentTypeParsers();
  fastify.addContentTypeParser('*', (request, payload, done) => done(null));

  const handler = (request, reply) => {
    if (!idp.getProvider()) {
      return translator.t(request, 'providerNotReady').then(message => reply.code(503).send({ message }));
    }
    reply.hijack();
    const req = request.raw;
    req.originalUrl = req.url;
    req.kneOidcLocale = translator.getLocale(request);
    const rest = req.url.slice(mountPath.length);
    req.url = rest.startsWith('/') ? rest : `/${rest}`;
    idp.handle(req, reply.raw);
  };

  const schema = {
    tags: ['OIDC-协议端点'],
    summary: 'OIDC 协议端点（oidc-provider）',
    description:
      '原样交给 oidc-provider 处理的标准端点：/.well-known/openid-configuration、/jwks、/auth、/token、/me、/session/end、/token/introspection、/token/revocation 等，请求与响应格式见 OpenID Connect / OAuth 2.0 规范；provider 未就绪时返回 503'
  };
  fastify.route({ method: METHODS, url: mountPath, schema, handler });
  fastify.route({ method: METHODS, url: `${mountPath}/*`, schema, handler });
};
