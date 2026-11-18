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
 * JWT access_token 无法真正撤销，只能在资源侧拒绝：sid 命中，或 sub 的撤销时间不早于 token 的签发时间。
 *
 * 签发时间的精度：标准 iat 只有秒，同一秒内「先吊销、后签发」的令牌与「先签发、后吊销」的令牌无法区分，
 * 若按秒比较会把刚签发的有效令牌误拒。IdP 签发的令牌带毫秒级签发时间 claim（issuedAtMsClaim），
 * 吊销同时记毫秒时间：两边都有毫秒信息时按毫秒精确比较；令牌没有该 claim（旧版 IdP、外部签发）
 * 或吊销记录没有毫秒时间（旧版进程写入）时，退回按秒比较（同一秒内保守地视为已吊销）。
 */
module.exports = ({ store, ttl, issuedAtMsClaim }) => {
  store = store || createMemoryStore();

  const revokeSession = async sid => {
    await store.set(`sid:${sid}`, Math.floor(Date.now() / 1000), ttl);
  };

  const revokeSubject = async sub => {
    const revokedAtMs = Date.now();
    await store.set(`sub:${sub}`, Math.floor(revokedAtMs / 1000), ttl);
    await store.set(`sub-ms:${sub}`, revokedAtMs, ttl);
  };

  const isRevoked = async payload => {
    if (payload.sid && (await store.get(`sid:${payload.sid}`))) {
      return true;
    }
    if (payload.sub) {
      const issuedAtMs = issuedAtMsClaim ? Number(payload[issuedAtMsClaim]) : NaN;
      if (Number.isFinite(issuedAtMs)) {
        const revokedAtMs = Number(await store.get(`sub-ms:${payload.sub}`));
        if (revokedAtMs) {
          return issuedAtMs <= revokedAtMs;
        }
      }
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
