const epochTime = date => Math.floor(date.getTime() / 1000);

/**
 * 基于 fastify-sequelize 的 oidc-provider Adapter。
 * Client 不走这里，由 create-provider 中的 client adapter 从 client 表读取。
 *
 * 退出时 end_session 要先等 back-channel 通知完才销毁 Session，期间同一 cookie 的并发请求（如子应用 401 后静默登录）
 * 已读到旧 Session，会在销毁后把它原样写回；这里记下已销毁的 Session id，拒绝写回与读取。
 */
module.exports = ({ models, Op, endedStore, sessionTTL = 0 }) => {
  const endedKey = id => `session-ended:${id}`;
  const isEnded = async (name, id) => name === 'Session' && !!endedStore && !!(await endedStore.get(endedKey(id)));
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
      if (await isEnded(this.name, id)) {
        return;
      }
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
      if (await isEnded(this.name, id)) {
        return undefined;
      }
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
      if (this.name === 'Session' && endedStore) {
        const row = await models.payload.findOne({ attributes: ['expiresAt'], where: { modelName: this.name, payloadId: id } });
        const ttl = row?.expiresAt ? Math.ceil((row.expiresAt.getTime() - Date.now()) / 1000) : sessionTTL;
        if (ttl > 0) {
          await endedStore.set(endedKey(id), 1, ttl);
        }
      }
      await models.payload.destroy({ where: { modelName: this.name, payloadId: id } });
    }

    async revokeByGrantId(grantId) {
      await models.payload.destroy({ where: { grantId } });
    }

    async findByAccountId(accountId) {
      const rows = await models.payload.findAll({ where: { modelName: this.name, accountId: String(accountId) } });
      return rows.map(toPayload).filter(Boolean);
    }

    /** 有未过期登录会话的用户，按用户聚合：[{ accountId, sessionCount, lastLoginTs }]；传 accountIds 时只在这些用户中查 */
    async findActiveAccounts({ accountIds } = {}) {
      const rows = await models.payload.findAll({
        attributes: ['accountId', 'payload'],
        where: {
          modelName: this.name,
          accountId: accountIds ? { [Op.in]: accountIds.map(String) } : { [Op.ne]: null },
          expiresAt: { [Op.gt]: new Date() }
        }
      });
      const accounts = new Map();
      for (const { accountId, payload } of rows) {
        const item = accounts.get(accountId) || { accountId, sessionCount: 0, lastLoginTs: 0 };
        item.sessionCount++;
        item.lastLoginTs = Math.max(item.lastLoginTs, payload?.loginTs || 0);
        accounts.set(accountId, item);
      }
      return Array.from(accounts.values());
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
