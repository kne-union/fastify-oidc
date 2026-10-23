/**
 * 子应用启动时把权限树注册到宿主应用中心；宿主不可用时退避重试，不阻塞启动。
 * 宿主按 permissionsHash 比对，权限树没变化时不会重建宿主权限树
 */
module.exports = ({ fastify, options, serviceClient }) => {
  const { runtime } = options;
  let timer = null;
  let stopped = false;
  let firstAttempt = Promise.resolve(null);
  const state = { registered: false, result: null, lastError: null };

  const getPermissions = () => {
    const { app } = runtime;
    if (app.permissions) {
      return app.permissions;
    }
    return (app.tenantMode === 'independent' && options.getTenant()?.permissions) || { modules: [] };
  };

  const register = async () => {
    const { app } = runtime;
    const result = await serviceClient.registerApp({
      code: app.code,
      name: app.name,
      description: app.description,
      tenantMode: app.tenantMode,
      clientId: runtime.clientId,
      resource: runtime.audience,
      permissions: getPermissions(),
      tenantSyncUri: app.tenantSyncUri
    });
    Object.assign(state, { registered: true, result, lastError: null });
    return result;
  };

  const start = () => {
    if (!runtime.app) {
      return firstAttempt;
    }
    if (!serviceClient.enabled()) {
      fastify.log.warn('fastify-oidc: 配置了 app 但未配置 serviceClient，无法向宿主注册权限');
      return firstAttempt;
    }
    let attempt = 0;
    const run = async () => {
      if (stopped) {
        return null;
      }
      try {
        return await register();
      } catch (err) {
        state.lastError = err;
        // 宿主明确拒绝（如 appCodeTaken、参数非法、未授权 scope）重试也不会成功，停止并报错，修正配置后重启
        const status = err.upstreamStatus;
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          fastify.log.error({ err, status }, 'fastify-oidc: 宿主拒绝注册应用，已停止重试');
          return null;
        }
        const delay = Math.min(options.appRegisterRetryMax * 1000, 1000 * 2 ** attempt++);
        fastify.log.warn({ err, delay }, 'fastify-oidc: 向宿主注册应用失败，稍后重试');
        timer = setTimeout(run, delay);
        timer.unref?.();
        return null;
      }
    };
    firstAttempt = run();
    return firstAttempt;
  };

  const stop = () => {
    stopped = true;
    clearTimeout(timer);
  };

  return { start, stop, register, whenStarted: () => firstAttempt, getState: () => Object.assign({}, state) };
};
