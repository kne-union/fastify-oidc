const { mapTenantImages } = require('../utils/tenant-images');

const FAILURE_RETRY_MS = 30 * 1000;
const FILE_SOURCE = 'oidcHostFileSource';

/**
 * independent 子应用：回拉宿主租户快照与成员，写入本地 fastify-tenant 托管租户。
 * 同一租户的同步串行执行，进行中再收到通知只标记一次重跑；过期拉取在后台进行，不阻塞请求
 */
module.exports = ({ fastify, options, serviceClient, userMirror }) => {
  const { runtime } = options;
  const running = new Map();
  const fresh = new Map();
  const ttl = () => options.tenantSyncTTL * 1000;
  const managed = () => options.getTenant().services.managed;
  const fetchMembers = async tenantId => {
    const members = [];
    const fileUrls = {};
    for (let currentPage = 1; ; currentPage++) {
      const { pageData = [], totalCount = 0, fileUrls: pageFileUrls } = await serviceClient.getTenantMembers({ tenantId, currentPage, perPage: options.tenantSyncPageSize });
      members.push(...pageData);
      Object.assign(fileUrls, pageFileUrls);
      if (!pageData.length || members.length >= totalCount) {
        return { members, fileUrls };
      }
    }
  };

  // 成员关联的是镜像用户：先确保镜像存在；宿主租户内没有单独头像时用镜像用户已拷到本地的头像
  const mirrorMembers = async members => {
    for (const member of members) {
      try {
        const user = await userMirror.ensure(String(member.userId));
        member.userAvatar = user.avatar || null;
      } catch (err) {
        member.userAvatar = null;
        fastify.log.warn({ err, userId: member.userId }, 'fastify-oidc: 同步租户成员时创建镜像用户失败');
      }
    }
    return members;
  };

  /**
   * 宿主文件 id 在子应用无法解析：按宿主给出的地址拷到本地文件库，返回 { 宿主 id: 本地 id }。
   * 上次同步的映射记在托管租户 options.managedBy.files，宿主文件不变且本地文件还在就不再下载；本地没有文件库时返回 null
   */
  const mirrorFiles = async (hostTenantId, fileUrls) => {
    const files = fastify[options.fileNamespace]?.services;
    if (typeof files?.uploadFromUrl !== 'function') {
      return null;
    }
    const local = await managed().findByHostTenantId({ issuer: runtime.issuer, hostTenantId });
    const previous = local?.options?.managedBy?.files || {};
    const mapping = {};
    for (const [source, url] of Object.entries(fileUrls)) {
      const current = previous[source];
      if (current && (await Promise.resolve(files.getFileInstance({ id: current })).catch(() => null))) {
        mapping[source] = current;
        continue;
      }
      try {
        mapping[source] = String((await files.uploadFromUrl({ url, options: { [FILE_SOURCE]: source } })).id);
      } catch (err) {
        fastify.log.warn({ err, source }, 'fastify-oidc: 拷贝宿主租户图片失败');
      }
    }
    return mapping;
  };

  const localizeFiles = async (hostTenantId, snapshot, members, memberFileUrls) => {
    const mapping = await mirrorFiles(hostTenantId, Object.assign({}, snapshot.fileUrls, memberFileUrls));
    const resolve = source => (mapping ? mapping[source] || null : source);
    const { fileUrls, ...rest } = snapshot;
    return {
      snapshot: Object.assign(rest, { tenant: mapTenantImages(snapshot.tenant, resolve) }, mapping ? { files: mapping } : {}),
      members: members.map(({ userAvatar, ...member }) => Object.assign(member, { avatar: (member.avatar && resolve(member.avatar)) || userAvatar }))
    };
  };

  // 宿主已删除租户时快照只有 id：沿用本地托管租户名关闭它，本地没有则无需处理
  const resolveRemoved = async (hostTenantId, snapshot) => {
    const local = await managed().findByHostTenantId({ issuer: runtime.issuer, hostTenantId });
    return local ? Object.assign({}, snapshot, { tenant: Object.assign({}, snapshot.tenant, { name: local.name }) }) : null;
  };

  const runOnce = async hostTenantId => {
    let snapshot = await serviceClient.getTenantSnapshot({ tenantId: hostTenantId });
    if (snapshot.removed) {
      snapshot = await resolveRemoved(hostTenantId, snapshot);
      if (!snapshot) {
        fresh.set(hostTenantId, { tenantId: null, syncedAt: Date.now() });
        return null;
      }
    }
    const { members: hostMembers, fileUrls: memberFileUrls } = snapshot.enabled ? await fetchMembers(hostTenantId) : { members: [], fileUrls: {} };
    const localized = await localizeFiles(hostTenantId, snapshot, await mirrorMembers(hostMembers), memberFileUrls);
    const tenant = await managed().applySnapshot({ issuer: runtime.issuer, snapshot: Object.assign(localized.snapshot, { members: localized.members }) });
    fresh.set(hostTenantId, { tenantId: tenant && snapshot.enabled ? String(tenant.id) : null, syncedAt: Date.now() });
    return tenant;
  };

  const sync = hostTenantId => {
    const key = String(hostTenantId);
    const current = running.get(key);
    if (current) {
      current.rerun = true;
      return current.promise;
    }
    const entry = { rerun: false };
    entry.promise = (async () => {
      try {
        let result;
        do {
          entry.rerun = false;
          result = await runOnce(key);
        } while (entry.rerun);
        return result;
      } finally {
        running.delete(key);
      }
    })();
    running.set(key, entry);
    return entry.promise;
  };

  const syncInBackground = key =>
    sync(key).catch(err => {
      fastify.log.warn({ err, hostTenantId: key }, 'fastify-oidc: 同步宿主租户失败');
      return null;
    });

  /**
   * 返回宿主租户对应的本地托管租户 id（未开通 / 拉取失败为 null）。
   * 本地还没有时同步拉取；已过 tenantSyncTTL 时后台刷新，先用本地已有数据
   */
  const ensureFresh = async hostTenantId => {
    const key = String(hostTenantId);
    let cached = fresh.get(key);
    if (!cached) {
      const local = await managed().findByHostTenantId({ issuer: runtime.issuer, hostTenantId: key });
      if (local) {
        cached = { tenantId: local.status === 'open' ? String(local.id) : null, syncedAt: Date.parse(local.options?.managedBy?.syncedAt) || 0 };
        fresh.set(key, cached);
      }
    }
    if (!cached) {
      try {
        await sync(key);
        return fresh.get(key)?.tenantId || null;
      } catch (err) {
        fastify.log.warn({ err, hostTenantId: key }, 'fastify-oidc: 首次同步宿主租户失败');
        fresh.set(key, { tenantId: null, syncedAt: Date.now() - ttl() + FAILURE_RETRY_MS });
        return null;
      }
    }
    if (Date.now() - cached.syncedAt >= ttl() && !running.has(key)) {
      cached.syncedAt = Date.now();
      syncInBackground(key);
    }
    return cached.tenantId;
  };

  const whenIdle = async hostTenantId => {
    const entry = running.get(String(hostTenantId));
    return entry ? entry.promise.catch(() => null) : null;
  };

  const close = () => Promise.allSettled([...running.values()].map(entry => entry.promise));

  return { sync, syncInBackground, ensureFresh, whenIdle, close };
};
