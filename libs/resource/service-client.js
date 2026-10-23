const { GRANT_TYPE: TOKEN_EXCHANGE, ACCESS_TOKEN_TYPE } = require('../idp/grants/token-exchange');
const { createError } = require('../utils/intl');

/**
 * 服务端调用主项目（IdP）的客户端：client_credentials 获取服务令牌、token exchange 代用户换取其它资源的令牌
 */
module.exports = ({ options, fetch = globalThis.fetch }) => {
  const { runtime, serviceClient } = options;
  const { clientId, clientSecret } = serviceClient || {};
  let discovery;
  const tokenCache = new Map();

  const enabled = () => !!(clientId && clientSecret);

  const assertEnabled = () => {
    if (!enabled()) {
      throw createError(null, 'serviceClientNotConfigured');
    }
  };

  const getDiscovery = async () => {
    if (!discovery) {
      const response = await fetch(`${runtime.issuer}/.well-known/openid-configuration`);
      if (!response.ok) {
        throw createError(null, 'idpDiscoveryFailed', { status: String(response.status) });
      }
      discovery = await response.json();
    }
    return discovery;
  };

  const tokenRequest = async body => {
    const { token_endpoint } = await getDiscovery();
    const response = await fetch(token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`
      },
      body: new URLSearchParams(body).toString()
    });
    const data = await response.json();
    if (!response.ok) {
      const error = createError(null, 'idpTokenRequestFailed', { status: String(response.status), reason: data.error_description || data.error || '' });
      error.statusCode = response.status === 400 ? 400 : 502;
      throw error;
    }
    return data;
  };

  const getServiceToken = async ({ resource = runtime.serviceAudience, scope = options.serviceScopes.join(' ') } = {}) => {
    assertEnabled();
    const key = `${resource} ${scope}`;
    const cached = tokenCache.get(key);
    if (cached && cached.expiresAt - 30 * 1000 > Date.now()) {
      return cached.accessToken;
    }
    const data = await tokenRequest({ grant_type: 'client_credentials', resource, scope });
    tokenCache.set(key, { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
    return data.access_token;
  };

  // 每个接口只申请自己需要的 scope：宿主未升级（服务接口资源没有新 scope）时，旧接口仍可用
  const callService = async (path, { query, method = 'GET', body, scope } = {}) => {
    const token = await getServiceToken(scope ? { scope } : undefined);
    const url = new URL(`${runtime.idpApiBase}${path}`);
    Object.entries(query || {}).forEach(([key, value]) => value !== undefined && value !== null && url.searchParams.set(key, value));
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const response = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = createError(null, 'idpServiceCallFailed', { path, status: String(response.status), reason: data?.message || '' });
      error.upstreamStatus = response.status;
      throw error;
    }
    return data && Object.prototype.hasOwnProperty.call(data, 'data') && Object.prototype.hasOwnProperty.call(data, 'code') ? data.data : data;
  };

  const appCode = () => runtime.app?.code;

  const getUserProfile = async userId => callService('/service/user', { query: { id: userId }, scope: 'user:read' });

  const getTenantUser = async ({ userId, tenantId }) => callService('/service/tenant-user', { query: { userId, tenantId, app: appCode() }, scope: 'tenant:read' });

  const getTenantList = async ({ userId }) => callService('/service/tenant-list', { query: { userId, app: appCode() }, scope: 'tenant:read' });

  const registerApp = async body => callService('/service/app/register', { method: 'POST', body, scope: 'app:register' });

  const getTenantSnapshot = async ({ tenantId }) => callService('/service/tenant-snapshot', { query: { tenantId, app: appCode() }, scope: 'tenant:sync' });

  const getTenantMembers = async ({ tenantId, currentPage, perPage }) => callService('/service/tenant-members', { query: { tenantId, app: appCode(), currentPage, perPage }, scope: 'tenant:sync' });

  const exchangeToken = async ({ subjectToken, resource, scope }) => {
    assertEnabled();
    return tokenRequest({
      grant_type: TOKEN_EXCHANGE,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      resource,
      ...(scope ? { scope } : {})
    });
  };

  return { enabled, getServiceToken, callService, getUserProfile, getTenantUser, getTenantList, registerApp, getTenantSnapshot, getTenantMembers, exchangeToken };
};
