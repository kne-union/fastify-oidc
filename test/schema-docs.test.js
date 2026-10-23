const { expect } = require('chai');
const Fastify = require('fastify');
const fakeAccount = require('./support/fake-account');
const fakeTenant = require('./support/fake-tenant');
const fakeManagedTenant = require('./support/fake-managed-tenant');
const oidc = require('../index');

// 原样转发、重定向或交给 oidc-provider 的路由不返回 JSON，不声明 200 响应
const NON_JSON_ROUTES = ['/oidc', '/oidc/*', '/api/oidc/interaction/:uid', '/api/tenant/*'];

const collectRoutes = async ({ tenant, oidc: oidcOptions }) => {
  const routes = [];
  const fastify = Fastify({ logger: false });
  fastify.addHook('onRoute', route => route.method !== 'HEAD' && routes.push(route));
  await fastify.register(require('@kne/fastify-sequelize'), { db: { dialect: 'sqlite', storage: ':memory:', logging: false } });
  await fastify.register(fakeAccount, { users: [], getUserAuthenticate: () => fastify.oidc.authenticate.user });
  if (tenant) {
    await fastify.register(tenant.plugin, tenant.options);
  }
  await fastify.register(oidc, Object.assign({ origin: 'http://127.0.0.1:1', keyEncryptionSecret: 'test-key-secret', keyReloadInterval: 0, cleanupInterval: 0 }, oidcOptions(fastify)));
  await fastify.after();
  return { fastify, routes };
};

describe('@kne/fastify-oidc 接口文档', function () {
  this.timeout(30000);

  it('所有路由都有 tags、summary，参数都有用途说明，JSON 接口声明 200 响应', async () => {
    const central = { mode: 'central', issuer: 'http://127.0.0.1:1/oidc', clientId: 'spa', serviceClient: { clientId: 'svc', clientSecret: 'secret' } };
    const apps = await Promise.all([
      collectRoutes({ tenant: { plugin: fakeTenant, options: { memberships: {} } }, oidc: fastify => ({ isMain: true, tenant: () => fastify.tenant }) }),
      collectRoutes({ oidc: () => Object.assign({}, central, { tenantProxy: true, app: { code: 'crm', tenantMode: 'client' } }) }),
      collectRoutes({ tenant: { plugin: fakeManagedTenant, options: {} }, oidc: fastify => Object.assign({}, central, { tenant: () => fastify.tenant, app: { code: 'erp', tenantMode: 'independent' } }) })
    ]);
    const routes = new Map();
    apps.forEach(app => app.routes.forEach(route => routes.set(`${route.method} ${route.url}`, route)));
    await Promise.all(apps.map(app => app.fastify.close()));

    const missing = [];
    const checkProps = (where, schema) => {
      if (!schema) return;
      [].concat(schema.oneOf || [], schema.anyOf || [], schema).forEach(item => {
        Object.entries(item.properties || {}).forEach(([key, prop]) => {
          if (!prop.description) missing.push(`${where}.${key}`);
          if (prop.type === 'object') checkProps(`${where}.${key}`, prop);
        });
      });
    };
    routes.forEach((route, name) => {
      const { schema = {} } = route;
      if (!(schema.tags && schema.tags.length)) missing.push(`${name} tags`);
      if (!schema.summary) missing.push(`${name} summary`);
      if (!NON_JSON_ROUTES.includes(route.url) && !(schema.response && schema.response[200] && schema.response[200].description)) missing.push(`${name} response`);
      checkProps(`${name} body`, schema.body);
      checkProps(`${name} query`, schema.querystring || schema.query);
      checkProps(`${name} params`, schema.params);
    });
    const urls = new Set([...routes.values()].filter(route => !NON_JSON_ROUTES.includes(route.url)).map(route => `${route.method} ${route.url}`));
    expect(urls.size).to.equal(39);
    expect(missing).to.deep.equal([]);
  });
});
