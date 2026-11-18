const { expect } = require('chai');
const { createApp, getFreePort } = require('./support/app');
const { createBrowser, discover, login, getJson } = require('./support/http');
const fakeManagedTenant = require('./support/fake-managed-tenant');

const USERS = [{ id: '3001', nickname: '赵六', email: 'zhaoliu@test.com', password: 'pwd' }];

const waitFor = async (check, timeout = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await check();
    if (value) {
      return value;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('等待超时');
};

describe('@kne/fastify-oidc standalone 应用配对主平台', function () {
  this.timeout(30000);
  let host, lms, hostOrigin, lmsOrigin, resource, as;

  const loginToHost = (tenantId = 'tenant-a') => {
    const browser = createBrowser();
    return login({
      as,
      browser,
      clientId: 'lms-spa',
      redirectUri: `${lmsOrigin}/oidc-callback`,
      resource,
      onInteraction: async uid => {
        const base = `${hostOrigin}/api/oidc/interaction/${uid}`;
        const details = await (await browser.request(`${base}/details`)).json();
        if (details.prompt.name === 'tenant') {
          return (await browser.json(`${base}/tenant`, { tenantId })).redirectTo;
        }
        return (await browser.json(`${base}/login`, { email: 'zhaoliu@test.com', password: 'pwd' })).redirectTo;
      }
    });
  };

  before(async () => {
    const [hostPort, lmsPort] = [await getFreePort(), await getFreePort()];
    hostOrigin = `http://127.0.0.1:${hostPort}`;
    lmsOrigin = `http://127.0.0.1:${lmsPort}`;
    // 应用中心关联的外部应用：资源标识在宿主下，权限树由宿主其他来源挂在顶层 lms 下
    resource = `${hostOrigin}/app/lms/api`;

    host = await createApp({
      port: hostPort,
      users: USERS,
      tenant: {
        options: {
          memberships: {
            3001: [
              { id: 'tu-a', tenantId: 'tenant-a', name: '租户 A', roles: ['admin'], permissions: ['lms', 'lms:course', 'lms:course:view'] },
              { id: 'tu-b', tenantId: 'tenant-b', name: '租户 B', roles: ['admin'], permissions: [] }
            ]
          },
          tenantPermissions: { 'tenant-a': ['lms', 'lms:course', 'lms:course:view'], 'tenant-b': [] },
          roles: { 'tenant-a': [{ id: 'role-admin', code: 'admin', name: '管理员', type: 'system', status: 'open', permissions: ['lms:course:view'] }] }
        }
      },
      oidc: fastify => ({
        isMain: true,
        tenant: () => fastify.tenant,
        tenantSyncDebounce: 50,
        resourceServers: [{ identifier: resource, name: 'LMS API', includePermissions: true }],
        clients: [
          { clientId: 'lms-spa', redirect_uris: [`${lmsOrigin}/oidc-callback`], allowedResources: [resource] },
          {
            clientId: 'lms-service',
            clientSecret: 'lms-service-secret',
            grant_types: ['client_credentials'],
            response_types: [],
            token_endpoint_auth_method: 'client_secret_basic',
            allowedResources: [`${hostOrigin}/api/oidc`]
          }
        ]
      })
    });

    lms = await createApp({
      port: lmsPort,
      tenant: { plugin: fakeManagedTenant },
      oidc: fastify => ({ tenant: () => fastify.tenant, userMirrorTTL: 0, tenantSyncTTL: 1 }),
      setup: fastify => {
        const { authenticate } = fastify.oidc;
        fastify.get('/api/lms/whoami', { onRequest: [authenticate.user, authenticate.tenantUser] }, async request => ({
          user: Object.assign({}, request.user, { payload: undefined }),
          authenticatePayload: request.authenticatePayload,
          userInfo: request.userInfo,
          tenantUserInfo: request.tenantUserInfo
        }));
      }
    });

    await host.fastify.oidc.services.app.register({
      serviceClientId: 'lms-service',
      code: 'lms',
      name: 'LMS',
      tenantMode: 'independent',
      clientId: 'lms-spa',
      resource,
      permissionRoot: true,
      tenantSyncUri: `${lmsOrigin}/api/oidc/tenant-sync`
    });
    lms.fastify.oidc.platforms.upsert({
      platformOrigin: hostOrigin,
      issuer: `${hostOrigin}/oidc`,
      audience: resource,
      spaClientId: 'lms-spa',
      serviceClientId: 'lms-service',
      serviceClientSecret: 'lms-service-secret',
      status: 'paired'
    });
    as = await discover(`${hostOrigin}/oidc`);
  });

  after(async () => {
    await lms.fastify.close();
    await host.fastify.close();
  });

  it('宿主按顶层权限码判断开通，不再重复挂 apps:<code> 权限树', async () => {
    const { identity } = host.fastify.oidc.idp;
    expect(await identity.isAppEnabled('tenant-a', 'lms')).to.equal(true);
    expect(await identity.isAppEnabled('tenant-b', 'lms')).to.equal(false);
    expect(identity.scopePermissions(['lms:course:view', 'apps:lms:x', 'other'], 'lms')).to.deep.equal(['course:view']);
    const appsModule = host.fastify.tenant.permissions.modules.find(module => module.code === 'apps');
    expect((appsModule?.modules || []).map(module => module.code)).to.not.include('apps:lms');
  });

  it('配对平台的密钥等内部字段不出现在公开配置里', async () => {
    const config = await (await fetch(`${lmsOrigin}/api/oidc/config?iss=${encodeURIComponent(`${hostOrigin}/oidc`)}`)).json();
    expect(config.issuer).to.equal(`${hostOrigin}/oidc`);
    expect(config.clientId).to.equal('lms-spa');
    expect(config.audience).to.equal(resource);
    expect(JSON.stringify(config)).to.not.include('lms-service-secret');
    const local = await (await fetch(`${lmsOrigin}/api/oidc/config`)).json();
    expect(local.issuer).to.equal(`${lmsOrigin}/oidc`);
  });

  it('宿主用户访问：用户镜像到本地，宿主租户同步为本地托管租户', async () => {
    const { access_token: token } = await loginToHost();
    const { status, body } = await getJson(`${lmsOrigin}/api/lms/whoami`, token);
    expect(status).to.equal(200);
    expect(body.user.userId).to.equal('3001');
    expect(body.user.platformIssuer).to.equal(`${hostOrigin}/oidc`);
    expect(body.user.hostTenantId).to.equal('tenant-a');
    expect(body.user.tenantId).to.match(/^local-/);
    expect(body.authenticatePayload).to.deep.equal({ id: '3001', tenantId: body.user.tenantId });
    expect(body.userInfo.nickname).to.equal('赵六');
    expect(body.tenantUserInfo.tenantId).to.equal(body.user.tenantId);
    expect(body.tenantUserInfo.permissions).to.include('course:view');
    const tenant = lms.fastify.tenant.tenants.get(body.user.tenantId);
    expect(tenant.options.managedBy).to.include({ issuer: `${hostOrigin}/oidc`, hostTenantId: 'tenant-a' });
    const mirrored = await lms.fastify.account.models.user.findByPk('3001');
    expect(mirrored.nickname).to.equal('赵六');
  });

  it('宿主推送租户变更通知，standalone 应用按平台验签后回拉', async () => {
    const before = lms.fastify.tenant.snapshots.length;
    await host.fastify.oidc.services.tenantPush.push('tenant-a');
    await waitFor(() => lms.fastify.tenant.snapshots.length > before);

    const response = await fetch(`${lmsOrigin}/api/oidc/tenant-sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_sync_token: 'invalid' })
    });
    expect(response.status).to.equal(400);
  });

  it('平台解除配对后拒绝该平台签发的令牌', async () => {
    const { access_token: token } = await loginToHost();
    lms.fastify.oidc.platforms.remove(hostOrigin);
    try {
      const { status } = await getJson(`${lmsOrigin}/api/lms/whoami`, token);
      expect(status).to.equal(401);
    } finally {
      lms.fastify.oidc.platforms.upsert({ platformOrigin: hostOrigin, issuer: `${hostOrigin}/oidc`, audience: resource, spaClientId: 'lms-spa', serviceClientId: 'lms-service', serviceClientSecret: 'lms-service-secret', status: 'paired' });
    }
  });
});
