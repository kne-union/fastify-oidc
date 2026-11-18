/**
 * central 多平台：运行时 platforms[]（按 platformOrigin / issuer 唯一）。
 * 登录与验签按 token.iss 选择对应 JWKS + audience。
 */
const PLATFORM_SERVICE_FIELDS = ['serviceClientSecret', 'appCode', 'apiBase', 'serviceAudience', 'claimNamespace'];
const URL_FIELDS = ['apiBase', 'serviceAudience'];

const normalizePlatform = (item = {}) => {
  const platformOrigin = String(item.platformOrigin || '')
    .replace(/\/+$/, '')
    .trim();
  const issuer = String(item.issuer || '')
    .replace(/\/+$/, '')
    .trim();
  if (!platformOrigin || !issuer) {
    throw new Error('fastify-oidc: platform 需要 platformOrigin 与 issuer');
  }
  const platform = {
    platformOrigin,
    platformName: item.platformName || platformOrigin,
    issuer,
    audience: item.audience || null,
    spaClientId: item.spaClientId || item.clientId || null,
    serviceClientId: item.serviceClientId || null,
    jwksUri: item.jwksUri || `${issuer}/jwks`,
    status: item.status || 'paired',
    pairedAt: item.pairedAt || null
  };
  // standalone 服务该平台的用户与租户时才需要（不进 publicList）：服务 client 密钥、本应用在平台的 code、平台服务接口地址；
  // 只在传入时写入，upsert 未带这些字段时保留已有值
  PLATFORM_SERVICE_FIELDS.forEach(key => {
    if (item[key]) {
      platform[key] = URL_FIELDS.includes(key) ? String(item[key]).replace(/\/+$/, '') : String(item[key]);
    }
  });
  return platform;
};

const createPlatformsRegistry = ({ initial = [], onChange = null } = {}) => {
  let list = [];

  const setAll = (platforms = []) => {
    const next = [];
    const seen = new Set();
    for (const raw of platforms) {
      const item = normalizePlatform(raw);
      const key = item.platformOrigin.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      next.push(item);
    }
    list = next;
    if (typeof onChange === 'function') {
      onChange(list.slice());
    }
    return list.slice();
  };

  const upsert = platform => {
    const item = normalizePlatform(platform);
    const idx = list.findIndex(p => p.platformOrigin.toLowerCase() === item.platformOrigin.toLowerCase());
    if (idx >= 0) {
      list[idx] = Object.assign({}, list[idx], item);
    } else {
      list.push(item);
    }
    if (typeof onChange === 'function') {
      onChange(list.slice());
    }
    return item;
  };

  const remove = platformOrigin => {
    const key = String(platformOrigin || '')
      .replace(/\/+$/, '')
      .toLowerCase();
    const before = list.length;
    list = list.filter(p => p.platformOrigin.toLowerCase() !== key);
    if (list.length !== before && typeof onChange === 'function') {
      onChange(list.slice());
    }
    return list.length !== before;
  };

  const getAll = () => list.slice();

  const findByIssuer = issuer => {
    const key = String(issuer || '')
      .replace(/\/+$/, '')
      .toLowerCase();
    return list.find(p => p.issuer.toLowerCase() === key) || null;
  };

  const findByOrigin = platformOrigin => {
    const key = String(platformOrigin || '')
      .replace(/\/+$/, '')
      .toLowerCase();
    return list.find(p => p.platformOrigin.toLowerCase() === key) || null;
  };

  const publicList = () =>
    list
      .filter(p => p.status === 'paired')
      .map(p => ({
        platformOrigin: p.platformOrigin,
        platformName: p.platformName,
        issuer: p.issuer,
        clientId: p.spaClientId,
        audience: p.audience
      }));

  if (initial.length) {
    setAll(initial);
  }

  return { setAll, upsert, remove, getAll, findByIssuer, findByOrigin, publicList };
};

module.exports = { normalizePlatform, createPlatformsRegistry };
