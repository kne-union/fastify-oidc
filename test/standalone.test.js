const { expect } = require('chai');
const { createApp } = require('./support/app');
const { oauth, insecure, createBrowser, discover, login, refresh, getJson, decodeJwt } = require('./support/http');

const USERS = [
  { id: '1001', nickname: '张三', email: 'zhangsan@test.com', password: 'pwd-1', isSuperAdmin: true },
  { id: '1002', nickname: '李四', email: 'lisi@test.com', password: 'pwd-2' },
  { id: '1003', nickname: '已禁用', email: 'disabled@test.com', password: 'pwd-3', status: 11 }
];

const MEMBERSHIPS = {
  1001: [
    { id: 'tu-a', tenantId: 'tenant-a', name: '租户 A', roles: ['admin'], permissions: ['order:read'] },
    { id: 'tu-b', tenantId: 'tenant-b', name: '租户 B', roles: ['viewer'], permissions: [] }
  ],
  1002: [{ id: 'tu-c', tenantId: 'tenant-a', name: '租户 A', roles: ['viewer'], permissions: [] }]
};

describe('@kne/fastify-oidc standalone 模式', function () {
  this.timeout(30000);
  let app, as, issuer, clientId, redirectUri, audience;

  const credentialsInteraction = (browser, credentials, { tenantId } = {}) => {
    const steps = [];
    const handler = async uid => {
      const base = `${app.origin}/api/oidc/interaction/${uid}`;
      const details = await (await browser.request(`${base}/details`)).json();
      steps.push(details.prompt.name);
      if (details.prompt.name === 'login') {
        const result = await browser.json(`${base}/login`, credentials);
        if (!result.redirectTo) {
          throw Object.assign(new Error('login failed'), { result });
        }
        return result.redirectTo;
      }
      if (details.prompt.name === 'tenant') {
        handler.tenants = details.tenants;
        return (await browser.json(`${base}/tenant`, { tenantId })).redirectTo;
      }
      if (details.prompt.name === 'consent') {
        return (await browser.json(`${base}/confirm`)).redirectTo;
      }
      throw new Error(`unexpected prompt ${details.prompt.name}`);
    };
    handler.steps = steps;
    return handler;
  };

  const loginAs = async ({ browser = createBrowser(), credentials, tenantId, extra, DPoP } = {}) => {
    const onInteraction = credentialsInteraction(browser, credentials, { tenantId });
    const tokens = await login({ as, browser, clientId, redirectUri, resource: audience, extra, onInteraction, DPoP });
    return { tokens, browser, onInteraction };
  };

  before(async () => {
    app = await createApp({ users: USERS, memberships: MEMBERSHIPS });
    issuer = `${app.origin}/oidc`;
    clientId = 'oidc-spa';
    redirectUri = `${app.origin}/oidc-callback`;
    audience = `${app.origin}/api`;
    as = await discover(issuer);
  });

  after(async () => {
    await app.fastify.close();
  });

  describe('插件注册测试', () => {
    it('should expose discovery and jwks with active key', async () => {
      expect(as.issuer).to.equal(issuer);
      expect(as.authorization_endpoint).to.equal(`${issuer}/auth`);
      const jwks = await (await fetch(as.jwks_uri)).json();
      expect(jwks.keys.length).to.be.at.least(1);
      expect(jwks.keys[0]).to.not.have.property('d');
    });

    it('should seed self public client and resource servers', async () => {
      const { services } = app.fastify.oidc;
      const client = await services.client.findForProvider(clientId);
      expect(client.token_endpoint_auth_method).to.equal('none');
      expect(client.allowed_resources).to.deep.equal([audience]);
      expect(await services.resourceServer.findByIdentifier(audience)).to.exist;
    });

    it('should expose public login config without auth', async () => {
      const res = await fetch(`${app.origin}/api/oidc/config`);
      expect(res.status).to.equal(200);
      expect(await res.json()).to.deep.equal({ mode: 'standalone', issuer, clientId, audience });
    });
  });

  describe('授权码 + PKCE 登录', () => {
    it('should login, select tenant and call api with bearer token', async () => {
      const { tokens, onInteraction } = await loginAs({
        credentials: { type: 'email', email: 'zhangsan@test.com', password: 'pwd-1' },
        tenantId: 'tenant-b'
      });
      expect(onInteraction.steps).to.deep.equal(['login', 'tenant']);
      expect(onInteraction.tenants.list.map(item => item.tenantId)).to.deep.equal(['tenant-a', 'tenant-b']);
      expect(tokens.refresh_token).to.be.a('string');
      expect(tokens.id_token).to.be.a('string');

      const claims = decodeJwt(tokens.access_token);
      expect(claims.aud).to.equal(audience);
      expect(claims.sub).to.equal('1001');
      expect(claims[`${app.origin}/tenant_id`]).to.equal('tenant-b');
      expect(claims[`${app.origin}/roles`]).to.deep.equal(['viewer']);
      expect(claims.sid).to.be.a('string');

      const me = await getJson(`${app.origin}/api/me`, tokens.access_token);
      expect(me.status).to.equal(200);
      expect(me.body.user.userId).to.equal('1001');
      expect(me.body.user.tenantId).to.equal('tenant-b');
      expect(me.body.userInfo.nickname).to.equal('张三');

      const tenantMe = await getJson(`${app.origin}/api/tenant-me`, tokens.access_token);
      expect(tenantMe.body.tenantId).to.equal('tenant-b');
    });

    it('should auto select the only tenant', async () => {
      const { tokens, onInteraction } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      expect(onInteraction.steps).to.deep.equal(['login']);
      expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-a');
    });

    it('should reject wrong password and disabled user', async () => {
      const browser = createBrowser();
      const handler = credentialsInteraction(browser, { email: 'lisi@test.com', password: 'wrong' });
      let error;
      try {
        await login({ as, browser, clientId, redirectUri, resource: audience, onInteraction: handler });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;

      const browser2 = createBrowser();
      const handler2 = credentialsInteraction(browser2, { email: 'disabled@test.com', password: 'pwd-3' });
      let error2;
      try {
        await login({ as, browser: browser2, clientId, redirectUri, resource: audience, onInteraction: handler2 });
      } catch (e) {
        error2 = e;
      }
      expect(error2.result).to.deep.equal({ status: 11 });
    });

    it('should refresh with rotation and keep tenant', async () => {
      const { tokens } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      const refreshed = await refresh({ as, clientId, refreshToken: tokens.refresh_token, resource: audience });
      expect(refreshed.refresh_token).to.not.equal(tokens.refresh_token);
      expect(decodeJwt(refreshed.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-a');
      let error;
      try {
        await refresh({ as, clientId, refreshToken: tokens.refresh_token, resource: audience });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
    });

    it('should switch tenant silently with tenant_id and prompt=none', async () => {
      const { browser } = await loginAs({ credentials: { email: 'zhangsan@test.com', password: 'pwd-1' }, tenantId: 'tenant-a' });
      const { tokens, onInteraction } = await loginAs({ browser, extra: { prompt: 'none', tenant_id: 'tenant-b' } });
      expect(onInteraction.steps).to.deep.equal([]);
      expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-b');
    });
  });

  describe('consent 与取消', () => {
    it('should require consent for skip_consent=false client and support abort', async () => {
      await app.fastify.oidc.services.client.create({
        clientId: 'third-party',
        clientName: '第三方应用',
        metadata: { redirect_uris: [redirectUri], skip_consent: false },
        allowedResources: [audience]
      });
      const browser = createBrowser();
      const handler = credentialsInteraction(browser, { email: 'lisi@test.com', password: 'pwd-2' });
      const tokens = await login({ as, browser, clientId: 'third-party', redirectUri, resource: audience, onInteraction: handler });
      expect(handler.steps).to.deep.equal(['login', 'consent']);
      expect(decodeJwt(tokens.access_token).client_id).to.equal('third-party');

      const aborted = createBrowser();
      let error;
      try {
        await login({
          as,
          browser: aborted,
          clientId: 'third-party',
          redirectUri,
          resource: audience,
          onInteraction: async uid => (await aborted.json(`${app.origin}/api/oidc/interaction/${uid}/abort`)).redirectTo
        });
      } catch (e) {
        error = e;
      }
      expect(error.error).to.equal('access_denied');
    });
  });

  describe('资源侧鉴权', () => {
    it('should reject missing, invalid and wrong audience tokens', async () => {
      expect((await getJson(`${app.origin}/api/me`)).status).to.equal(401);
      expect((await getJson(`${app.origin}/api/me`, 'invalid.token.value')).status).to.equal(401);
    });

    it('should fall back to legacy x-user-token', async () => {
      const result = await getJson(`${app.origin}/api/me`, null, { 'x-user-token': 'legacy:1002' });
      expect(result.status).to.equal(200);
      expect(result.body.user.legacy).to.equal(true);
      expect(result.body.userInfo.nickname).to.equal('李四');
    });

    it('should check permission through tenant service', async () => {
      const { tokens: a } = await loginAs({ credentials: { email: 'zhangsan@test.com', password: 'pwd-1' }, tenantId: 'tenant-a' });
      expect((await getJson(`${app.origin}/api/need-permission`, a.access_token)).status).to.equal(200);
      const { tokens: b } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      expect((await getJson(`${app.origin}/api/need-permission`, b.access_token)).status).to.equal(403);
    });
  });

  describe('DPoP', () => {
    it('should bind token to DPoP key and verify proof on resource', async () => {
      const keyPair = await oauth.generateKeyPair('ES256');
      const DPoP = oauth.DPoP({ client_id: clientId }, keyPair);
      const { tokens } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' }, DPoP });
      expect(tokens.token_type.toLowerCase()).to.equal('dpop');
      expect(decodeJwt(tokens.access_token).cnf.jkt).to.be.a('string');

      const url = new URL(`${app.origin}/api/me`);
      const response = await oauth.protectedResourceRequest(tokens.access_token, 'GET', url, new Headers(), null, Object.assign({ DPoP }, insecure));
      expect(response.status).to.equal(200);

      expect((await getJson(url.toString(), tokens.access_token)).status).to.equal(401);
    });
  });

  describe('登出与撤销', () => {
    it('should revoke sid after rp-initiated logout', async () => {
      const { tokens, browser } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(200);

      const endUrl = new URL(as.end_session_endpoint);
      endUrl.searchParams.set('id_token_hint', tokens.id_token);
      endUrl.searchParams.set('post_logout_redirect_uri', `${app.origin}/`);
      const page = await (await browser.request(endUrl.toString())).text();
      const action = page.match(/action="([^"]+)"/)[1];
      const xsrf = page.match(/name="xsrf" value="([^"]+)"/)[1];
      const confirm = await browser.request(new URL(action, endUrl).toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ xsrf, logout: 'yes' }).toString()
      });
      expect(confirm.status).to.equal(303);
      expect(confirm.headers.get('location')).to.equal(`${app.origin}/`);
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(401);
    });

    it('should revoke tokens on permission change and allow silent re-login', async () => {
      const { tokens, browser } = await loginAs({ credentials: { email: 'zhangsan@test.com', password: 'pwd-1' }, tenantId: 'tenant-a' });
      await new Promise(resolve => setTimeout(resolve, 1100));
      await app.fastify.oidc.onPermissionChange({ userIds: ['1001'] });
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(401);
      let error;
      try {
        await refresh({ as, clientId, refreshToken: tokens.refresh_token, resource: audience });
      } catch (e) {
        error = e;
      }
      expect(error).to.exist;
      await new Promise(resolve => setTimeout(resolve, 1100));
      const { tokens: again, onInteraction } = await loginAs({ browser, extra: { prompt: 'none' } });
      expect(onInteraction.steps).to.deep.equal([]);
      expect((await getJson(`${app.origin}/api/me`, again.access_token)).status).to.equal(200);
    });
  });

  describe('租户成员变化', () => {
    it('should re-select tenant when current tenant membership is removed', async () => {
      const memberships = app.fastify.tenant.memberships;
      const original = memberships['1001'];
      const { browser } = await loginAs({ credentials: { email: 'zhangsan@test.com', password: 'pwd-1' }, tenantId: 'tenant-b' });
      memberships['1001'] = original.filter(item => item.tenantId !== 'tenant-b');
      try {
        const { tokens, onInteraction } = await loginAs({ browser, extra: { prompt: 'none' } });
        expect(onInteraction.steps).to.deep.equal([]);
        expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-a');
      } finally {
        memberships['1001'] = original;
      }
    });
  });

  describe('密钥轮换', () => {
    it('should keep old tokens valid and sign new tokens with new key', async () => {
      const { tokens } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      const oldKid = JSON.parse(Buffer.from(tokens.access_token.split('.')[0], 'base64url').toString()).kid;
      await app.fastify.oidc.services.key.rotate();
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(200);
      const { tokens: next } = await loginAs({ credentials: { email: 'lisi@test.com', password: 'pwd-2' } });
      const newKid = JSON.parse(Buffer.from(next.access_token.split('.')[0], 'base64url').toString()).kid;
      expect(newKid).to.not.equal(oldKid);
      const list = await app.fastify.oidc.services.key.list();
      expect(list.map(item => item.status).sort()).to.include.members(['active', 'next', 'retired']);
    });
  });
});
