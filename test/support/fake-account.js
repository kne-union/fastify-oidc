const fp = require('fastify-plugin');
const httpErrors = require('http-errors');

/**
 * 模拟 @kne/fastify-account 的最小形态：user 模型、getUser、verifyCredentials、authenticate
 * users: [{ id, nickname, email, phone, password, status, isSuperAdmin }]
 */
module.exports = fp(
  async (fastify, { users = [], getUserAuthenticate } = {}) => {
    const models = Object.assign(
      await fastify.sequelize.addModels(
        ({ DataTypes, definePrimaryType }) => ({
          name: 'user',
          model: {
            nickname: DataTypes.STRING,
            avatar: DataTypes.STRING,
            email: { type: DataTypes.STRING, unique: true },
            phone: { type: DataTypes.STRING, unique: true },
            userAccountId: definePrimaryType('userAccountId', { allowNull: false }),
            gender: DataTypes.STRING,
            birthday: DataTypes.DATE,
            description: DataTypes.TEXT,
            isSuperAdmin: DataTypes.BOOLEAN,
            status: { type: DataTypes.INTEGER, defaultValue: 0 }
          }
        }),
        { prefix: 't_account_' }
      ),
      await fastify.sequelize.addModels(
        ({ DataTypes, definePrimaryType }) => ({
          name: 'userAccount',
          model: {
            password: { type: DataTypes.STRING, allowNull: false },
            salt: { type: DataTypes.STRING, allowNull: false },
            belongToUserId: definePrimaryType('belongToUserId')
          }
        }),
        { prefix: 't_account_' }
      )
    );
    const passwords = new Map(users.map(user => [String(user.id), user.password]));

    const checkIsSuperAdmin = async ({ id }) => (await models.user.findByPk(id))?.isSuperAdmin === true;

    const getUser = async ({ id }) => {
      const user = await models.user.findByPk(id);
      if (!user) {
        throw new Error('用户不存在');
      }
      return Object.assign(user.get({ plain: true }), { id: String(user.id) });
    };

    const verifyCredentials = async ({ type = 'email', email, phone, password }) => {
      const where = type === 'phone' ? { phone } : { email };
      const user = await models.user.findOne({ where });
      if (!user || passwords.get(String(user.id)) !== password) {
        throw new Error('用户名或密码错误');
      }
      if (![0, 1].includes(user.status)) {
        return { status: user.status };
      }
      return { status: user.status, user: Object.assign(user.get({ plain: true }), { id: String(user.id) }) };
    };

    const tokenUser = async request => {
      const token = request.headers['x-user-token'];
      if (!token || !token.startsWith('legacy:')) {
        throw new httpErrors.Unauthorized('身份认证失败');
      }
      request.authenticatePayload = { id: token.slice('legacy:'.length) };
      request.userInfo = await getUser(request.authenticatePayload);
    };

    fastify.decorate('account', {
      models,
      services: { user: { getUser }, account: { verifyCredentials }, admin: { checkIsSuperAdmin } },
      authenticate: {
        user: async request => (getUserAuthenticate ? getUserAuthenticate()(request) : tokenUser(request)),
        tokenUser,
        admin: async request => {
          if (!(await checkIsSuperAdmin({ id: request.userInfo?.id }))) {
            throw new httpErrors.Unauthorized('需要超级管理员权限');
          }
        }
      },
      seed: async () => {
        for (const { password, isSuperAdmin, ...user } of users) {
          const account = await models.userAccount.create({ password: 'hash', salt: 'salt' });
          await models.user.create(Object.assign({ status: 0 }, user, { id: String(user.id), userAccountId: account.id, isSuperAdmin: isSuperAdmin === true }), {
            hooks: false
          });
        }
      }
    });
  },
  { name: 'fastify-user' }
);
