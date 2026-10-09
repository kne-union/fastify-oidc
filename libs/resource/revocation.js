/**
 * 内存版过期表，单实例可用；多实例部署需通过 options.revocationStore 传入共享存储（如 Redis），
 * 接口：get(key) => value | undefined，set(key, value, ttlSeconds)
 */
const createMemoryStore = () => {
  const map = new Map();
  return {
    async get(key) {
      const item = map.get(key);
      if (!item) {
        return undefined;
      }
      if (item.expiresAt <= Date.now()) {
        map.delete(key);
        return undefined;
      }
      return item.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      if (map.size > 10000) {
        const now = Date.now();
        for (const [k, v] of map) {
          if (v.expiresAt <= now) map.delete(k);
        }
      }
    }
  };
};

/**
 * 记录已登出的会话（sid）和需要强制失效的用户（sub）。
 * JWT access_token 无法真正撤销，只能在资源侧拒绝：sid 命中，或 sub 的撤销时间晚于 token 的 iat。
 */
module.exports = ({ store, ttl }) => {
  store = store || createMemoryStore();

  const revokeSession = async sid => {
    await store.set(`sid:${sid}`, Math.floor(Date.now() / 1000), ttl);
  };

  const revokeSubject = async sub => {
    await store.set(`sub:${sub}`, Math.floor(Date.now() / 1000), ttl);
  };

  const isRevoked = async payload => {
    if (payload.sid && (await store.get(`sid:${payload.sid}`))) {
      return true;
    }
    if (payload.sub) {
      const revokedAt = await store.get(`sub:${payload.sub}`);
      if (revokedAt && payload.iat <= revokedAt) {
        return true;
      }
    }
    return false;
  };

  return { revokeSession, revokeSubject, isRevoked };
};

module.exports.createMemoryStore = createMemoryStore;
