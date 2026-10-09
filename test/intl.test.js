const { expect } = require('chai');
const httpErrors = require('http-errors');
const { createApp } = require('./support/app');
const { createError } = require('../libs/utils/intl');

const USERS = [{ id: '1001', nickname: '张三', email: 'zhangsan@test.com', password: 'pwd-1', isSuperAdmin: true }];

describe('@kne/fastify-oidc 国际化', function () {
  this.timeout(30000);

  it('createError should carry messageId and fall back to zh-CN message', () => {
    const error = createError(httpErrors.Forbidden, 'scopeMissing', { scopes: 'a b' });
    expect(error.statusCode).to.equal(403);
    expect(error.messageId).to.equal('scopeMissing');
    expect(error.message).to.equal('缺少 scope: a b');
  });

  describe('registered @kne/fastify-intl', () => {
    let app;
    before(async () => {
      app = await createApp({ users: USERS, intl: {} });
    });
    after(async () => {
      await app.fastify.close();
    });

    const inject = (url, locale) => app.fastify.inject({ method: 'GET', url, headers: locale ? { 'x-user-locale': locale } : {} });

    it('should translate authenticate errors by request locale', async () => {
      const en = await inject('/api/service-only', 'en-US');
      expect(en.statusCode).to.equal(401);
      expect(en.json().message).to.equal('Missing access token');
      const zh = await inject('/api/service-only', 'zh-CN');
      expect(zh.json().message).to.equal('缺少访问令牌');
    });

    it('should fall back to fastify-intl default locale for unsupported locale', async () => {
      const res = await inject('/api/service-only', 'ja-JP');
      expect(res.json().message).to.equal('Missing access token');
    });

    it('should translate service errors thrown in controllers', async () => {
      const en = await inject('/api/oidc/interaction/unknown/details', 'en-US');
      expect(en.statusCode).to.equal(400);
      expect(en.json().message).to.equal('The login session has expired, please start the login again from the application');
      const zh = await inject('/api/oidc/interaction/unknown/details', 'zh-CN');
      expect(zh.json().message).to.equal('登录会话已失效，请从应用重新发起登录');
    });

    it('should not translate errors thrown by other packages', async () => {
      const foreign = Object.assign(new Error('用户名或密码错误'), { messageScope: '@kne/fastify-account', messageId: 'credentialsInvalid' });
      const { translator } = app.fastify.oidc;
      expect((await translator.translateError('en-US', foreign)).message).to.equal('用户名或密码错误');
      expect((await translator.translateError('en-US', createError(null, 'tokenRevoked'))).message).to.not.equal(createError(null, 'tokenRevoked').message);
    });

    it('should translate pages rendered by oidc-provider', async () => {
      const en = await inject('/oidc/session/end/success', 'en-US');
      expect(en.statusCode).to.equal(200);
      expect(en.payload).to.contain('<p>You have been logged out</p>');
      const zh = await inject('/oidc/session/end/success', 'zh-CN');
      expect(zh.payload).to.contain('<p>已退出登录</p>');
    });
  });

  describe('without @kne/fastify-intl', () => {
    let app;
    before(async () => {
      app = await createApp({ users: USERS });
    });
    after(async () => {
      await app.fastify.close();
    });

    it('should use built-in zh-CN messages', async () => {
      const res = await app.fastify.inject({ method: 'GET', url: '/api/service-only', headers: { 'x-user-locale': 'en-US' } });
      expect(res.statusCode).to.equal(401);
      expect(res.json().message).to.equal('缺少访问令牌');
    });
  });
});
