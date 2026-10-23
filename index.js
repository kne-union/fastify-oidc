const fp = require('fastify-plugin');
const path = require('node:path');
const { pickBy } = require('lodash');
const resolveOptions = require('./libs/utils/resolve-options');
const createIdp = require('./libs/idp');
const mount = require('./libs/idp/mount');
const createRevocation = require('./libs/resource/revocation');
const createDPoP = require('./libs/resource/dpop');
const createVerifier = require('./libs/resource/verify-token');
const createServiceClient = require('./libs/resource/service-client');
const createUserMirror = require('./libs/resource/user-mirror');
const createAuthenticate = require('./libs/resource/authenticate');
const createTenantSync = require('./libs/resource/tenant-sync');
const createAppRegistry = require('./libs/resource/app-registry');
const createRemoteTenant = require('./libs/resource/remote-tenant');
const { locale, createTranslator } = require('./libs/utils/intl');

const DAY = 24 * 60 * 60;
const INSECURE_SECRET = 'fastify-oidc-insecure-key-secret';

module.exports = fp(
  async (fastify, options) => {
    const env = process.env;
    options = Object.assign(
      {
        name: 'oidc',
        prefix: '/api/oidc',
        dbTableNamePrefix: 't_',
        mode: env.AUTH_MODE || 'standalone',
        isMain: env.OIDC_IS_MAIN === 'true',
        origin: env.ORIGIN,
        issuer: env.OIDC_ISSUER,
        mountPath: '/oidc',
        audience: env.OIDC_AUDIENCE,
        clientId: env.OIDC_CLIENT_ID,
        claimNamespace: null,
        keyEncryptionSecret: env.OIDC_KEY_SECRET,
        cookieSecret: env.OIDC_COOKIE_SECRET,
        trustProxy: true,
        allowPrivateFetch: false,
        adapter: null,
        clockTolerance: 5,
        retiredKeyTTL: 2 * DAY,
        keyReloadInterval: 60,
        cleanupInterval: 60 * 60,
        interactionPage: '/oidc-interaction',
        callbackPath: '/oidc-callback',
        legacyToken: true,
        tenantSource: null,
        tenantUserContextName: 'tenantUserInfo',
        requireDPoP: false,
        includePermissions: false,
        defaultResourceScope: 'api',
        accountNamespace: 'account',
        tenantNamespace: 'tenant',
        intlNamespace: 'intl',
        fileNamespace: 'fileManager',
        clients: [],
        resourceServers: [],
        seedSelf: true,
        selfClient: {},
        serviceScopes: ['user:read', 'tenant:read', 'app:register', 'tenant:sync'],
        userMirrorTTL: 10 * 60,
        tenant: null,
        app: null,
        appPermissionPrefix: 'apps',
        appCenterName: '应用中心',
        appRegisterRetryMax: 5 * 60,
        tenantProxy: false,
        tenantSyncTTL: 10 * 60,
        tenantSyncPageSize: 200,
        tenantSyncDebounce: 1000,
        tenantSyncTimeout: 10 * 1000,
        tenantSyncTokenTTL: 5 * 60,
        revocationStore: null,
        dpopReplayStore: null,
        getAuthenticate: type => {
          const { authenticate } = fastify[options.name];
          if (/:manage$/.test(type)) {
            return [authenticate.user, authenticate.admin];
          }
          return [authenticate.user];
        }
      },
      options
    );
    options.ttl = Object.assign({ accessToken: 10 * 60, idToken: 60 * 60, refreshToken: 14 * DAY, interaction: 10 * 60, session: 14 * DAY, grant: 14 * DAY }, options.ttl);
    options.serviceClient = Object.assign({ clientId: env.OIDC_SERVICE_CLIENT_ID, clientSecret: env.OIDC_SERVICE_CLIENT_SECRET }, options.serviceClient);
    // 代码里的 app 作默认值（如 tenantMode），部署时宿主注入的环境变量优先；最终没有 code 视为未作为子应用部署
    const envApp = pickBy({ code: env.OIDC_APP_CODE, name: env.OIDC_APP_NAME, tenantMode: env.OIDC_APP_TENANT_MODE, tenantSyncUri: env.OIDC_APP_TENANT_SYNC_URI });
    const app = Object.assign({}, options.app, envApp);
    options.app = app.code ? app : null;
    options.runtime = resolveOptions(options);
    const { runtime } = options;
    // 显式传入 tenant（对象或 getter）开启应用中心 / 子应用租户；不传时回退 fastify[tenantNamespace]，保持兼容
    const tenantOption = options.tenant;
    options.getTenant = typeof tenantOption === 'function' ? tenantOption : () => tenantOption || fastify[options.tenantNamespace];

    if (runtime.idpEnabled && !options.keyEncryptionSecret) {
      fastify.log.warn('fastify-oidc: 未配置 keyEncryptionSecret（环境变量 OIDC_KEY_SECRET），正在使用不安全的默认值，生产环境必须配置');
      options.keyEncryptionSecret = INSECURE_SECRET;
    }

    if (!fastify.hasRequestDecorator('user')) {
      fastify.decorateRequest('user', null);
    }

    const translator = createTranslator({ fastify, options });
    const idp = runtime.idpEnabled ? createIdp({ fastify, options, translator }) : null;
    const revocation = createRevocation({ store: options.revocationStore, ttl: Math.max(options.ttl.accessToken, options.ttl.idToken) + options.clockTolerance });
    const verifier = createVerifier({ options, getLocalJWKS: idp ? () => idp.getLocalJWKS() : null });
    const serviceClient = createServiceClient({ options });
    const userMirror = createUserMirror({ fastify, options, serviceClient });
    const dpop = createDPoP({ clockTolerance: options.clockTolerance, replayStore: options.dpopReplayStore });
    const tenantSync = runtime.tenantRole === 'independent' ? createTenantSync({ fastify, options, serviceClient, userMirror }) : null;
    const appRegistry = runtime.app ? createAppRegistry({ fastify, options, serviceClient }) : null;
    const remoteTenant = runtime.tenantRole === 'client' ? createRemoteTenant({ serviceClient }) : null;
    const authenticate = createAuthenticate({ fastify, options, verifier, dpop, revocation, userMirror, serviceClient, tenantSync, translator });

    if (appRegistry) {
      fastify.addHook('onReady', async () => {
        appRegistry.start();
      });
      fastify.addHook('onClose', async () => appRegistry.stop());
    }
    if (tenantSync) {
      fastify.addHook('onClose', async () => tenantSync.close());
    }

    const modules = [];
    if (runtime.idpEnabled) {
      modules.push([
        'models',
        await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
          prefix: options.dbTableNamePrefix,
          modelPrefix: options.name
        })
      ]);
    }

    let readyPromise = Promise.resolve();
    if (idp) {
      readyPromise = fastify.sequelize.syncPromise.then(() => idp.init());
      readyPromise.catch(err => fastify.log.error({ err }, 'fastify-oidc: IdP 初始化失败'));
      fastify.addHook('onClose', async () => idp.close());
      fastify.register(mount, { idp, mountPath: runtime.mountPath, translator });
    }

    fastify.register(require('@kne/fastify-namespace'), {
      options,
      name: options.name,
      modules: [
        ...modules,
        ['locale', locale],
        ['translator', translator],
        ['idp', idp],
        ['revocation', revocation],
        ['verifier', verifier],
        ['serviceClient', serviceClient],
        ['userMirror', userMirror],
        ['tenantSync', tenantSync],
        ['appRegistry', appRegistry],
        ['tenant', remoteTenant],
        ['authenticate', authenticate],
        ['whenReady', () => readyPromise],
        [
          'onPermissionChange',
          async ({ userIds = [], logout = false } = {}) => {
            if (!idp) {
              return;
            }
            await readyPromise;
            for (const userId of userIds) {
              await fastify[options.name].services.grant.revokeByAccount(userId, { logout });
            }
          }
        ],
        ['services', path.resolve(__dirname, './libs/services')],
        ['controllers', path.resolve(__dirname, './libs/controllers')]
      ]
    });
  },
  {
    name: 'fastify-oidc'
  }
);
