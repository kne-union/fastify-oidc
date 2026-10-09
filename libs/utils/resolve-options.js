const MODES = ['standalone', 'central'];

const normalizeOrigin = (value, label) => {
  if (!value) {
    throw new Error(`fastify-oidc: 缺少 ${label}`);
  }
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    throw new Error(`fastify-oidc: ${label} 不是合法的 URL: ${value}`);
  }
  return url.origin;
};

const stripTrailingSlash = value => value.replace(/\/+$/, '');

const claimNames = namespace => ({
  tenantId: `${namespace}tenant_id`,
  tenantUserId: `${namespace}tenant_user_id`,
  roles: `${namespace}roles`,
  permissions: `${namespace}permissions`,
  clientToken: `${namespace}client_token`
});

/**
 * 根据 mode / ORIGIN / issuer 推导运行期配置，结果挂在 options 上供各模块读取
 */
module.exports = options => {
  if (!MODES.includes(options.mode)) {
    throw new Error(`fastify-oidc: mode 只能是 ${MODES.join(' / ')}，当前为 ${options.mode}`);
  }
  const idpEnabled = options.mode === 'standalone';
  const origin = normalizeOrigin(options.origin, 'origin（环境变量 ORIGIN）');

  let issuer = options.issuer ? stripTrailingSlash(options.issuer) : null;
  if (!issuer) {
    if (!idpEnabled) {
      throw new Error('fastify-oidc: central 模式必须配置 issuer（环境变量 OIDC_ISSUER），指向主项目的 issuer');
    }
    issuer = `${origin}${options.mountPath}`;
  }
  const issuerUrl = new URL(issuer);
  const mountPath = stripTrailingSlash(issuerUrl.pathname);
  if (idpEnabled && !mountPath) {
    throw new Error('fastify-oidc: issuer 需要包含路径（如 https://example.com/oidc），不能直接挂在根路径');
  }

  const claimNamespace = options.claimNamespace || `${idpEnabled ? origin : issuerUrl.origin}/`;

  return {
    idpEnabled,
    origin,
    issuer,
    issuerOrigin: issuerUrl.origin,
    mountPath,
    serviceAudience: options.serviceAudience || `${issuerUrl.origin}${options.prefix}`,
    idpApiBase: options.idpApiBase || `${issuerUrl.origin}${options.prefix}`,
    audience: options.audience || `${origin}/api`,
    clientId: options.clientId || `${options.name}-spa`,
    claimNamespace,
    claims: claimNames(claimNamespace),
    jwksUri: options.jwksUri || `${issuer}/jwks`
  };
};

module.exports.claimNames = claimNames;
module.exports.normalizeOrigin = normalizeOrigin;
