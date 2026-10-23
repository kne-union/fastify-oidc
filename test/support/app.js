const net = require('node:net');
const Fastify = require('fastify');
const fakeAccount = require('./fake-account');
const fakeTenant = require('./fake-tenant');
const fakeFileManager = require('./fake-file-manager');
const oidc = require('../../index');

const getFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const addTestRoutes = fastify => {
  const { authenticate } = fastify.oidc;
  fastify.get('/api/me', { onRequest: [authenticate.user] }, async request => ({ user: Object.assign({}, request.user, { payload: undefined }), userInfo: request.userInfo }));
  fastify.get('/api/tenant-me', { onRequest: [authenticate.user, authenticate.tenantUser] }, async request => request.tenantUserInfo);
  fastify.get('/api/need-permission', { onRequest: [authenticate.user, authenticate.permission('order:read')] }, async () => ({ ok: true }));
  fastify.get('/api/admin-only', { onRequest: [authenticate.user, authenticate.admin] }, async () => ({ ok: true }));
  fastify.get('/api/service-only', { onRequest: [authenticate.client('user:read')] }, async request => ({ clientId: request.user.clientId }));
};

/**
 * 启动一个真实监听端口的应用（oidc-provider 的 issuer / 回调地址都需要可访问的 origin）
 */
const createApp = async ({ mode = 'standalone', users = [], memberships, tenant, files, oidc: oidcOptions = {}, intl, port, db, beforeSync, setup } = {}) => {
  port = port || (await getFreePort());
  const origin = `http://127.0.0.1:${port}`;
  const fastify = Fastify({ logger: false });
  if (intl) {
    await fastify.register(require('@kne/fastify-intl'), intl);
  }
  await fastify.register(require('@kne/fastify-sequelize'), { db: db || { dialect: 'sqlite', storage: ':memory:', logging: false } });
  await fastify.register(fakeAccount, { users, getUserAuthenticate: () => fastify.oidc.authenticate.user });
  if (tenant) {
    await fastify.register(tenant.plugin || fakeTenant, tenant.options);
  } else if (memberships) {
    await fastify.register(fakeTenant, { memberships });
  }
  if (files) {
    await fastify.register(fakeFileManager, { files });
  }
  await fastify.register(
    oidc,
    Object.assign(
      {
        mode,
        origin,
        keyEncryptionSecret: 'test-key-secret',
        allowPrivateFetch: true,
        keyReloadInterval: 0,
        cleanupInterval: 0
      },
      typeof oidcOptions === 'function' ? oidcOptions(fastify) : oidcOptions
    )
  );
  addTestRoutes(fastify);
  if (setup) {
    setup(fastify);
  }
  await fastify.ready();
  if (beforeSync) {
    await beforeSync(fastify);
  }
  await fastify.sequelize.sync();
  await fastify.account.seed();
  await fastify.oidc.whenReady();
  await fastify.listen({ port, host: '127.0.0.1' });
  return { fastify, origin, port };
};

module.exports = { createApp, getFreePort };
