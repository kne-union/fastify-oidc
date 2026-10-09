const { deriveKey } = require('../utils/crypto');
const { fillGrantFromRequest } = require('./grant-helpers');
const tokenExchange = require('./grants/token-exchange');

const instantiate = (Adapter, name) => (Adapter.prototype ? new Adapter(name) : Adapter(name));

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

/**
 * 生成 oidc-provider 实例。每次密钥轮换后会重新调用本方法得到新实例。
 */
module.exports = async ({ fastify, options, identity, translator, jwks, getLocalJWKS, PayloadAdapter }) => {
  const { default: Provider, interactionPolicy, errors } = await import('oidc-provider');
  const { services } = fastify[options.name];
  const { runtime } = options;
  const { claims } = runtime;
  const t = (ctx, messageId, messageValues) => translator.t(ctx?.req?.kneOidcLocale, messageId, messageValues);

  const clientAdapter = {
    find: id => services.client.findForProvider(id),
    upsert: async () => {
      throw new Error('client 由 fastify-oidc 管理接口维护，不支持动态注册');
    },
    destroy: async () => {}
  };
  const adapters = new Map();
  const getAdapter = name => {
    if (name === 'Client') {
      return clientAdapter;
    }
    if (!adapters.has(name)) {
      adapters.set(name, instantiate(PayloadAdapter, name));
    }
    return adapters.get(name);
  };

  const resourceIncludePermissions = new Map();
  const includePermissions = resourceServer => {
    const value = resourceServer && resourceIncludePermissions.get(resourceServer.identifier());
    return typeof value === 'boolean' ? value : options.includePermissions;
  };

  const getResourceServerInfo = async (ctx, indicator, client) => {
    const allowed = client.allowed_resources || [];
    if (!allowed.includes(indicator)) {
      throw new errors.InvalidTarget(await t(ctx, 'resourceForbidden', { clientId: client.clientId, resource: indicator }));
    }
    const resourceServer = await services.resourceServer.findByIdentifier(indicator);
    if (!resourceServer) {
      throw new errors.InvalidTarget(await t(ctx, 'resourceUnavailable', { resource: indicator }));
    }
    resourceIncludePermissions.set(indicator, resourceServer.includePermissions);
    return {
      scope: resourceServer.scope || options.defaultResourceScope,
      audience: resourceServer.identifier,
      accessTokenTTL: resourceServer.accessTokenTTL || options.ttl.accessToken,
      accessTokenFormat: 'jwt',
      jwt: { sign: { alg: 'RS256' } }
    };
  };

  const tenantCheck = new interactionPolicy.Check('tenant_required', '需要选择租户', async ctx => {
    const { oidc } = ctx;
    const accountId = oidc.session.accountId;
    if (!accountId || !identity.tenantEnabled()) {
      return interactionPolicy.Check.NO_NEED_TO_PROMPT;
    }
    const sessionUid = oidc.session.uid;
    const requested = oidc.params.tenant_id ? String(oidc.params.tenant_id) : null;
    const chosen = oidc.result?.tenant?.tenantId ? String(oidc.result.tenant.tenantId) : null;
    const select = async tenantId => {
      await services.sessionTenant.set({ sessionUid, accountId, tenantId });
      return interactionPolicy.Check.NO_NEED_TO_PROMPT;
    };

    if (chosen && (await identity.isTenantMember(accountId, chosen))) {
      return select(chosen);
    }
    const current = await services.sessionTenant.get({ sessionUid });
    const currentTenantId = current && current.accountId === String(accountId) && (await identity.isTenantMember(accountId, current.tenantId)) ? current.tenantId : null;
    if (requested) {
      if (requested === currentTenantId) {
        return interactionPolicy.Check.NO_NEED_TO_PROMPT;
      }
      if (await identity.isTenantMember(accountId, requested)) {
        return select(requested);
      }
      return interactionPolicy.Check.REQUEST_PROMPT;
    }
    if (currentTenantId) {
      return interactionPolicy.Check.NO_NEED_TO_PROMPT;
    }
    const { list } = await identity.listTenants(accountId);
    if (list.length === 0) {
      return interactionPolicy.Check.NO_NEED_TO_PROMPT;
    }
    if (list.length === 1) {
      return select(list[0].tenantId);
    }
    return interactionPolicy.Check.REQUEST_PROMPT;
  });

  const policy = interactionPolicy.base();
  policy.add(new interactionPolicy.Prompt({ name: 'tenant', requestable: false }, ctx => ({ tenant_id: ctx.oidc.params.tenant_id }), tenantCheck), 1);

  const ttl = options.ttl;
  const configuration = {
    adapter: getAdapter,
    jwks,
    clockTolerance: options.clockTolerance,
    cookies: {
      keys: [deriveKey(options.cookieSecret || options.keyEncryptionSecret, 'cookie').toString('base64url')]
    },
    claims: {
      openid: ['sub'],
      profile: ['name', 'nickname', 'picture', 'gender', 'birthdate'],
      email: ['email'],
      phone: ['phone_number']
    },
    scopes: ['openid', 'offline_access', 'profile', 'email', 'phone'],
    extraParams: ['tenant_id'],
    extraClientMetadata: {
      properties: ['skip_consent', 'allowed_resources'],
      validator(ctx, key, value) {
        if (key === 'skip_consent' && value !== undefined && typeof value !== 'boolean') {
          throw new errors.InvalidClientMetadata('skip_consent 必须是布尔值');
        }
        if (key === 'allowed_resources' && value !== undefined && !(Array.isArray(value) && value.every(item => typeof item === 'string'))) {
          throw new errors.InvalidClientMetadata('allowed_resources 必须是字符串数组');
        }
      }
    },
    features: {
      devInteractions: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: async (ctx, client, oneOf) => oneOf || (client.allowed_resources || [])[0],
        useGrantedResource: async () => true,
        getResourceServerInfo
      },
      rpInitiatedLogout: {
        enabled: true,
        logoutSource: async (ctx, form) => {
          const title = escapeHtml(await t(ctx, 'logoutPageTitle'));
          const confirm = escapeHtml(await t(ctx, 'logoutConfirm'));
          ctx.body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${form}<input type="hidden" name="logout" value="yes" form="op.logoutForm"/><noscript><button type="submit" form="op.logoutForm">${confirm}</button></noscript><script>document.getElementById('op.logoutForm').submit()</script></body></html>`;
        },
        postLogoutSuccessSource: async ctx => {
          const message = escapeHtml(await t(ctx, 'logoutSuccess'));
          ctx.body = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${message}</title></head><body><p>${message}</p></body></html>`;
        }
      },
      backchannelLogout: { enabled: true },
      clientCredentials: { enabled: true },
      dPoP: { enabled: true },
      revocation: { enabled: true },
      introspection: { enabled: true },
      userinfo: { enabled: true }
    },
    interactions: {
      policy,
      url: async (ctx, interaction) => `${options.prefix}/interaction/${interaction.uid}`
    },
    findAccount: identity.findAccount,
    loadExistingGrant: async ctx => {
      const { oidc } = ctx;
      const grantId = oidc.result?.consent?.grantId || oidc.session.grantIdFor(oidc.client.clientId);
      const existing = grantId && (await oidc.provider.Grant.find(grantId));
      if (existing) {
        if (oidc.client.skip_consent !== false) {
          fillGrantFromRequest(ctx, existing);
          await existing.save();
        }
        return existing;
      }
      if (oidc.client.skip_consent === false) {
        return undefined;
      }
      const grant = new oidc.provider.Grant({ clientId: oidc.client.clientId, accountId: oidc.session.accountId });
      fillGrantFromRequest(ctx, grant);
      await grant.save();
      return grant;
    },
    issueRefreshToken: async (ctx, client) => client.grantTypeAllowed('refresh_token'),
    rotateRefreshToken: () => true,
    extraTokenClaims: async (ctx, token) => {
      if (token.kind === 'ClientCredentials') {
        return { [claims.clientToken]: true };
      }
      const accountId = token.accountId;
      if (!accountId) {
        return undefined;
      }
      const extra = {};
      let sid = token.sid;
      if (!sid && token.sessionUid) {
        const session = await ctx.oidc.provider.Session.findByUid(token.sessionUid);
        sid = session?.sidFor(token.clientId);
      }
      if (sid) {
        extra.sid = sid;
      }
      if (token.kneActor) {
        extra.act = { sub: token.kneActor };
      }
      let tenantId = token.kneTenantId;
      if (!tenantId && token.sessionUid) {
        tenantId = (await services.sessionTenant.get({ sessionUid: token.sessionUid }))?.tenantId;
      }
      const tenantContext = await identity.getTenantContext({ accountId, tenantId });
      if (tenantContext) {
        extra[claims.tenantId] = tenantContext.tenantId;
        extra[claims.tenantUserId] = tenantContext.tenantUserId;
        extra[claims.roles] = tenantContext.roles;
        if (includePermissions(token.resourceServer)) {
          extra[claims.permissions] = tenantContext.permissions;
        }
      }
      return extra;
    },
    ttl: {
      AccessToken: (ctx, token) => token.resourceServer?.accessTokenTTL || ttl.accessToken,
      ClientCredentials: (ctx, token) => token.resourceServer?.accessTokenTTL || ttl.accessToken,
      AuthorizationCode: () => 60,
      IdToken: () => ttl.idToken,
      RefreshToken: () => ttl.refreshToken,
      Interaction: () => ttl.interaction,
      Session: () => ttl.session,
      Grant: () => ttl.grant
    },
    fetch: (url, init) => {
      const { allowPrivateFetch } = options;
      if (allowPrivateFetch === true || (typeof allowPrivateFetch === 'function' && allowPrivateFetch(new URL(url)))) {
        delete init.dispatcher;
      }
      return globalThis.fetch(url, init);
    },
    renderError: async (ctx, out) => {
      ctx.type = 'json';
      ctx.body = out;
    }
  };

  const provider = new Provider(runtime.issuer, configuration);
  provider.proxy = options.trustProxy;

  provider.registerGrantType(
    tokenExchange.GRANT_TYPE,
    tokenExchange.createTokenExchangeHandler({
      errors,
      t,
      options,
      identity,
      getResourceServerInfo,
      getLocalJWKS,
      isRevoked: payload => fastify[options.name].revocation.isRevoked(payload)
    }),
    tokenExchange.PARAMETERS
  );

  provider.on('end_session.success', async ctx => {
    const session = ctx.oidc.session;
    if (!session) {
      return;
    }
    try {
      for (const clientId of Object.keys(session.authorizations || {})) {
        const sid = session.sidFor(clientId);
        if (sid) {
          await fastify[options.name].revocation.revokeSession(sid);
        }
      }
      if (!(await getAdapter('Session').findByUid(session.uid))) {
        await services.sessionTenant.remove({ sessionUid: session.uid });
      }
    } catch (e) {
      fastify.log.warn({ err: e }, 'fastify-oidc: 登出后清理会话失败');
    }
  });

  provider.on('server_error', (ctx, err) => {
    fastify.log.error({ err }, 'fastify-oidc: provider server_error');
  });

  return { provider, getAdapter, errors };
};
