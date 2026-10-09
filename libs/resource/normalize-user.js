const toArray = value => (Array.isArray(value) ? value.map(String) : []);

/**
 * 把 access_token claims 归一成业务代码使用的 request.user
 * permissions 为 null 表示 token 中未携带（需要实时查询 fastify-tenant）
 */
const normalizeClaims = (payload, claims) => {
  const isClient = !!payload[claims.clientToken];
  return {
    userId: isClient ? null : String(payload.sub),
    tenantId: payload[claims.tenantId] ? String(payload[claims.tenantId]) : null,
    tenantUserId: payload[claims.tenantUserId] ? String(payload[claims.tenantUserId]) : null,
    roles: toArray(payload[claims.roles]),
    permissions: Array.isArray(payload[claims.permissions]) ? toArray(payload[claims.permissions]) : null,
    clientId: payload.client_id || null,
    scope: payload.scope ? String(payload.scope).split(' ') : [],
    sid: payload.sid || null,
    actor: payload.act?.sub || null,
    isClient,
    legacy: false,
    expiresAt: payload.exp || null,
    payload
  };
};

const normalizeLegacy = request => ({
  userId: request.userInfo?.id ? String(request.userInfo.id) : null,
  tenantId: request.authenticatePayload?.tenantId ? String(request.authenticatePayload.tenantId) : null,
  tenantUserId: null,
  roles: [],
  permissions: null,
  clientId: null,
  scope: [],
  sid: null,
  actor: null,
  isClient: false,
  legacy: true,
  expiresAt: null,
  payload: request.authenticatePayload || null
});

module.exports = { normalizeClaims, normalizeLegacy };
