const epochTime = date => Math.floor(date.getTime() / 1000);

/**
 * 基于 fastify-sequelize 的 oidc-provider Adapter。
 * Client 不走这里，由 create-provider 中的 client adapter 从 client 表读取。
 */
module.exports = ({ models }) => {
  const toPayload = row => {
    if (!row) {
      return undefined;
    }
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      return undefined;
    }
    const payload = Object.assign({}, row.payload);
    if (row.consumedAt) {
      payload.consumed = epochTime(row.consumedAt);
    }
    return payload;
  };

  return class SequelizeAdapter {
    constructor(name) {
      this.name = name;
    }

    async upsert(id, payload, expiresIn) {
      const values = {
        payload,
        grantId: payload.grantId || null,
        userCode: payload.userCode || null,
        uid: payload.uid || null,
        accountId: payload.accountId || null,
        expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
        consumedAt: payload.consumed ? new Date(payload.consumed * 1000) : null
      };
      const row = await models.payload.findOne({ where: { modelName: this.name, payloadId: id } });
      if (row) {
        await row.update(values);
        return;
      }
      await models.payload.create(Object.assign({ modelName: this.name, payloadId: id }, values));
    }

    async find(id) {
      return toPayload(await models.payload.findOne({ where: { modelName: this.name, payloadId: id } }));
    }

    async findByUid(uid) {
      return toPayload(await models.payload.findOne({ where: { modelName: this.name, uid } }));
    }

    async findByUserCode(userCode) {
      return toPayload(await models.payload.findOne({ where: { modelName: this.name, userCode } }));
    }

    async consume(id) {
      await models.payload.update({ consumedAt: new Date() }, { where: { modelName: this.name, payloadId: id } });
    }

    async destroy(id) {
      await models.payload.destroy({ where: { modelName: this.name, payloadId: id } });
    }

    async revokeByGrantId(grantId) {
      await models.payload.destroy({ where: { grantId } });
    }

    async findByAccountId(accountId) {
      const rows = await models.payload.findAll({ where: { modelName: this.name, accountId: String(accountId) } });
      return rows.map(toPayload).filter(Boolean);
    }

    async findGrantIdsByAccountId(accountId) {
      const rows = await models.payload.findAll({
        attributes: ['payloadId'],
        where: { modelName: 'Grant', accountId: String(accountId) }
      });
      return rows.map(row => row.payloadId);
    }
  };
};
