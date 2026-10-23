const { expect } = require('chai');
const { createApp, getFreePort } = require('./support/app');
const { createBrowser, discover, login, getJson, decodeJwt } = require('./support/http');
const fakeManagedTenant = require('./support/fake-managed-tenant');
const { GRANT_TYPE: TOKEN_EXCHANGE } = require('../libs/idp/grants/token-exchange');

const USERS = [{ id: '3001', nickname: '赵六', email: 'zhaoliu@test.com', password: 'pwd' }];

const CRM_PERMISSIONS = { modules: [{ code: 'order', name: '订单', permissions: [{ code: 'view', name: '查看' }] }] };
const ERP_PERMISSIONS = { modules: [{ code: 'stock', name: '库存', permissions: [{ code: 'view', name: '查看' }] }] };

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

describe('@kne/fastify-oidc 应用中心与子应用租户', function () {
  this.timeout(30000);
  let host, crm, erp, hostOrigin, crmOrigin, erpOrigin, as;

  const tenantPermissions = {
    'tenant-a': ['order:read', 'apps', 'apps:crm', 'apps:crm:order', 'apps:crm:order:view', 'apps:erp', 'apps:erp:stock', 'apps:erp:stock:view'],
    'tenant-b': ['order:read']
  };

  const loginTo = ({ clientId, origin, tenantId = 'tenant-a' }) => {
    const browser = createBrowser();
    return login({
      as,
      browser,
      clientId,
      redirectUri: `${origin}/oidc-callback`,
      resource: `${origin}/api`,
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
    const [hostPort, crmPort, erpPort] = [await getFreePort(), await getFreePort(), await getFreePort()];
    hostOrigin = `http://127.0.0.1:${hostPort}`;
    crmOrigin = `http://127.0.0.1:${crmPort}`;
    erpOrigin = `http://127.0.0.1:${erpPort}`;
    const serviceClient = (clientId, origin) => ({
      clientId,
      clientSecret: `${clientId}-secret`,
      grant_types: ['client_credentials', TOKEN_EXCHANGE],
      response_types: [],
      token_endpoint_auth_method: 'client_secret_basic',
      allowedResources: [`${hostOrigin}/api/oidc`, `${hostOrigin}/api`, `${origin}/api`]
    });
    const spa = (clientId, origin) => ({ clientId, redirect_uris: [`${origin}/oidc-callback`], allowedResources: [`${origin}/api`] });

    host = await createApp({
      port: hostPort,
      users: USERS,
      files: [
        { id: 'h-logo', filename: 'logo.png', content: 'tenant-logo' },
        { id: 'h-company-logo', filename: 'company.png', content: 'company-logo' },
        { id: 'h-banner', filename: 'banner.png', content: 'banner' },
        { id: 'h-member-avatar', filename: 'member.png', content: 'member-avatar' }
      ],
      tenant: {
        options: {
          profiles: {
            'tenant-a': {
              logo: 'h-logo',
              company: { name: '租户 A 公司', fullName: '租户 A 有限公司', logo: 'h-company-logo', banners: ['h-banner', 'h-missing'], teamDescription: [{ name: '甲', avatar: 'h-member-avatar' }] }
            }
          },
          memberships: {
            3001: [
              { id: 'tu-a', tenantId: 'tenant-a', name: '租户 A', avatar: 'h-member-avatar', roles: ['admin'], orgIds: ['org-sales'], permissions: ['order:read', 'apps:crm', 'apps:crm:order:view', 'apps:erp', 'apps:erp:stock:view'] },
              { id: 'tu-b', tenantId: 'tenant-b', name: '租户 B', roles: ['admin'], permissions: ['order:read'] }
            ]
          },
          tenantPermissions,
          roles: { 'tenant-a': [{ id: 'role-admin', code: 'admin', name: '管理员', type: 'system', status: 'open', permissions: ['order:read', 'apps:crm:order:view', 'apps:erp:stock:view'] }] },
          orgs: {
            'tenant-a': [
              { id: 'org-sales', parentId: 'org-root', name: '销售部', index: 1, status: 'open', leaderUserId: 'tu-a' },
              { id: 'org-root', parentId: null, name: '总部', index: 0, status: 'open' }
            ]
          }
        }
      },
      oidc: fastify => ({
        isMain: true,
        tenant: () => fastify.tenant,
        tenantSyncDebounce: 50,
        resourceServers: [
          { identifier: `${crmOrigin}/api`, name: 'CRM API', includePermissions: true },
          { identifier: `${erpOrigin}/api`, name: 'ERP API', includePermissions: true }
        ],
        clients: [spa('host-spa', hostOrigin), spa('crm-spa', crmOrigin), serviceClient('crm-service', crmOrigin), spa('erp-spa', erpOrigin), serviceClient('erp-service', erpOrigin)]
      }),
      setup: fastify => {
        const { authenticate } = fastify.oidc;
        fastify.get('/api/tenant/echo', { onRequest: [authenticate.user, authenticate.tenantUser] }, async request => ({
          userId: request.user.userId,
          tenantId: request.user.tenantId,
          query: request.query
        }));
      }
    });

    crm = await createApp({
      port: crmPort,
      mode: 'central',
      oidc: {
        issuer: `${hostOrigin}/oidc`,
        clientId: 'crm-spa',
        serviceClient: { clientId: 'crm-service', clientSecret: 'crm-service-secret' },
        userMirrorTTL: 0,
        tenantProxy: true,
        app: { code: 'crm', name: 'CRM', tenantMode: 'client', permissions: CRM_PERMISSIONS }
      },
      setup: fastify => {
        const { authenticate } = fastify.oidc;
        fastify.get('/api/crm-order', { onRequest: [authenticate.user, authenticate.permission('order:view')] }, async () => ({ ok: true }));
      }
    });

    // 托管平台注入 code / name / 通知地址，代码里只声明 tenantMode
    const appEnv = { OIDC_APP_CODE: 'erp', OIDC_APP_NAME: 'ERP', OIDC_APP_TENANT_SYNC_URI: `${erpOrigin}/api/oidc/tenant-sync` };
    Object.assign(process.env, appEnv);
    try {
      erp = await createApp({
        port: erpPort,
        mode: 'central',
        tenant: { plugin: fakeManagedTenant, options: { permissions: ERP_PERMISSIONS } },
        files: [],
        oidc: fastify => ({
          issuer: `${hostOrigin}/oidc`,
          clientId: 'erp-spa',
          serviceClient: { clientId: 'erp-service', clientSecret: 'erp-service-secret' },
          userMirrorTTL: 0,
          tenantSyncTTL: 1,
          tenant: () => fastify.tenant,
          app: { tenantMode: 'independent' }
        })
      });
    } finally {
      Object.keys(appEnv).forEach(key => delete process.env[key]);
    }

    await crm.fastify.oidc.appRegistry.whenStarted();
    await erp.fastify.oidc.appRegistry.whenStarted();
    as = await discover(`${hostOrigin}/oidc`);
  });

  after(async () => {
    await erp.fastify.close();
    await crm.fastify.close();
    await host.fastify.close();
  });

  const hostApps = () => host.fastify.tenant.permissions.modules.find(module => module.code === 'apps');

  it('should register sub app permissions under 应用中心 and keep them disabled by default', async () => {
    expect(crm.fastify.oidc.appRegistry.getState().registered).to.equal(true);
    const apps = hostApps();
    expect(apps.name).to.equal('应用中心');
    expect(apps.modules.map(module => module.code).sort()).to.deep.equal(['crm', 'erp']);
    expect(apps.modules.find(module => module.code === 'crm').modules).to.deep.equal(CRM_PERMISSIONS.modules);
    expect(host.fastify.tenant.sources.get('oidc-app:crm').defaultDisabled).to.equal(true);

    const { pageData } = await host.fastify.oidc.services.app.list();
    const crmApp = pageData.find(item => item.code === 'crm');
    expect(crmApp).to.include({ tenantMode: 'client', serviceClientId: 'crm-service', resource: `${crmOrigin}/api`, permissionCount: 1 });
    expect(crmApp.clientIds).to.deep.equal(['crm-spa']);
    expect(pageData.find(item => item.code === 'erp').tenantSyncUri).to.equal(`${erpOrigin}/api/oidc/tenant-sync`);

    const again = await crm.fastify.oidc.appRegistry.register();
    expect(again.changed).to.equal(false);
  });

  it('should not allow another client to take over an app code', async () => {
    const error = await erp.fastify.oidc.serviceClient.callService('/service/app/register', { method: 'POST', body: { code: 'crm' }, scope: 'app:register' }).catch(e => e);
    expect(error.upstreamStatus).to.equal(403);
    const mismatch = await erp.fastify.oidc.serviceClient.callService('/service/tenant-snapshot', { query: { tenantId: 'tenant-a', app: 'crm' }, scope: 'tenant:sync' }).catch(e => e);
    expect(mismatch.upstreamStatus).to.equal(403);
  });

  it('client mode: only tenants that enabled the app are available and permissions are unprefixed', async () => {
    const tokens = await loginTo({ clientId: 'crm-spa', origin: crmOrigin });
    const claims = decodeJwt(tokens.access_token);
    expect(claims[`${hostOrigin}/tenant_id`]).to.equal('tenant-a');
    expect(claims[`${hostOrigin}/permissions`]).to.deep.equal(['order:view']);

    const tenantMe = await getJson(`${crmOrigin}/api/tenant-me`, tokens.access_token);
    expect(tenantMe.body.tenantId).to.equal('tenant-a');
    expect(tenantMe.body.permissions).to.deep.equal(['order:view']);
    expect((await getJson(`${crmOrigin}/api/crm-order`, tokens.access_token)).status).to.equal(200);

    const { list } = await crm.fastify.oidc.tenant.tenantList({ userId: '3001' });
    expect(list.map(item => item.tenantId)).to.deep.equal(['tenant-a']);

    const available = await getJson(`${crmOrigin}/api/tenant/available-list`, tokens.access_token);
    expect(available.body.list.map(item => item.tenantId)).to.deep.equal(['tenant-a']);
    expect(available.body.defaultTenantId).to.equal('tenant-a');
    const userInfo = await getJson(`${crmOrigin}/api/tenant/getUserInfo`, tokens.access_token);
    expect(userInfo.body.tenantUserInfo.permissions).to.deep.equal(['order:view']);
    expect(userInfo.body.tenant.id).to.equal('tenant-a');

    const echo = await getJson(`${crmOrigin}/api/tenant/echo?x=1`, tokens.access_token);
    expect(echo.status).to.equal(200);
    expect(echo.body).to.deep.equal({ userId: '3001', tenantId: 'tenant-a', query: { x: '1' } });

    this.crmTokens = tokens;
  });

  it('client mode: disabling the app for a tenant removes access', async () => {
    const original = tenantPermissions['tenant-a'];
    tenantPermissions['tenant-a'] = original.filter(code => !code.startsWith('apps:crm'));
    try {
      const tenantMe = await getJson(`${crmOrigin}/api/tenant-me`, this.crmTokens.access_token);
      expect(tenantMe.status).to.not.equal(200);
      const { list } = await crm.fastify.oidc.tenant.tenantList({ userId: '3001' });
      expect(list).to.deep.equal([]);
    } finally {
      tenantPermissions['tenant-a'] = original;
    }
  });

  it('independent mode: host pushes tenant change and sub app takes over tenant, roles, orgs and members', async () => {
    await host.fastify.tenant.services.permission.save({ tenantId: 'tenant-a', permissions: tenantPermissions['tenant-a'] });
    const local = await waitFor(() => [...erp.fastify.tenant.tenants.values()].find(tenant => tenant.options.managedBy.hostTenantId === 'tenant-a'));
    await erp.fastify.oidc.tenantSync.whenIdle('tenant-a');
    expect(local).to.include({ name: '租户 A', status: 'open' });
    expect(local.options.managedBy.issuer).to.equal(`${hostOrigin}/oidc`);
    expect(local.permissions).to.deep.equal(['stock', 'stock:view']);
    expect(local.roles).to.deep.equal([{ id: 'role-admin', code: 'admin', name: '管理员', type: 'system', status: 'open', permissions: ['stock:view'] }]);
    expect(local.orgs.map(org => [org.id, org.parentId, org.leaderTenantUserId])).to.deep.equal([
      ['org-sales', 'org-root', 'tu-a'],
      ['org-root', null, null]
    ]);
    expect(local.members).to.have.length(1);
    expect(local.members[0]).to.include({ id: 'tu-a', userId: '3001', status: 'open' });
    expect(local.members[0].roleCodes).to.deep.equal(['admin']);
    expect(local.members[0].tenantOrgIds).to.deep.equal(['org-sales']);
    expect((await erp.fastify.account.models.user.findByPk('3001')).nickname).to.equal('赵六');
  });

  it('independent mode: tenant logo, company images and member avatars are copied into the local file store', async () => {
    const local = [...erp.fastify.tenant.tenants.values()].find(tenant => tenant.options.managedBy.hostTenantId === 'tenant-a');
    const { records, stats } = erp.fastify.fileManager;
    const contentOf = id => records.get(id)?.content.toString();
    const { files } = local.options.managedBy;
    expect(Object.keys(files).sort()).to.deep.equal(['h-banner', 'h-company-logo', 'h-logo', 'h-member-avatar']);
    expect(contentOf(local.logo)).to.equal('tenant-logo');
    expect(local.company).to.include({ name: '租户 A 公司', fullName: '租户 A 有限公司' });
    expect(contentOf(local.company.logo)).to.equal('company-logo');
    expect(local.company.banners.map(contentOf)).to.deep.equal(['banner', undefined]);
    expect(local.company.banners[1]).to.equal(null);
    expect(contentOf(local.company.teamDescription[0].avatar)).to.equal('member-avatar');
    expect(local.members[0].avatar).to.equal(files['h-member-avatar']);

    const uploads = stats.uploads;
    await erp.fastify.oidc.tenantSync.sync('tenant-a');
    expect(stats.uploads).to.equal(uploads);
    expect(local.logo).to.equal(files['h-logo']);

    records.get(files['h-logo']).lost = true;
    await erp.fastify.oidc.tenantSync.sync('tenant-a');
    expect(stats.uploads).to.equal(uploads + 1);
    const refreshed = [...erp.fastify.tenant.tenants.values()].find(tenant => tenant.options.managedBy.hostTenantId === 'tenant-a');
    expect(refreshed.options.managedBy.files['h-logo']).to.not.equal(files['h-logo']);
    expect(contentOf(refreshed.logo)).to.equal('tenant-logo');
  });

  it('independent mode: rejects forged, foreign and replayed notifications', async () => {
    const { tenantPush } = host.fastify.oidc.services;
    const post = token => fetch(`${erpOrigin}/api/oidc/tenant-sync`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenant_sync_token: token }) });

    const token = await tenantPush.signToken({ app: { serviceClientId: 'erp-service' }, tenantId: 'tenant-a' });
    expect((await post(token)).status).to.equal(200);
    expect((await post(token)).status).to.equal(400);
    expect((await post(await tenantPush.signToken({ app: { serviceClientId: 'crm-service' }, tenantId: 'tenant-a' }))).status).to.equal(400);
    expect((await post(`${token.slice(0, -4)}AAAA`)).status).to.equal(400);
    await erp.fastify.oidc.tenantSync.whenIdle('tenant-a');
  });

  it('independent mode: login uses the local managed tenant and pulls tenants that enable the app later', async () => {
    const tokens = await loginTo({ clientId: 'erp-spa', origin: erpOrigin });
    expect(decodeJwt(tokens.access_token)[`${hostOrigin}/permissions`]).to.deep.equal(['stock:view']);
    const tenantMe = await getJson(`${erpOrigin}/api/tenant-me`, tokens.access_token);
    expect(tenantMe.status).to.equal(200);
    const local = [...erp.fastify.tenant.tenants.values()].find(tenant => tenant.options.managedBy.hostTenantId === 'tenant-a');
    expect(tenantMe.body.tenantId).to.equal(local.id);
    expect(tenantMe.body.permissions).to.deep.equal(['stock:view']);

    const { tenantSync } = erp.fastify.oidc;
    expect(await tenantSync.ensureFresh('tenant-b')).to.equal(null);
    host.fastify.oidc.services.tenantPush.stop();
    tenantPermissions['tenant-b'] = ['order:read', 'apps:erp', 'apps:erp:stock', 'apps:erp:stock:view'];
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(await tenantSync.ensureFresh('tenant-b')).to.equal(null);
    await tenantSync.whenIdle('tenant-b');
    const pulled = await tenantSync.ensureFresh('tenant-b');
    expect(pulled).to.be.a('string');
    expect(erp.fastify.tenant.tenants.get(pulled).name).to.equal('租户 B');
  });

  it('independent mode: disabling the app on host closes the managed tenant on next sync', async () => {
    const { pageData } = await host.fastify.oidc.services.app.list();
    const erpApp = pageData.find(item => item.code === 'erp');
    await host.fastify.oidc.services.app.setStatus({ id: erpApp.id, status: 'closed' });
    expect(hostApps().modules.map(module => module.code)).to.deep.equal(['crm']);

    const local = await erp.fastify.oidc.tenantSync.sync('tenant-a');
    expect(local.status).to.equal('closed');
    await host.fastify.oidc.services.app.setStatus({ id: erpApp.id, status: 'open' });
    expect(
      hostApps()
        .modules.map(module => module.code)
        .sort()
    ).to.deep.equal(['crm', 'erp']);
  });

  const findApp = async code => (await host.fastify.oidc.services.app.list()).pageData.find(item => item.code === code);
  const localOf = hostTenantId => [...erp.fastify.tenant.tenants.values()].find(tenant => tenant.options.managedBy.hostTenantId === hostTenantId);
  const settlePush = async () => {
    await host.fastify.oidc.services.tenantPush.whenIdle();
    await Promise.all(['tenant-a', 'tenant-b'].map(id => erp.fastify.oidc.tenantSync.whenIdle(id)));
  };

  it('host tenant portal lists open apps enabled for the current tenant', async () => {
    const { access_token } = await loginTo({ clientId: 'host-spa', origin: hostOrigin });
    const codesOf = async (token = access_token) => {
      const { status, body } = await getJson(`${hostOrigin}/api/oidc/tenant/apps`, token);
      expect(status).to.equal(200);
      return body.map(item => item.code).sort();
    };
    expect(await codesOf()).to.deep.equal(['crm', 'erp']);

    const original = tenantPermissions['tenant-a'];
    tenantPermissions['tenant-a'] = original.filter(code => !code.startsWith('apps:erp'));
    try {
      expect(await codesOf()).to.deep.equal(['crm']);
    } finally {
      tenantPermissions['tenant-a'] = original;
    }

    const crmApp = await findApp('crm');
    await host.fastify.oidc.services.app.setStatus({ id: crmApp.id, status: 'closed' });
    try {
      expect(await codesOf()).to.deep.equal(['erp']);
    } finally {
      await host.fastify.oidc.services.app.setStatus({ id: crmApp.id, status: 'open' });
    }
    expect(await codesOf((await loginTo({ clientId: 'host-spa', origin: hostOrigin, tenantId: 'tenant-b' })).access_token)).to.deep.equal(['erp']);
    expect((await getJson(`${hostOrigin}/api/oidc/tenant/apps`)).status).to.equal(401);
  });

  it('client mode: a closed app gives its clients no tenant and no host permissions', async () => {
    const crmApp = await findApp('crm');
    await host.fastify.oidc.services.app.setStatus({ id: crmApp.id, status: 'closed' });
    try {
      const claims = decodeJwt((await loginTo({ clientId: 'crm-spa', origin: crmOrigin })).access_token);
      expect(claims).to.not.have.property(`${hostOrigin}/tenant_id`);
      expect(claims).to.not.have.property(`${hostOrigin}/permissions`);
      const { list } = await crm.fastify.oidc.tenant.tenantList({ userId: '3001' });
      expect(list).to.deep.equal([]);
    } finally {
      await host.fastify.oidc.services.app.setStatus({ id: crmApp.id, status: 'open' });
    }
    const claims = decodeJwt((await loginTo({ clientId: 'crm-spa', origin: crmOrigin })).access_token);
    expect(claims[`${hostOrigin}/tenant_id`]).to.equal('tenant-a');
  });

  it('independent mode: app status changes are pushed and close / reopen managed tenants without manual sync', async () => {
    const erpApp = await findApp('erp');
    await host.fastify.oidc.services.app.setStatus({ id: erpApp.id, status: 'closed' });
    await settlePush();
    expect(localOf('tenant-a').status).to.equal('closed');

    await host.fastify.oidc.services.app.setStatus({ id: erpApp.id, status: 'open' });
    await settlePush();
    expect(localOf('tenant-a').status).to.equal('open');
  });

  it('removed app is hidden, closes managed tenants and is revived by re-register', async () => {
    const { app } = host.fastify.oidc.services;
    const erpApp = await findApp('erp');
    await app.remove({ id: erpApp.id });
    await settlePush();
    expect(await findApp('erp')).to.equal(undefined);
    expect((await app.list({ filter: { status: 'removed' } })).pageData.map(item => item.code)).to.not.include('erp');
    expect(hostApps().modules.map(module => module.code)).to.deep.equal(['crm']);
    expect(localOf('tenant-a').status).to.equal('closed');
    const detailError = await app.detail({ id: erpApp.id }).catch(e => e);
    expect(detailError).to.be.an('error');

    const result = await erp.fastify.oidc.appRegistry.register();
    expect(result.changed).to.equal(true);
    await settlePush();
    expect((await findApp('erp')).status).to.equal('open');
    expect(localOf('tenant-a').status).to.equal('open');
    expect(localOf('tenant-b').status).to.equal('open');
  });

  it('independent mode: deleting the host tenant closes the managed tenant', async () => {
    const { deletedTenants } = host.fastify.tenant;
    expect(localOf('tenant-b').status).to.equal('open');
    deletedTenants.add('tenant-b');
    try {
      const local = await erp.fastify.oidc.tenantSync.sync('tenant-b');
      expect(local).to.include({ name: '租户 B', status: 'closed' });
      expect(await erp.fastify.oidc.tenantSync.ensureFresh('tenant-b')).to.equal(null);
      expect(await erp.fastify.oidc.tenantSync.sync('tenant-never-synced')).to.equal(null);
    } finally {
      deletedTenants.delete('tenant-b');
    }
  });
});
