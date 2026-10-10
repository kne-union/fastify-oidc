const crypto = require('node:crypto');
const { pick } = require('lodash');

const PROFILE_FIELDS = ['nickname', 'avatar', 'email', 'phone', 'gender', 'birthday', 'description'];
const USER_FIELDS = ['id', ...PROFILE_FIELDS, 'status'];

/**
 * central 模式：子项目保留 fastify-account 的用户表作为镜像，按 sub 即时创建 / 定期同步，
 * 保证依赖 getUserModel 关联用户表的 kne 插件照常工作。
 */
module.exports = ({ fastify, options, serviceClient }) => {
  const cache = new Map();
  const getModel = () => fastify[options.accountNamespace].models.user;

  const fetchProfile = async userId => {
    if (!serviceClient.enabled()) {
      return null;
    }
    try {
      const remote = await serviceClient.getUserProfile(userId);
      const profile = pick(remote, PROFILE_FIELDS);
      // 主项目超级管理员身份以主项目为准，升降级都同步到镜像，子项目 authenticate.admin 照常读本地 isSuperAdmin
      if (typeof remote?.isSuperAdmin === 'boolean' && getModel().rawAttributes.isSuperAdmin) {
        profile.isSuperAdmin = remote.isSuperAdmin;
      }
      return profile;
    } catch (e) {
      fastify.log.warn({ err: e, userId }, 'fastify-oidc: 获取主项目用户资料失败，使用本地镜像');
      return null;
    }
  };

  // fastify-account 的 user.userAccountId 非空：镜像用户挂一个随机密码的占位账号，central 模式下本地密码登录不可用
  const createPlaceholderAccount = async () => {
    const { userAccount } = fastify[options.accountNamespace].models;
    if (!userAccount || !getModel().rawAttributes.userAccountId) {
      return null;
    }
    return userAccount.create({ password: crypto.randomBytes(32).toString('hex'), salt: crypto.randomBytes(16).toString('hex') });
  };

  const createUser = async values => {
    const model = getModel();
    try {
      return await model.create(values, { hooks: false });
    } catch (e) {
      if (e.name !== 'SequelizeUniqueConstraintError') {
        throw e;
      }
      fastify.log.warn({ userId: values.id }, 'fastify-oidc: 镜像用户邮箱或手机号与本地已有用户冲突，忽略这两个字段');
      return model.create(Object.assign({}, values, { email: null, phone: null }), { hooks: false });
    }
  };

  const createMirror = async (userId, profile) => {
    const account = await createPlaceholderAccount();
    const values = Object.assign({ nickname: userId }, profile, { id: userId, status: 0 }, account ? { userAccountId: account.id } : {});
    try {
      const row = await createUser(values);
      await account?.update({ belongToUserId: row.id });
      return row;
    } catch (e) {
      await account?.destroy({ force: true }).catch(() => {});
      throw e;
    }
  };

  const ensure = async userId => {
    const cached = cache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.user;
    }
    const model = getModel();
    let row = await model.findByPk(userId);
    const profile = await fetchProfile(userId);
    if (!row) {
      row = await createMirror(userId, profile);
    } else if (profile) {
      await row.update(profile).catch(e => fastify.log.warn({ err: e, userId }, 'fastify-oidc: 同步镜像用户资料失败'));
    }
    const user = pick(row.get({ plain: true }), USER_FIELDS);
    user.id = String(row.id);
    cache.set(userId, { user, expiresAt: Date.now() + options.userMirrorTTL * 1000 });
    return user;
  };

  return { ensure };
};
