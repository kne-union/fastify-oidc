const crypto = require('node:crypto');
const { expect } = require('chai');
const { SignJWT, exportJWK } = require('jose');
const { createApp } = require('./support/app');
const { oauth, createBrowser, discover, login, refresh, getJson, decodeJwt } = require('./support/http');

const USERS = [
  { id: '1001', nickname: '张三', email: 'zhangsan@test.com', password: 'pwd-1', isSuperAdmin: true },
  { id: '1002', nickname: '李四', email: 'lisi@test.com', password: 'pwd-2' },
  { id: '1004', nickname: '无租户', email: 'none@test.com', password: 'pwd-4' }
];

const MEMBERSHIPS = {
  1001: [
    { id: 'tu-a', tenantId: 'tenant-a', name: '租户 A', roles: ['admin'], permissions: ['order:read'] },
    { id: 'tu-b', tenantId: 'tenant-b', name: '租户 B', roles: ['viewer'], permissions: [] }
  ],
  1002: [{ id: 'tu-c', tenantId: 'tenant-a', name: '租户 A', roles: ['viewer'], permissions: [] }]
};

const ZHANGSAN = { email: 'zhangsan@test.com', password: 'pwd-1' };
const LISI = { email: 'lisi@test.com', password: 'pwd-2' };
const ADMIN = { 'x-user-token': 'legacy:1001' };

describe('@kne/fastify-oidc 安全与管理', function () {
  this.timeout(30000);
  let app, as, clientId, redirectUri, audience;

  const credentialsInteraction = (browser, credentials, { tenantId } = {}) => {
    const steps = [];
    const handler = async uid => {
      const base = `${app.origin}/api/oidc/interaction/${uid}`;
      const details = await (await browser.request(`${base}/details`)).json();
      steps.push(details.prompt.name);
      if (details.prompt.name === 'login') {
        return (await browser.json(`${base}/login`, credentials)).redirectTo;
      }
      if (details.prompt.name === 'tenant') {
        return (await browser.json(`${base}/tenant`, { tenantId })).redirectTo;
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

  const loginError = async options => {
    try {
      await loginAs(options);
    } catch (e) {
      return e;
    }
    throw new Error('expected login to fail');
  };

  /**
   * 发起授权并停在第一次进入交互页时，把 uid 交给 fn 做断言
   */
  const atInteraction = async (fn, { browser = createBrowser(), extra } = {}) => {
    const stop = new Error('stop');
    try {
      await login({
        as,
        browser,
        clientId,
        redirectUri,
        resource: audience,
        extra,
        onInteraction: async uid => {
          await fn(uid, browser);
          throw stop;
        }
      });
    } catch (e) {
      if (e !== stop) {
        throw e;
      }
    }
  };

  const postError = async (browser, url, body) => {
    try {
      await browser.json(url, body);
    } catch (e) {
      return { status: e.statusCode, message: e.data.message };
    }
    throw new Error(`expected ${url} to fail`);
  };

  const admin = async (path, body) => {
    const response = await fetch(`${app.origin}/api/oidc/admin/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, ADMIN),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  const clientCredentials = async ({ id, secret, resource, scope }) => {
    const response = await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
      body: new URLSearchParams(Object.assign({ grant_type: 'client_credentials', resource }, scope ? { scope } : {}))
    });
    return { status: response.status, body: await response.json() };
  };

  before(async () => {
    app = await createApp({ users: USERS, memberships: MEMBERSHIPS });
    clientId = 'oidc-spa';
    redirectUri = `${app.origin}/oidc-callback`;
    audience = `${app.origin}/api`;
    as = await discover(`${app.origin}/oidc`);
  });

  after(async () => {
    await app.fastify.close();
  });

  describe('登录交互防跳步', () => {
    it('should not allow tenant or consent submission before login', async () => {
      await atInteraction(async (uid, browser) => {
        const base = `${app.origin}/api/oidc/interaction/${uid}`;
        expect(await postError(browser, `${base}/tenant`, { tenantId: 'tenant-a' })).to.deep.equal({ status: 400, message: '当前步骤为 login，不能执行 tenant' });
        expect(await postError(browser, `${base}/confirm`)).to.deep.equal({ status: 400, message: '当前步骤为 login，不能执行 consent' });
      });
    });

    it('should reject interaction uid that does not match the cookie', async () => {
      await atInteraction(async (uid, browser) => {
        const cookie = [...browser.cookies.values()].map(item => `${item.name}=${item.value}`).join('; ');
        const response = await fetch(`${app.origin}/api/oidc/interaction/forged-uid/details`, { headers: { cookie } });
        expect(response.status).to.equal(400);
        expect((await response.json()).message).to.equal('登录会话不匹配，请从应用重新发起登录');
      });
    });

    it('should reject interaction without cookie', async () => {
      await atInteraction(async uid => {
        const response = await fetch(`${app.origin}/api/oidc/interaction/${uid}/details`);
        expect(response.status).to.equal(400);
        expect((await response.json()).message).to.equal('登录会话已失效，请从应用重新发起登录');
      });
    });
  });

  describe('租户隔离', () => {
    it('should reject selecting a tenant the user does not belong to', async () => {
      const browser = createBrowser();
      const stop = new Error('stop');
      let checked = false;
      try {
        await login({
          as,
          browser,
          clientId,
          redirectUri,
          resource: audience,
          onInteraction: async uid => {
            const base = `${app.origin}/api/oidc/interaction/${uid}`;
            const details = await (await browser.request(`${base}/details`)).json();
            if (details.prompt.name === 'login') {
              return (await browser.json(`${base}/login`, ZHANGSAN)).redirectTo;
            }
            expect(details.prompt.name).to.equal('tenant');
            expect(await postError(browser, `${base}/tenant`, { tenantId: 'tenant-x' })).to.deep.equal({ status: 400, message: '当前用户不属于该租户或租户已关闭' });
            checked = true;
            throw stop;
          }
        });
      } catch (e) {
        if (e !== stop) {
          throw e;
        }
      }
      expect(checked).to.equal(true);
    });

    it('should not silently switch to a tenant the user does not belong to', async () => {
      const { browser } = await loginAs({ credentials: ZHANGSAN, tenantId: 'tenant-a' });
      const error = await loginError({ browser, extra: { prompt: 'none', tenant_id: 'tenant-x' } });
      expect(error.error).to.equal('interaction_required');

      const { tokens, onInteraction } = await loginAs({ browser, tenantId: 'tenant-b', extra: { tenant_id: 'tenant-x' } });
      expect(onInteraction.steps).to.deep.equal(['tenant']);
      expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-b');
    });

    it('should keep current tenant when requested tenant equals current', async () => {
      const { browser } = await loginAs({ credentials: ZHANGSAN, tenantId: 'tenant-b' });
      const { tokens, onInteraction } = await loginAs({ browser, extra: { prompt: 'none', tenant_id: 'tenant-b' } });
      expect(onInteraction.steps).to.deep.equal([]);
      expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal('tenant-b');
    });

    it('should login without tenant for user without membership and reject tenant routes', async () => {
      const { tokens, onInteraction } = await loginAs({ credentials: { email: 'none@test.com', password: 'pwd-4' } });
      expect(onInteraction.steps).to.deep.equal(['login']);
      expect(decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`]).to.equal(undefined);
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(200);
      const tenantMe = await getJson(`${app.origin}/api/tenant-me`, tokens.access_token);
      expect(tenantMe.status).to.equal(403);
      expect(tenantMe.body.message).to.equal('当前登录未选择租户');
    });
  });

  describe('DPoP 校验', () => {
    let keyPair, publicJwk, token, url;

    const proof = async ({ key = keyPair.privateKey, jwk = publicJwk, htm = 'GET', htu = url, accessToken = token, jti = crypto.randomUUID() } = {}) => {
      const ath = crypto.createHash('sha256').update(accessToken).digest('base64url');
      return new SignJWT({ htm, htu, ath, jti }).setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk }).setIssuedAt().sign(key);
    };

    const call = async (headers, accessToken = token) => {
      const response = await fetch(url, { headers: Object.assign({ authorization: `DPoP ${accessToken}` }, headers) });
      return { status: response.status, message: (await response.json()).message };
    };

    before(async () => {
      keyPair = await oauth.generateKeyPair('ES256');
      publicJwk = await exportJWK(keyPair.publicKey);
      const { tokens } = await loginAs({ credentials: LISI, DPoP: oauth.DPoP({ client_id: clientId }, keyPair) });
      token = tokens.access_token;
      url = `${app.origin}/api/me`;
    });

    it('should accept a valid proof once and reject replay', async () => {
      const dpop = await proof();
      expect((await call({ dpop })).status).to.equal(200);
      expect(await call({ dpop })).to.deep.equal({ status: 401, message: 'DPoP 校验失败：proof 被重放' });
    });

    it('should reject invalid proofs', async () => {
      const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const cases = [
        [{}, 'DPoP 校验失败：缺少 DPoP proof'],
        [{ dpop: await proof({ htm: 'POST' }) }, 'DPoP 校验失败：htm 不匹配'],
        [{ dpop: await proof({ htu: `${app.origin}/api/other` }) }, 'DPoP 校验失败：htu 不匹配'],
        [{ dpop: await proof({ accessToken: 'other-token' }) }, 'DPoP 校验失败：ath 不匹配'],
        [{ dpop: await proof({ jti: null }) }, 'DPoP 校验失败：缺少 jti'],
        [{ dpop: await proof({ key: other.privateKey, jwk: await exportJWK(other.publicKey) }) }, 'DPoP 校验失败：proof 公钥与 access_token 绑定的不一致'],
        [{ dpop: 'not-a-jwt' }, 'DPoP 校验失败']
      ];
      for (const [headers, message] of cases) {
        expect(await call(headers)).to.deep.equal({ status: 401, message });
      }
    });

    it('should reject DPoP scheme for unbound token and bearer token when DPoP is required', async () => {
      const { tokens } = await loginAs({ credentials: LISI });
      expect(await call({}, tokens.access_token)).to.deep.equal({ status: 401, message: '令牌未绑定 DPoP' });

      const { options } = app.fastify.oidc;
      options.requireDPoP = true;
      try {
        const result = await getJson(url, tokens.access_token);
        expect(result.status).to.equal(401);
        expect(result.body.message).to.equal('需要 DPoP 绑定的访问令牌');
      } finally {
        options.requireDPoP = false;
      }
    });
  });

  describe('会话管理与强制下线', () => {
    const expectLoggedOut = async ({ browser, tokens }) => {
      expect((await getJson(`${app.origin}/api/me`, tokens.access_token)).status).to.equal(401);
      let refreshError;
      try {
        await refresh({ as, clientId, refreshToken: tokens.refresh_token, resource: audience });
      } catch (e) {
        refreshError = e;
      }
      expect(refreshError).to.exist;
      expect((await loginError({ browser, extra: { prompt: 'none' } })).error).to.equal('login_required');
    };

    it('should end a single session through admin api', async () => {
      const { tokens, browser } = await loginAs({ credentials: LISI });
      const sessions = await admin('session/list?userId=1002');
      expect(sessions.status).to.equal(200);
      const session = sessions.body.find(item => item.clients.some(client => client.sid === decodeJwt(tokens.access_token).sid));
      expect(session).to.exist;

      expect((await admin('session/revoke', { uid: session.uid })).status).to.equal(200);
      await expectLoggedOut({ browser, tokens });
      expect((await admin('session/list?userId=1002')).body.find(item => item.uid === session.uid)).to.equal(undefined);

      const missing = await admin('session/revoke', { uid: session.uid });
      expect(missing.status).to.equal(404);
      expect(missing.body.message).to.equal('会话不存在或已过期');
    });

    it('should force logout a user with revoke-user logout=true', async () => {
      const first = await loginAs({ credentials: LISI });
      const second = await loginAs({ credentials: LISI });
      const result = await admin('session/revoke-user', { userId: '1002', logout: true });
      expect(result.status).to.equal(200);
      expect(result.body.sessions).to.be.at.least(2);
      expect(result.body.grants).to.be.at.least(2);
      await expectLoggedOut(first);
      await expectLoggedOut(second);
      expect((await admin('session/list?userId=1002')).body).to.deep.equal([]);
    });
  });

  describe('权限边界', () => {
    it('should reject non-admin users on admin api', async () => {
      const legacy = await getJson(`${app.origin}/api/oidc/admin/client/list`, null, { 'x-user-token': 'legacy:1002' });
      expect(legacy.status).to.equal(401);
      const { tokens } = await loginAs({ credentials: LISI });
      expect((await getJson(`${app.origin}/api/oidc/admin/client/list`, tokens.access_token)).status).to.equal(401);
      expect((await getJson(`${app.origin}/api/oidc/admin/client/list`)).status).to.equal(401);
    });
  });

  describe('client 管理接口', () => {
    const confidential = { grant_types: ['client_credentials'], response_types: [], token_endpoint_auth_method: 'client_secret_basic' };

    it('should create clients and only return secret once', async () => {
      const pub = await admin('client/create', { clientId: 'mgmt-public', clientName: '公共', metadata: { redirect_uris: ['https://app.example.com/cb'] } });
      expect(pub.status).to.equal(200);
      expect(pub.body.hasSecret).to.equal(false);
      expect(pub.body.clientSecret).to.equal(undefined);

      const conf = await admin('client/create', { clientId: 'mgmt-confidential', metadata: confidential, allowedResources: [audience] });
      expect(conf.body.hasSecret).to.equal(true);
      expect(conf.body.clientSecret).to.be.a('string');
      const detail = await admin(`client/detail?id=${conf.body.id}`);
      expect(detail.body.clientSecret).to.equal(undefined);
      expect(detail.body.hasSecret).to.equal(true);
      expect((await clientCredentials({ id: 'mgmt-confidential', secret: conf.body.clientSecret, resource: audience })).status).to.equal(200);

      const duplicate = await admin('client/create', { clientId: 'mgmt-public', metadata: {} });
      expect(duplicate.status).to.equal(400);
      expect(duplicate.body.message).to.equal('client_id mgmt-public 已存在');

      const invalid = await admin('client/create', { clientId: 'mgmt-invalid', metadata: { redirect_uris: ['not a url'] } });
      expect(invalid.status).to.equal(400);
      expect(invalid.body.message).to.match(/^client 配置不合法: /);

      const { services } = app.fastify.oidc;
      expect((await services.client.list({ filter: { keyword: 'mgmt-conf' } })).pageData.map(item => item.clientId)).to.deep.equal(['mgmt-confidential']);
    });

    it('should rotate secret and invalidate the old one', async () => {
      const created = await admin('client/create', { clientId: 'mgmt-rotate', metadata: confidential, allowedResources: [audience] });
      const rotated = await admin('client/rotate-secret', { id: created.body.id });
      expect(rotated.status).to.equal(200);
      expect(rotated.body.clientSecret).to.not.equal(created.body.clientSecret);
      expect((await clientCredentials({ id: 'mgmt-rotate', secret: rotated.body.clientSecret, resource: audience })).status).to.equal(200);
      expect((await clientCredentials({ id: 'mgmt-rotate', secret: created.body.clientSecret, resource: audience })).status).to.equal(401);

      const pub = await admin('client/create', { clientId: 'mgmt-rotate-public', metadata: { redirect_uris: ['https://app.example.com/cb'] } });
      const denied = await admin('client/rotate-secret', { id: pub.body.id });
      expect(denied.status).to.equal(400);
      expect(denied.body.message).to.equal('public client 没有 client_secret');
    });

    it('should generate or clear secret when switching client type', async () => {
      const created = await admin('client/create', { clientId: 'mgmt-switch', metadata: { redirect_uris: ['https://app.example.com/cb'] } });
      expect((await admin('client/save', { id: created.body.id, metadata: confidential })).status).to.equal(200);
      expect((await admin(`client/detail?id=${created.body.id}`)).body.hasSecret).to.equal(true);
      const toPublic = await admin('client/save', { id: created.body.id, clientName: '改回公共', metadata: { redirect_uris: ['https://app.example.com/cb'] } });
      expect(toPublic.status).to.equal(200);
      const detail = (await admin(`client/detail?id=${created.body.id}`)).body;
      expect(detail.hasSecret).to.equal(false);
      expect(detail.clientName).to.equal('改回公共');
      expect(detail.metadata.token_endpoint_auth_method).to.equal('none');
    });

    it('should disable and remove clients', async () => {
      const created = await admin('client/create', { clientId: 'mgmt-status', metadata: confidential, allowedResources: [audience] });
      const secret = created.body.clientSecret;
      expect((await admin('client/set-status', { id: created.body.id, status: 'closed' })).status).to.equal(200);
      expect((await clientCredentials({ id: 'mgmt-status', secret, resource: audience })).status).to.equal(401);
      await admin('client/set-status', { id: created.body.id, status: 'open' });
      expect((await clientCredentials({ id: 'mgmt-status', secret, resource: audience })).status).to.equal(200);

      expect((await admin('client/remove', { id: created.body.id })).status).to.equal(200);
      const removed = await admin(`client/detail?id=${created.body.id}`);
      expect(removed.status).to.equal(404);
      expect(removed.body.message).to.equal('client 不存在');
      expect((await clientCredentials({ id: 'mgmt-status', secret, resource: audience })).status).to.equal(401);
    });
  });

  describe('资源服务管理接口', () => {
    const identifier = 'https://res.example.com/api';
    let id, secret;

    before(async () => {
      const created = await admin('client/create', {
        clientId: 'res-client',
        metadata: { grant_types: ['client_credentials'], response_types: [], token_endpoint_auth_method: 'client_secret_basic' },
        allowedResources: [identifier]
      });
      secret = created.body.clientSecret;
    });

    it('should validate identifier and reject duplicates', async () => {
      const invalid = await admin('resource-server/create', { identifier: 'not-uri', name: '非法' });
      expect(invalid.status).to.equal(400);
      expect(invalid.body.message).to.equal('identifier 必须是绝对 URI，如 https://app.example.com/api');

      const created = await admin('resource-server/create', { identifier, name: '外部资源', scope: 'read write' });
      expect(created.status).to.equal(200);
      id = created.body.id;

      const duplicate = await admin('resource-server/create', { identifier, name: '重复' });
      expect(duplicate.status).to.equal(400);
      expect(duplicate.body.message).to.equal(`资源服务 ${identifier} 已存在`);

      const list = await admin('resource-server/list');
      expect(list.body.pageData.map(item => item.identifier)).to.include(identifier);
      expect((await app.fastify.oidc.services.resourceServer.list({ filter: { keyword: 'res.example', status: 'open' } })).totalCount).to.equal(1);
    });

    it('should issue tokens with saved scope and reject disabled resource', async () => {
      expect((await admin('resource-server/save', { id, name: '外部资源', scope: 'read' })).status).to.equal(200);
      expect((await admin(`resource-server/detail?id=${id}`)).body.scope).to.equal('read');
      const issued = await clientCredentials({ id: 'res-client', secret, resource: identifier, scope: 'read' });
      expect(issued.status).to.equal(200);
      expect(decodeJwt(issued.body.access_token).aud).to.equal(identifier);

      await admin('resource-server/set-status', { id, status: 'closed' });
      const disabled = await clientCredentials({ id: 'res-client', secret, resource: identifier, scope: 'read' });
      expect(disabled.status).to.equal(400);
      expect(disabled.body.error).to.equal('invalid_target');
      expect(disabled.body.error_description).to.equal(`资源服务 ${identifier} 不存在或已停用`);
      expect(await app.fastify.oidc.services.resourceServer.listIdentifiers()).to.not.include(identifier);
    });

    it('should remove resource server', async () => {
      expect((await admin('resource-server/remove', { id })).status).to.equal(200);
      const removed = await admin(`resource-server/detail?id=${id}`);
      expect(removed.status).to.equal(404);
      expect(removed.body.message).to.equal('资源服务不存在');
    });
  });
});
