const fp = require('fastify-plugin');
const crypto = require('node:crypto');
const httpErrors = require('http-errors');
const { deriveKey } = require('../utils/crypto');
const { createError } = require('../utils/intl');

const { BadRequest } = httpErrors;

const maskPhone = phone => {
  const value = String(phone);
  return value.length > 7 ? `${value.slice(0, 3)}****${value.slice(-4)}` : `****${value.slice(-2)}`;
};

/**
 * OIDC 交互中的短信 MFA：验证码绑定 interaction、只能用一次、限制错误次数和重发间隔；
 * 通过后按会话记录验证时间，供 mfa prompt 按租户 maxAge 判断是否复用
 */
module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { codeTTL, maxAttempts, resendInterval, smsType } = options.mfa;
  const hmacKey = deriveKey(options.keyEncryptionSecret, 'mfa');

  const hashCode = (interactionUid, code) =>
    crypto
      .createHmac('sha256', hmacKey)
      .update(`${interactionUid}:${String(code).trim()}`)
      .digest('base64url');

  const sameHash = (a, b) => {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  };

  const getSessionVerifiedAt = async ({ sessionUid, accountId }) => {
    if (!sessionUid) {
      return null;
    }
    const item = await models.sessionMfa.findOne({ where: { sessionUid } });
    return item && item.accountId === String(accountId) ? item.verifiedAt : null;
  };

  const markSession = async ({ sessionUid, accountId, method }) => {
    const values = { accountId: String(accountId), method, verifiedAt: new Date() };
    const item = await models.sessionMfa.findOne({ where: { sessionUid } });
    if (item) {
      await item.update(values);
      return;
    }
    await models.sessionMfa.create(Object.assign({ sessionUid }, values));
  };

  const removeSession = async ({ sessionUid }) => {
    await models.sessionMfa.destroy({ where: { sessionUid } });
  };

  const resendAfter = challenge => (challenge ? Math.max(Math.ceil((new Date(challenge.sentAt).getTime() + resendInterval * 1000 - Date.now()) / 1000), 0) : 0);

  const getChallengeState = async ({ interactionUid }) => resendAfter(await models.mfaChallenge.findOne({ where: { interactionUid } }));

  const sendCode = async ({ interactionUid, accountId, phone }) => {
    const account = fastify[options.accountNamespace];
    if (typeof account?.services?.account?.sendVerificationCode !== 'function') {
      throw new Error('fastify-oidc: 短信 MFA 需要 @kne/fastify-account 提供 services.account.sendVerificationCode');
    }
    const existing = await models.mfaChallenge.findOne({ where: { interactionUid } });
    const wait = resendAfter(existing);
    if (wait > 0) {
      throw createError(BadRequest, 'mfaResendTooFrequent', { seconds: wait });
    }
    const code = await account.services.account.sendVerificationCode({ name: phone, type: smsType, options: { purpose: 'mfa' } });
    const now = Date.now();
    const values = {
      accountId: String(accountId),
      method: 'sms',
      codeHash: hashCode(interactionUid, code),
      attempts: 0,
      status: 'pending',
      sentAt: new Date(now),
      expiresAt: new Date(now + codeTTL * 1000)
    };
    if (existing) {
      await existing.update(values);
    } else {
      await models.mfaChallenge.create(Object.assign({ interactionUid }, values));
    }
    return { phoneMasked: maskPhone(phone), expiresIn: codeTTL, resendAfter: resendInterval };
  };

  const verifyCode = async ({ interactionUid, accountId, code }) => {
    const challenge = await models.mfaChallenge.findOne({ where: { interactionUid } });
    if (!challenge || challenge.accountId !== String(accountId) || challenge.status === 'verified') {
      throw createError(BadRequest, 'mfaCodeInvalid');
    }
    if (challenge.status === 'locked') {
      throw createError(BadRequest, 'mfaTooManyAttempts');
    }
    if (new Date(challenge.expiresAt).getTime() < Date.now()) {
      throw createError(BadRequest, 'mfaCodeExpired');
    }
    if (!sameHash(challenge.codeHash, hashCode(interactionUid, code))) {
      const attempts = challenge.attempts + 1;
      const locked = attempts >= maxAttempts;
      await models.mfaChallenge.update({ attempts, status: locked ? 'locked' : 'pending' }, { where: { id: challenge.id, status: 'pending' } });
      throw createError(BadRequest, locked ? 'mfaTooManyAttempts' : 'mfaCodeInvalid');
    }
    // 条件更新保证并发提交同一个验证码时只有一次成功
    const [count] = await models.mfaChallenge.update({ status: 'verified' }, { where: { id: challenge.id, status: 'pending' } });
    if (count === 0) {
      throw createError(BadRequest, 'mfaCodeInvalid');
    }
    return { method: challenge.method };
  };

  const cleanup = async ({ olderThan }) => {
    const { Op } = fastify.sequelize.Sequelize;
    await models.mfaChallenge.destroy({ where: { expiresAt: { [Op.lt]: new Date() } } });
    await models.sessionMfa.destroy({ where: { updatedAt: { [Op.lt]: olderThan } } });
  };

  services.mfa = { maskPhone, getSessionVerifiedAt, markSession, removeSession, getChallengeState, sendCode, verifyCode, cleanup };
});
