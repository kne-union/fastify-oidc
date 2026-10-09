const { createLocalJWKSet } = require('jose');
const createIdentity = require('./identity');
const createProvider = require('./create-provider');
const createSequelizeAdapter = require('./adapters/sequelize');

/**
 * IdP 运行期：持有当前 oidc-provider 实例，负责初始化、密钥轮换后的热替换和定时清理
 */
module.exports = ({ fastify, options, translator }) => {
  const identity = createIdentity({ fastify, options });
  const timers = [];
  let PayloadAdapter;
  let state = null;

  const getServices = () => fastify[options.name].services;

  const assertReady = () => {
    if (!state) {
      throw new Error('fastify-oidc: IdP 尚未初始化完成');
    }
    return state;
  };

  const build = async () => {
    const services = getServices();
    const jwks = await services.key.getPrivateJwks();
    const publicJwks = await services.key.getPublicJwks();
    const fingerprint = await services.key.fingerprint();
    const localJWKS = createLocalJWKSet(publicJwks);
    const result = await createProvider({
      fastify,
      options,
      identity,
      translator,
      jwks,
      PayloadAdapter,
      getLocalJWKS: () => assertReady().localJWKS
    });
    state = Object.assign(result, { callback: result.provider.callback(), localJWKS, publicJwks, fingerprint });
  };

  const seed = async () => {
    const services = getServices();
    const { runtime } = options;
    const resourceServers = [...(options.resourceServers || [])];
    const clients = [...(options.clients || [])];
    if (options.seedSelf) {
      resourceServers.push({ identifier: runtime.audience, name: options.name });
      resourceServers.push({ identifier: runtime.serviceAudience, name: 'OIDC 服务接口', scope: options.serviceScopes.join(' ') });
      clients.push(
        Object.assign(
          {
            clientId: runtime.clientId,
            clientName: options.name,
            redirect_uris: [`${runtime.origin}${options.callbackPath}`],
            post_logout_redirect_uris: [`${runtime.origin}/`],
            token_endpoint_auth_method: 'none',
            allowedResources: [runtime.audience]
          },
          options.selfClient
        )
      );
    }
    await services.resourceServer.seed(resourceServers);
    await services.client.seed(clients);
  };

  const reloadIfKeysChanged = async () => {
    try {
      if (state && (await getServices().key.fingerprint()) !== state.fingerprint) {
        await build();
      }
    } catch (e) {
      fastify.log.warn({ err: e }, 'fastify-oidc: 检查密钥变更失败');
    }
  };

  const cleanup = async () => {
    try {
      const { models } = fastify[options.name];
      const { Op } = fastify.sequelize.Sequelize;
      if (!options.adapter) {
        await models.payload.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
      }
      await models.sessionTenant.destroy({ where: { updatedAt: { [Op.lt]: new Date(Date.now() - options.ttl.session * 1000) } } });
      await getServices().key.pruneRetired();
    } catch (e) {
      fastify.log.warn({ err: e }, 'fastify-oidc: 定时清理失败');
    }
  };

  const schedule = (fn, seconds) => {
    if (!seconds) {
      return;
    }
    const timer = setInterval(fn, seconds * 1000);
    timer.unref();
    timers.push(timer);
  };

  const init = async () => {
    PayloadAdapter = options.adapter || createSequelizeAdapter({ models: fastify[options.name].models });
    await getServices().key.ensureKeys();
    await seed();
    await build();
    schedule(reloadIfKeysChanged, options.keyReloadInterval);
    schedule(cleanup, options.cleanupInterval);
  };

  const close = () => timers.forEach(clearInterval);

  return {
    identity,
    init,
    close,
    reload: build,
    getProvider: () => state && state.provider,
    getAdapter: name => assertReady().getAdapter(name),
    getLocalJWKS: () => state && state.localJWKS,
    getPublicJwks: () => state && state.publicJwks,
    handle: (req, res) => assertReady().callback(req, res)
  };
};
