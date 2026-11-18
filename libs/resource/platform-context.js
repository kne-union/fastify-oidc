const createServiceClient = require('./service-client');
const createUserMirror = require('./user-mirror');
const createTenantSync = require('./tenant-sync');
const { claimNames } = require('../utils/resolve-options');

/**
 * standalone 应用与主平台配对后，同时服务平台的用户与租户：
 * 平台用户镜像到本地用户表，平台租户同步为本地只读托管租户（managedBy.issuer = 平台 issuer），
 * 相当于对每个已配对平台各跑一套 central + independent。本地 IdP 的用户与自建租户不受影响。
 */
module.exports = ({ fastify, options, platforms }) => {
  const contexts = new Map();

  // 未登记 appCode 时从应用中心的资源标识（{平台}/app/{code}/api）推导
  const appCodeOf = platform => platform.appCode || (String(platform.audience || '').match(/\/app\/([A-Za-z0-9_-]+)\/api$/) || [])[1] || null;

  const signatureOf = platform => JSON.stringify([platform.issuer, platform.serviceClientId, platform.serviceClientSecret, platform.apiBase, platform.serviceAudience, platform.claimNamespace, appCodeOf(platform)]);

  const build = platform => {
    const issuerOrigin = new URL(platform.issuer).origin;
    const apiBase = platform.apiBase || `${issuerOrigin}${options.prefix}`;
    const claimNamespace = platform.claimNamespace || `${issuerOrigin}/`;
    const appCode = appCodeOf(platform);
    const runtime = Object.assign({}, options.runtime, {
      issuer: platform.issuer,
      issuerOrigin,
      idpApiBase: apiBase,
      serviceAudience: platform.serviceAudience || apiBase,
      claimNamespace,
      claims: claimNames(claimNamespace),
      app: appCode ? { code: appCode, tenantMode: 'independent' } : null,
      tenantRole: 'independent'
    });
    const platformOptions = Object.assign({}, options, {
      runtime,
      serviceClient: { clientId: platform.serviceClientId, clientSecret: platform.serviceClientSecret },
      // 本地有自己的超级管理员，平台超级管理员身份不带进来
      mirrorSuperAdmin: false
    });
    const serviceClient = createServiceClient({ options: platformOptions });
    const userMirror = createUserMirror({ fastify, options: platformOptions, serviceClient });
    const managed = options.getTenant()?.services?.managed;
    const tenantSync = appCode && managed ? createTenantSync({ fastify, options: platformOptions, serviceClient, userMirror }) : null;
    return { platform, issuer: platform.issuer, claims: runtime.claims, serviceClient, userMirror, tenantSync };
  };

  /** 令牌 iss 命中已配对平台时返回该平台的上下文，平台信息变化（如重新配对换了密钥）后重建 */
  const forIssuer = issuer => {
    const platform = issuer ? platforms.findByIssuer(issuer) : null;
    if (!platform || platform.status !== 'paired') {
      return null;
    }
    const signature = signatureOf(platform);
    const cached = contexts.get(platform.issuer);
    if (cached && cached.signature === signature) {
      return cached.context;
    }
    const context = build(platform);
    contexts.set(platform.issuer, { signature, context });
    return context;
  };

  const close = () => Promise.allSettled([...contexts.values()].map(({ context }) => context.tenantSync?.close()));

  return { forIssuer, close };
};
