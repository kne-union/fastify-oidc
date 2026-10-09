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
      return pick(await serviceClient.getUserProfile(userId), PROFILE_FIELDS);
    } catch (e) {
      fastify.log.warn({ err: e, userId }, 'fastify-oidc: 获取主项目用户资料失败，使用本地镜像');
      return null;
    }
  };

  const createMirror = async (userId, profile) => {
    const model = getModel();
    const values = Object.assign({ nickname: userId }, profile, { id: userId, status: 0 });
    try {
      return await model.create(values, { hooks: false });
    } catch (e) {
      if (e.name !== 'SequelizeUniqueConstraintError') {
        throw e;
      }
      fastify.log.warn({ userId }, 'fastify-oidc: 镜像用户邮箱或手机号与本地已有用户冲突，忽略这两个字段');
      return model.create(Object.assign({}, values, { email: null, phone: null }), { hooks: false });
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
