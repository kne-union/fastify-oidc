const { expect } = require('chai');
const { createApp } = require('./support/app');
const { createBrowser, discover, login, decodeJwt } = require('./support/http');

const USERS = [
  { id: '2001', nickname: '张三', email: 'zhangsan@test.com', phone: '13800138000', password: 'pwd-1' },
  { id: '2002', nickname: '无手机', email: 'nophone@test.com', password: 'pwd-2' }
];

const MEMBERSHIPS = {
  2001: [
    { id: 'tu-a', tenantId: 'tenant-a', name: '租户 A' },
    { id: 'tu-b', tenantId: 'tenant-b', name: '租户 B' },
    { id: 'tu-c', tenantId: 'tenant-c', name: '租户 C' }
  ],
  2002: [{ id: 'tu-d', tenantId: 'tenant-a', name: '租户 A' }]
};

describe('@kne/fastify-oidc 租户短信 MFA', function () {
  this.timeout(30000);
  let app, as, clientId, redirectUri, audience, mfa;

  const lastCode = () => app.fastify.account.sentCodes[app.fastify.account.sentCodes.length - 1];

  // mfaHandler(base, details) 自定义 mfa 步骤，默认发码后用正确验证码通过
  const interaction = (browser, { credentials, tenantId, mfaHandler } = {}) => {
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
      if (details.prompt.name === 'mfa') {
        handler.mfa = details.mfa;
        if (mfaHandler) {
          return mfaHandler(base, details, browser);
        }
        await browser.json(`${base}/mfa/send`);
        return (await browser.json(`${base}/mfa/verify`, { code: lastCode().code })).redirectTo;
      }
      if (details.prompt.name === 'consent') {
        return (await browser.json(`${base}/confirm`)).redirectTo;
      }
      throw new Error(`unexpected prompt ${details.prompt.name}`);
    };
    handler.steps = steps;
    return handler;
  };

  const loginAs = async ({ browser = createBrowser(), extra, ...rest } = {}) => {
    const onInteraction = interaction(browser, rest);
    const tokens = await login({ as, browser, clientId, redirectUri, resource: audience, extra, onInteraction });
    return { tokens, browser, onInteraction };
  };

  const zhangsan = { email: 'zhangsan@test.com', password: 'pwd-1' };
  const tenantIdOf = tokens => decodeJwt(tokens.access_token)[`${app.origin}/tenant_id`];

  before(async () => {
    mfa = { 'tenant-a': { enabled: true, maxAge: 3600 }, 'tenant-c': { enabled: true, maxAge: 3600 } };
    app = await createApp({ users: USERS, tenant: { options: { memberships: MEMBERSHIPS, mfa } } });
    clientId = 'oidc-spa';
    redirectUri = `${app.origin}/oidc-callback`;
    audience = `${app.origin}/api`;
    as = await discover(`${app.origin}/oidc`);
  });

  after(async () => {
    await app.fastify.close();
  });

  it('租户未开启 MFA 时不出现 mfa 步骤', async () => {
    const { tokens, onInteraction } = await loginAs({ credentials: zhangsan, tenantId: 'tenant-b' });
    expect(onInteraction.steps).to.deep.equal(['login', 'tenant']);
    expect(tenantIdOf(tokens)).to.equal('tenant-b');
  });

  it('开启 MFA 的租户必须短信验证，通过后 amr 含 sms / mfa 且 auth_time 不变', async () => {
    const first = await loginAs({ credentials: zhangsan, tenantId: 'tenant-b', extra: { max_age: '3600' } });
    const authTime = decodeJwt(first.tokens.id_token).auth_time;
    expect(authTime).to.be.a('number');
    await new Promise(resolve => setTimeout(resolve, 1100));
    const sentBefore = app.fastify.account.sentCodes.length;
    const { tokens, onInteraction } = await loginAs({
      browser: first.browser,
      extra: { max_age: '3600', tenant_id: 'tenant-a' },
      mfaHandler: async (base, details, browser) => {
        expect(details.mfa).to.include({ method: 'sms', tenantId: 'tenant-a', maxAge: 3600, phoneMissing: false, phoneMasked: '138****8000', resendAfter: 0 });
        const sent = await browser.json(`${base}/mfa/send`);
        expect(sent).to.include({ phoneMasked: '138****8000', expiresIn: 300, resendAfter: 60 });
        expect(lastCode()).to.include({ name: '13800138000', type: 6 });
        const again = await browser.json(`${base}/mfa/send`).catch(e => e);
        expect(again.statusCode).to.equal(400);
        const wrong = await browser.json(`${base}/mfa/verify`, { code: '000000' }).catch(e => e);
        expect(wrong.statusCode).to.equal(400);
        expect(wrong.data.message).to.equal('验证码不正确');
        return (await browser.json(`${base}/mfa/verify`, { code: lastCode().code })).redirectTo;
      }
    });
    expect(onInteraction.steps).to.deep.equal(['mfa']);
    expect(app.fastify.account.sentCodes.length).to.equal(sentBefore + 1);
    expect(tenantIdOf(tokens)).to.equal('tenant-a');
    const idToken = decodeJwt(tokens.id_token);
    expect(idToken.amr).to.deep.equal(['pwd', 'sms', 'mfa']);
    expect(idToken.auth_time).to.equal(authTime);
  });

  it('maxAge 内同一会话复用验证结果（含切换到另一个开启 MFA 的租户），超过后重新要求验证', async () => {
    const { browser, onInteraction } = await loginAs({ credentials: zhangsan, tenantId: 'tenant-a' });
    expect(onInteraction.steps).to.deep.equal(['login', 'tenant', 'mfa']);
    const reuse = await loginAs({ browser, extra: { tenant_id: 'tenant-c' } });
    expect(reuse.onInteraction.steps).to.deep.equal([]);
    expect(tenantIdOf(reuse.tokens)).to.equal('tenant-c');

    mfa['tenant-c'].maxAge = 0;
    try {
      const expired = await loginAs({ browser, extra: { tenant_id: 'tenant-c' } });
      expect(expired.onInteraction.steps).to.deep.equal(['mfa']);
      expect(tenantIdOf(expired.tokens)).to.equal('tenant-c');
    } finally {
      mfa['tenant-c'].maxAge = 3600;
    }
  });

  it('未验证时 prompt=none 静默切到开启 MFA 的租户返回 interaction_required', async () => {
    const { browser } = await loginAs({ credentials: zhangsan, tenantId: 'tenant-b' });
    const error = await loginAs({ browser, extra: { prompt: 'none', tenant_id: 'tenant-a' } }).catch(e => e);
    expect(error.error).to.equal('interaction_required');
  });

  it('账号没有手机号时以 access_denied 结束授权', async () => {
    const error = await loginAs({
      credentials: { email: 'nophone@test.com', password: 'pwd-2' },
      mfaHandler: async (base, details, browser) => {
        expect(details.mfa.phoneMissing).to.equal(true);
        const result = await browser.json(`${base}/mfa/send`);
        expect(result.redirectTo).to.be.a('string');
        return result.redirectTo;
      }
    }).catch(e => e);
    expect(error.error).to.equal('access_denied');
    expect(error.error_description).to.equal('该租户要求短信验证，但账号未绑定手机号，请联系管理员');
  });

  it('验证码错误次数过多后锁定，验证码只能使用一次', async () => {
    const { services } = app.fastify.oidc;
    await services.mfa.sendCode({ interactionUid: 'uid-lock', accountId: '2001', phone: '13800138000' });
    const code = lastCode().code;
    for (let i = 1; i < 5; i++) {
      const error = await services.mfa.verifyCode({ interactionUid: 'uid-lock', accountId: '2001', code: '000000' }).catch(e => e);
      expect(error.messageId).to.equal('mfaCodeInvalid');
    }
    const locked = await services.mfa.verifyCode({ interactionUid: 'uid-lock', accountId: '2001', code: '000000' }).catch(e => e);
    expect(locked.messageId).to.equal('mfaTooManyAttempts');
    const afterLock = await services.mfa.verifyCode({ interactionUid: 'uid-lock', accountId: '2001', code }).catch(e => e);
    expect(afterLock.messageId).to.equal('mfaTooManyAttempts');

    await services.mfa.sendCode({ interactionUid: 'uid-once', accountId: '2001', phone: '13800138000' });
    const once = lastCode().code;
    expect(await services.mfa.verifyCode({ interactionUid: 'uid-once', accountId: '2001', code: once })).to.deep.equal({ method: 'sms' });
    const reused = await services.mfa.verifyCode({ interactionUid: 'uid-once', accountId: '2001', code: once }).catch(e => e);
    expect(reused.messageId).to.equal('mfaCodeInvalid');
    const otherAccount = await services.mfa.verifyCode({ interactionUid: 'uid-lock', accountId: '2002', code }).catch(e => e);
    expect(otherAccount.messageId).to.equal('mfaCodeInvalid');
  });

  it('验证码过期后不能使用', async () => {
    const { services, models } = app.fastify.oidc;
    await services.mfa.sendCode({ interactionUid: 'uid-expired', accountId: '2001', phone: '13800138000' });
    await models.mfaChallenge.update({ expiresAt: new Date(Date.now() - 1000) }, { where: { interactionUid: 'uid-expired' } });
    const error = await services.mfa.verifyCode({ interactionUid: 'uid-expired', accountId: '2001', code: lastCode().code }).catch(e => e);
    expect(error.messageId).to.equal('mfaCodeExpired');
  });
});
