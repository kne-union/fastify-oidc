/**
 * 把当前授权请求中申请的 OIDC scope / claims / 资源 scope 写入 grant。
 * 用于免确认（skip_consent）的一方应用，以及用户在 consent 页确认之后。
 */
const fillGrantFromRequest = (ctx, grant) => {
  const { oidc } = ctx;
  if (oidc.requestParamOIDCScopes?.size) {
    grant.addOIDCScope([...oidc.requestParamOIDCScopes].join(' '));
  }
  if (oidc.requestParamClaims?.size) {
    grant.addOIDCClaims([...oidc.requestParamClaims]);
  }
  for (const [indicator, resourceServer] of Object.entries(oidc.resourceServers || {})) {
    const scopes = [...(oidc.requestParamScopes || [])].filter(scope => resourceServer.scopes.has(scope));
    grant.addResourceScope(indicator, scopes.join(' '));
  }
};

const fillGrantFromDetails = (grant, details = {}) => {
  if (details.missingOIDCScope) {
    grant.addOIDCScope(details.missingOIDCScope.join(' '));
  }
  if (details.missingOIDCClaims) {
    grant.addOIDCClaims(details.missingOIDCClaims);
  }
  for (const [indicator, scopes] of Object.entries(details.missingResourceScopes || {})) {
    grant.addResourceScope(indicator, scopes.join(' '));
  }
};

module.exports = { fillGrantFromRequest, fillGrantFromDetails };
