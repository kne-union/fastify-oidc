const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }

  const get = async ({ sessionUid }) => {
    if (!sessionUid) {
      return null;
    }
    const item = await models.sessionTenant.findOne({ where: { sessionUid } });
    return item ? { sessionUid, accountId: item.accountId, tenantId: item.tenantId } : null;
  };

  const set = async ({ sessionUid, accountId, tenantId }) => {
    const values = { accountId: String(accountId), tenantId: String(tenantId) };
    const item = await models.sessionTenant.findOne({ where: { sessionUid } });
    if (item) {
      await item.update(values);
      return;
    }
    await models.sessionTenant.create(Object.assign({ sessionUid }, values));
  };

  const remove = async ({ sessionUid }) => {
    await models.sessionTenant.destroy({ where: { sessionUid } });
  };

  services.sessionTenant = { get, set, remove };
});
