const crypto = require('node:crypto');
const { expect } = require('chai');
const { SignJWT, importJWK } = require('jose');
const { createApp, getFreePort } = require('./support/app');
const { createBrowser, discover, login, getJson, decodeJwt } = require('./support/http');
const { GRANT_TYPE: TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE } = require('../libs/idp/grants/token-exchange');

const USERS = [{ id: '2001', nickname: '王五', email: 'wangwu@test.com', password: 'pwd', isSuperAdmin: true }];
const MEMBERSHIPS = {
  2001: [{ id: 'tu-x', tenantId: 'tenant-x', name: '租户 X', roles: ['admin'], permissions: ['order:read'] }]
};

describe('@kne/fastify-oidc central 模式', function () {
  this.timeout(30000);
  let idp, child, idpAs, childOrigin, idpOrigin, browser;

  const interaction = (origin, credentials) => async uid => {
    const base = `${origin}/api/oidc/interaction/${uid}`;
    const details = await (await browser.request(`${base}/details`)).json();
    if (details.prompt.name === 'login') {
      return (await browser.json(`${base}/login`, credentials)).redirectTo;
    }
    throw new Error(`unexpected prompt ${details.prompt.name}`);
  };

  const basicAuth = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  before(async () => {
    const [idpPort, childPort] = [await getFreePort(), await getFreePort()];
    idpOrigin = `http://127.0.0.1:${idpPort}`;
    childOrigin = `http://127.0.0.1:${childPort}`;
    idp = await createApp({
      port: idpPort,
      users: USERS,
      memberships: MEMBERSHIPS,
      oidc: {
        isMain: true,
        resourceServers: [{ identifier: `${childOrigin}/api`, name: '子项目 API', includePermissions: true }],
        clients: [
          {
            clientId: 'child-spa',
            redirect_uris: [`${childOrigin}/oidc-callback`],
            post_logout_redirect_uris: [`${childOrigin}/`],
            backchannel_logout_uri: `${childOrigin}/api/oidc/backchannel-logout`,
            allowedResources: [`${childOrigin}/api`]
          },
          {
            clientId: 'child-service',
            clientSecret: 'child-secret',
            grant_types: ['client_credentials', TOKEN_EXCHANGE],
            response_types: [],
            token_endpoint_auth_method: 'client_secret_basic',
            allowedResources: [`${idpOrigin}/api/oidc`, `${idpOrigin}/api`, `${childOrigin}/api`]
          }
        ]
      }
    });
    child = await createApp({
      port: childPort,
      mode: 'central',
      oidc: {
        issuer: `${idpOrigin}/oidc`,
        clientId: 'child-spa',
        serviceClient: { clientId: 'child-service', clientSecret: 'child-secret' },
        userMirrorTTL: 0
      }
    });
    idpAs = await discover(`${idpOrigin}/oidc`);
    browser = createBrowser();
  });

  after(async () => {
    await child.fastify.close();
    await idp.fastify.close();
  });

  it('should not create idp tables or routes in central mode', async () => {
    expect(child.fastify.oidc.idp).to.equal(null);
    expect(child.fastify.oidc.models).to.equal(undefined);
    expect((await fetch(`${childOrigin}/oidc/.well-known/openid-configuration`)).status).to.equal(404);
  });

  it('should expose public login config pointing to idp', async () => {
    const res = await fetch(`${childOrigin}/api/oidc/config`);
    expect(res.status).to.equal(200);
    expect(await res.json()).to.deep.equal({ mode: 'central', isMain: false, issuer: `${idpOrigin}/oidc`, clientId: 'child-spa', audience: `${childOrigin}/api` });
  });

  it('should mark main project in public login config', async () => {
    const res = await fetch(`${idpOrigin}/api/oidc/config`);
    expect((await res.json()).isMain).to.equal(true);
  });

  it('should sso into child and mirror user from idp', async () => {
    const idpTokens = await login({
      as: idpAs,
      browser,
      clientId: 'oidc-spa',
      redirectUri: `${idpOrigin}/oidc-callback`,
      resource: `${idpOrigin}/api`,
      onInteraction: interaction(idpOrigin, { email: 'wangwu@test.com', password: 'pwd' })
    });
    expect((await getJson(`${idpOrigin}/api/me`, idpTokens.access_token)).status).to.equal(200);

    const childTokens = await login({
      as: idpAs,
      browser,
      clientId: 'child-spa',
      redirectUri: `${childOrigin}/oidc-callback`,
      resource: `${childOrigin}/api`,
      onInteraction: () => {
        throw new Error('SSO 不应再次出现交互');
      }
    });
    const claims = decodeJwt(childTokens.access_token);
    expect(claims.aud).to.equal(`${childOrigin}/api`);
    expect(claims[`${idpOrigin}/tenant_id`]).to.equal('tenant-x');
    expect(claims[`${idpOrigin}/permissions`]).to.deep.equal(['order:read']);

    expect((await getJson(`${idpOrigin}/api/me`, childTokens.access_token)).status).to.equal(401);

    const me = await getJson(`${childOrigin}/api/me`, childTokens.access_token);
    expect(me.status).to.equal(200);
    expect(me.body.user.userId).to.equal('2001');
    expect(me.body.userInfo.nickname).to.equal('王五');
    const mirror = await child.fastify.account.models.user.findByPk('2001');
    expect(mirror.email).to.equal('wangwu@test.com');
    const mirrorAccount = await child.fastify.account.models.userAccount.findByPk(mirror.userAccountId);
    expect(String(mirrorAccount.belongToUserId)).to.equal('2001');

    expect(mirror.isSuperAdmin).to.equal(true);
    expect((await getJson(`${childOrigin}/api/admin-only`, childTokens.access_token)).status).to.equal(200);
    await idp.fastify.account.models.user.update({ isSuperAdmin: false }, { where: { id: '2001' } });
    expect((await getJson(`${childOrigin}/api/admin-only`, childTokens.access_token)).status).to.equal(401);
    await idp.fastify.account.models.user.update({ isSuperAdmin: true }, { where: { id: '2001' } });
    expect((await getJson(`${childOrigin}/api/admin-only`, childTokens.access_token)).status).to.equal(200);

    const tenantMe = await getJson(`${childOrigin}/api/tenant-me`, childTokens.access_token);
    expect(tenantMe.body.tenantId).to.equal('tenant-x');
    expect((await getJson(`${childOrigin}/api/need-permission`, childTokens.access_token)).status).to.equal(200);

    this.idpTokens = idpTokens;
    this.childTokens = childTokens;
  });

  it('should fetch tenant user from idp via service client', async () => {
    const info = await child.fastify.oidc.serviceClient.getTenantUser({ userId: '2001', tenantId: 'tenant-x' });
    expect(info.id).to.equal('tu-x');
    expect(info.permissions).to.deep.equal(['order:read']);
  });

  it('should only allow client tokens on service routes', async () => {
    const token = await child.fastify.oidc.serviceClient.getServiceToken();
    const claims = decodeJwt(token);
    expect(claims[`${idpOrigin}/client_token`]).to.equal(true);
    expect((await getJson(`${idpOrigin}/api/service-only`, token)).body).to.deep.equal({ clientId: 'child-service' });
    expect((await getJson(`${idpOrigin}/api/me`, token)).status).to.equal(401);
    expect((await getJson(`${idpOrigin}/api/service-only`, this.idpTokens.access_token)).status).to.equal(401);
  });

  it('should exchange user token for child api token', async () => {
    const response = await fetch(idpAs.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('child-service', 'child-secret') },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: this.idpTokens.access_token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: `${childOrigin}/api`
      })
    });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).to.equal(200);
    const claims = decodeJwt(body.access_token);
    expect(claims.sub).to.equal('2001');
    expect(claims.aud).to.equal(`${childOrigin}/api`);
    expect(claims.act).to.deep.equal({ sub: 'child-service' });
    expect(claims[`${idpOrigin}/tenant_id`]).to.equal('tenant-x');
    expect((await getJson(`${childOrigin}/api/me`, body.access_token)).status).to.equal(200);

    const denied = await fetch(idpAs.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basicAuth('child-service', 'child-secret') },
      body: new URLSearchParams({
        grant_type: TOKEN_EXCHANGE,
        subject_token: this.idpTokens.access_token,
        subject_token_type: ACCESS_TOKEN_TYPE,
        resource: 'https://not-allowed.example.com/api'
      })
    });
    expect(denied.status).to.equal(400);
  });

  it('should list and revoke sessions through admin api', async () => {
    const legacy = { 'x-user-token': 'legacy:2001' };
    const sessions = await getJson(`${idpOrigin}/api/oidc/admin/session/list?userId=2001`, null, legacy);
    expect(sessions.status).to.equal(200);
    expect(sessions.body.length).to.equal(1);
    expect(sessions.body[0].clients.map(item => item.clientId).sort()).to.deep.equal(['child-spa', 'oidc-spa']);

    const clients = await getJson(`${idpOrigin}/api/oidc/admin/client/list`, null, legacy);
    expect(clients.body.pageData.map(item => item.clientId)).to.include.members(['oidc-spa', 'child-spa', 'child-service']);
    expect(clients.body.pageData.every(item => item.clientSecret === undefined)).to.equal(true);
  });

  it('should notify child through back-channel logout', async () => {
    expect((await getJson(`${childOrigin}/api/me`, this.childTokens.access_token)).status).to.equal(200);
    const endUrl = new URL(idpAs.end_session_endpoint);
    endUrl.searchParams.set('id_token_hint', this.idpTokens.id_token);
    const page = await (await browser.request(endUrl.toString())).text();
    const action = page.match(/action="([^"]+)"/)[1];
    const xsrf = page.match(/name="xsrf" value="([^"]+)"/)[1];
    await browser.request(new URL(action, endUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ xsrf, logout: 'yes' }).toString()
    });
    expect((await getJson(`${idpOrigin}/api/me`, this.idpTokens.access_token)).status).to.equal(401);
    expect((await getJson(`${childOrigin}/api/me`, this.childTokens.access_token)).status).to.equal(401);
  });

  describe('安全边界', () => {
    const sso = async () => {
      const ssoBrowser = createBrowser();
      const onInteraction = async uid => {
        const base = `${idpOrigin}/api/oidc/interaction/${uid}`;
        return (await ssoBrowser.json(`${base}/login`, { email: 'wangwu@test.com', password: 'pwd' })).redirectTo;
      };
      const idpTokens = await login({ as: idpAs, browser: ssoBrowser, clientId: 'oidc-spa', redirectUri: `${idpOrigin}/oidc-callback`, resource: `${idpOrigin}/api`, onInteraction });
      const childTokens = await login({ as: idpAs, browser: ssoBrowser, clientId: 'child-spa', redirectUri: `${childOrigin}/oidc-callback`, resource: `${childOrigin}/api`, onInteraction });
      return { idpTokens, childTokens };
    };

    const exchange = async (params, auth = basicAuth('child-service', 'child-secret')) => {
      const response = await fetch(idpAs.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
        body: new URLSearchParams(Object.assign({ grant_type: TOKEN_EXCHANGE, subject_token_type: ACCESS_TOKEN_TYPE }, params))
      });
      return { status: response.status, body: await response.json() };
    };

    // invalid_grant 对外只返回固定描述，具体原因在 grant.error 事件的 error_detail 中
    const exchangeGrantError = async (params, auth) => {
      const provider = idp.fastify.oidc.idp.getProvider();
      let detail;
      const listener = (ctx, error) => {
        detail = error.error_detail;
      };
      provider.on('grant.error', listener);
      try {
        const result = await exchange(params, auth);
        expect(result.status).to.equal(400);
        expect(result.body.error).to.equal('invalid_grant');
        return detail;
      } finally {
        provider.off('grant.error', listener);
      }
    };

    it('should reject invalid token exchange requests', async () => {
      const { idpTokens } = await sso();
      const subject = idpTokens.access_token;
      const resource = `${childOrigin}/api`;
      const cases = [
        [{ subject_token: subject, subject_token_type: 'urn:example:other', resource }, 'invalid_request', 'subject_token_type 仅支持 urn:ietf:params:oauth:token-type:access_token'],
        [{ subject_token: subject }, 'invalid_target', '需要通过 resource 指定目标资源服务']
      ];
      for (const [params, error, description] of cases) {
        const result = await exchange(params);
        expect(result.status, JSON.stringify(result.body)).to.equal(400);
        expect(result.body).to.deep.equal({ error, error_description: description });
      }
      expect(await exchangeGrantError({ subject_token: 'not-a-token', resource })).to.equal('subject_token 无效或已过期');
      const clientToken = await child.fastify.oidc.serviceClient.getServiceToken();
      expect(await exchangeGrantError({ subject_token: clientToken, resource })).to.equal('subject_token 必须是用户令牌');
    });

    it('should not exchange token whose audience is outside caller resources', async () => {
      await idp.fastify.oidc.services.client.create({
        clientId: 'narrow-service',
        clientSecret: 'narrow-secret',
        metadata: { grant_types: [TOKEN_EXCHANGE], response_types: [], token_endpoint_auth_method: 'client_secret_basic' },
        allowedResources: [`${childOrigin}/api`]
      });
      const { idpTokens } = await sso();
      const detail = await exchangeGrantError({ subject_token: idpTokens.access_token, resource: `${childOrigin}/api` }, basicAuth('narrow-service', 'narrow-secret'));
      expect(detail).to.equal('subject_token 的 aud 不属于当前 client 可访问的资源');
    });

    it('should not exchange revoked subject token or disabled user', async () => {
      const { idpTokens } = await sso();
      const resource = `${childOrigin}/api`;
      const userModel = idp.fastify.account.models.user;
      await userModel.update({ status: 11 }, { where: { id: '2001' } });
      try {
        expect(await exchangeGrantError({ subject_token: idpTokens.access_token, resource })).to.equal('subject_token 对应的用户不存在或已被禁用');
      } finally {
        await userModel.update({ status: 0 }, { where: { id: '2001' } });
      }
      expect((await exchange({ subject_token: idpTokens.access_token, resource })).status).to.equal(200);
      await idp.fastify.oidc.revocation.revokeSession(decodeJwt(idpTokens.access_token).sid);
      expect(await exchangeGrantError({ subject_token: idpTokens.access_token, resource })).to.equal('subject_token 已失效');
    });

    it('should separate user tokens, client tokens and scopes', async () => {
      const { serviceClient } = child.fastify.oidc;
      const clientApiToken = await serviceClient.getServiceToken({ resource: `${idpOrigin}/api`, scope: 'api' });
      const asUser = await getJson(`${idpOrigin}/api/me`, clientApiToken);
      expect(asUser.status).to.equal(401);
      expect(asUser.body.message).to.equal('该接口需要用户身份，不能使用 client 令牌');

      const { idpTokens } = await sso();
      const exchanged = await exchange({ subject_token: idpTokens.access_token, resource: `${idpOrigin}/api/oidc` });
      expect(exchanged.status, JSON.stringify(exchanged.body)).to.equal(200);
      const asClient = await getJson(`${idpOrigin}/api/service-only`, exchanged.body.access_token);
      expect(asClient.status).to.equal(401);
      expect(asClient.body.message).to.equal('该接口只允许 client 令牌调用');

      const narrowScope = await serviceClient.getServiceToken({ resource: `${idpOrigin}/api/oidc`, scope: 'tenant:read' });
      const missingScope = await getJson(`${idpOrigin}/api/service-only`, narrowScope);
      expect(missingScope.status).to.equal(403);
      expect(missingScope.body.message).to.equal('缺少 scope: user:read');
    });

    it('should not leak users or tenants through service api', async () => {
      const { serviceClient } = child.fastify.oidc;
      let error;
      try {
        await serviceClient.getTenantUser({ userId: '2001', tenantId: 'tenant-other' });
      } catch (e) {
        error = e;
      }
      expect(error.messageId).to.equal('idpServiceCallFailed');
      expect(error.message).to.equal('调用主项目接口 /service/tenant-user 失败（404）：用户不属于该租户');
      try {
        await serviceClient.getUserProfile('9999');
      } catch (e) {
        error = e;
      }
      expect(error.message).to.equal('调用主项目接口 /service/user 失败（404）：用户不存在');
    });

    describe('back-channel logout 接收', () => {
      const post = async logoutToken => {
        const response = await fetch(`${childOrigin}/api/oidc/backchannel-logout`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ logout_token: logoutToken })
        });
        return { status: response.status, body: await response.json() };
      };

      const sign = async claims => {
        const [jwk] = (await idp.fastify.oidc.services.key.getPrivateJwks()).keys;
        const alg = jwk.alg || 'RS256';
        return new SignJWT(claims)
          .setProtectedHeader({ alg, kid: jwk.kid, typ: 'logout+jwt' })
          .setIssuer(`${idpOrigin}/oidc`)
          .setAudience('child-spa')
          .setIssuedAt()
          .setJti(crypto.randomUUID())
          .sign(await importJWK(jwk, alg));
      };

      const events = { 'http://schemas.openid.net/event/backchannel-logout': {} };

      it('should reject forged or malformed logout tokens', async () => {
        const cases = [
          ['not-a-token', 'logout_token 校验失败'],
          [await sign({ sub: '2001' }), 'logout_token 校验失败：缺少 backchannel-logout 事件'],
          [await sign({ sub: '2001', events, nonce: 'n' }), 'logout_token 校验失败：不允许包含 nonce'],
          [await sign({ events }), 'logout_token 校验失败：必须包含 sid 或 sub']
        ];
        for (const [token, message] of cases) {
          const result = await post(token);
          expect(result.status).to.equal(400);
          expect(result.body.message).to.equal(message);
        }
      });

      it('should only revoke the session in logout token sid', async () => {
        // 前序用例按 sub 撤销过，撤销时间与 iat 均为秒级，需避开同一秒签发
        await new Promise(resolve => setTimeout(resolve, 1100));
        const first = await sso();
        const second = await sso();
        const sid = decodeJwt(first.childTokens.access_token).sid;
        expect((await post(await sign({ sid, events }))).status).to.equal(200);
        expect((await getJson(`${childOrigin}/api/me`, first.childTokens.access_token)).status).to.equal(401);
        expect((await getJson(`${childOrigin}/api/me`, second.childTokens.access_token)).status).to.equal(200);
      });
    });

    describe('强制下线', () => {
      it('should notify child when idp admin forces user logout', async () => {
        const { childTokens } = await sso();
        expect((await getJson(`${childOrigin}/api/me`, childTokens.access_token)).status).to.equal(200);
        const response = await fetch(`${idpOrigin}/api/oidc/admin/session/revoke-user`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-user-token': 'legacy:2001' },
          body: JSON.stringify({ userId: '2001', logout: true })
        });
        expect(response.status).to.equal(200);
        expect((await getJson(`${childOrigin}/api/me`, childTokens.access_token)).status).to.equal(401);
      });
    });
  });
});
