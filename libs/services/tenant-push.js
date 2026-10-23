const fp = require('fastify-plugin');
const crypto = require('node:crypto');
const { SignJWT, importJWK } = require('jose');
const { TENANT_SYNC_EVENT } = require('../utils/app-permissions');

const NOTIFY_TYPES = ['tenant', 'tenant-permission'];

/**
 * 宿主订阅 fastify-tenant 变更，通知 independent 子应用回拉租户快照。
 * 导入 / 同步成员时每个成员都会触发一次事件，按租户防抖合并；推送尽力而为，失败由子应用过期拉取兜底
 */
module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  if (options.runtime.tenantRole !== 'host') {
    return;
  }
  const pending = new Map();
  const running = new Set();
  let unsubscribe = null;

  const track = promise => {
    running.add(promise);
    promise.finally(() => running.delete(promise));
    return promise;
  };

  const signToken = async ({ app, tenantId }) => {
    const { keys } = await services.key.getPrivateJwks();
    const jwk = keys[0];
    return new SignJWT({ tenant_id: String(tenantId), events: { [TENANT_SYNC_EVENT]: {} } })
      .setProtectedHeader({ alg: jwk.alg, kid: jwk.kid, typ: 'tenant-sync+jwt' })
      .setIssuer(options.runtime.issuer)
      .setAudience(app.serviceClientId)
      .setIssuedAt()
      .setExpirationTime(`${options.tenantSyncTokenTTL}s`)
      .setJti(crypto.randomUUID())
      .sign(await importJWK(jwk, jwk.alg));
  };

  const pushTo = async ({ app, tenantId }) => {
    const response = await fetch(app.tenantSyncUri, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tenant_sync_token: await signToken({ app, tenantId }) }),
      signal: AbortSignal.timeout(options.tenantSyncTimeout)
    });
    if (!response.ok) {
      throw new Error(`tenant-sync 通知返回 ${response.status}`);
    }
  };

  // 租户状态或租户权限变化时可能是刚关闭了应用，未开通也要通知子应用把托管租户置为 closed
  const push = async (tenantId, types = new Set(NOTIFY_TYPES)) => {
    const apps = services.app.listOpen().filter(app => app.tenantMode === 'independent' && app.tenantSyncUri);
    if (!apps.length) {
      return;
    }
    const { identity } = fastify[options.name].idp;
    const mayHaveClosed = NOTIFY_TYPES.some(type => types.has(type));
    for (const app of apps) {
      try {
        if (!mayHaveClosed && !(await identity.isAppEnabled(tenantId, app.code))) {
          continue;
        }
        await pushTo({ app, tenantId });
      } catch (err) {
        fastify.log.warn({ err, tenantId, app: app.code }, 'fastify-oidc: 推送租户变更通知失败');
      }
    }
  };

  // 应用被停用 / 启用 / 删除：通知开通过它的租户（租户权限里仍有 apps:<code>），子应用回拉后关闭或恢复托管租户
  const notifyApp = app => track(notifyAppTenants(app));

  const notifyAppTenants = async app => {
    const tenant = options.getTenant();
    if (!tenant || app.tenantMode !== 'independent' || !app.tenantSyncUri) {
      return;
    }
    const { identity } = fastify[options.name].idp;
    const rows = await tenant.models.tenant.findAll({ attributes: ['id'] });
    for (const { id } of rows) {
      const tenantId = String(id);
      try {
        if (await identity.isAppEnabled(tenantId, app.code)) {
          await pushTo({ app, tenantId });
        }
      } catch (err) {
        fastify.log.warn({ err, tenantId, app: app.code }, 'fastify-oidc: 推送应用状态变化通知失败');
      }
    }
  };

  const schedule = ({ tenantId, type } = {}) => {
    if (!tenantId) {
      return;
    }
    const key = String(tenantId);
    const entry = pending.get(key) || { types: new Set() };
    entry.types.add(type);
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      pending.delete(key);
      track(push(key, entry.types));
    }, options.tenantSyncDebounce);
    entry.timer.unref?.();
    pending.set(key, entry);
  };

  const start = () => {
    const tenant = options.getTenant();
    if (!unsubscribe && tenant && typeof tenant.onChange === 'function') {
      unsubscribe = tenant.onChange(schedule);
    }
  };

  const stop = () => {
    pending.forEach(entry => clearTimeout(entry.timer));
    pending.clear();
    unsubscribe?.();
    unsubscribe = null;
  };

  // 进行中的推送会让子应用回调宿主，关闭前等它们结束，避免宿主 close 挂起
  const whenIdle = () => Promise.allSettled([...running]);

  fastify.addHook('onClose', async () => {
    stop();
    await whenIdle();
  });

  services.tenantPush = { start, stop, schedule, push, notifyApp, whenIdle, signToken };
});
