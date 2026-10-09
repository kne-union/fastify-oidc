const { jwtVerify } = require('jose');

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const PARAMETERS = ['subject_token', 'subject_token_type', 'requested_token_type', 'resource', 'audience', 'scope'];

/**
 * RFC 8693 Token Exchange：服务端拿着用户的 access_token，换取访问另一个资源服务的 access_token。
 * - 调用方必须是已认证的 client，且 grant_types 包含本 grant
 * - subject_token 必须由本 IdP 签发，且其 aud 在调用方 client 的 allowed_resources 中（防止拿别人的令牌来换）
 * - 目标资源必须在调用方 client 的 allowed_resources 中
 */
const createTokenExchangeHandler = ({ errors, t, options, identity, getResourceServerInfo, getLocalJWKS, isRevoked }) => {
  return async ctx => {
    const { client, params, provider } = ctx.oidc;
    const { claims } = options.runtime;

    if (params.subject_token_type !== ACCESS_TOKEN_TYPE) {
      throw new errors.InvalidRequest(await t(ctx, 'subjectTokenTypeUnsupported'));
    }
    if (params.requested_token_type && params.requested_token_type !== ACCESS_TOKEN_TYPE) {
      throw new errors.InvalidRequest(await t(ctx, 'requestedTokenTypeUnsupported'));
    }
    const target = params.resource || params.audience;
    if (!target) {
      throw new errors.InvalidTarget(await t(ctx, 'tokenExchangeTargetMissing'));
    }

    let subject;
    try {
      ({ payload: subject } = await jwtVerify(params.subject_token, getLocalJWKS(), {
        issuer: options.runtime.issuer,
        typ: 'at+jwt'
      }));
    } catch (e) {
      throw new errors.InvalidGrant(await t(ctx, 'subjectTokenInvalid'));
    }
    if (subject[claims.clientToken] || !subject.sub) {
      throw new errors.InvalidGrant(await t(ctx, 'subjectTokenNotUser'));
    }
    if (await isRevoked(subject)) {
      throw new errors.InvalidGrant(await t(ctx, 'subjectTokenRevoked'));
    }
    const allowed = client.allowed_resources || [];
    const subjectAudiences = [].concat(subject.aud || []);
    if (!subjectAudiences.some(aud => allowed.includes(aud))) {
      throw new errors.InvalidGrant(await t(ctx, 'subjectTokenAudienceForbidden'));
    }

    const resourceServerInfo = await getResourceServerInfo(ctx, target, client);
    const account = await identity.findAccount(ctx, subject.sub);
    if (!account) {
      throw new errors.InvalidGrant(await t(ctx, 'subjectTokenAccountInvalid'));
    }

    const requested = (params.scope || resourceServerInfo.scope || '').split(' ').filter(Boolean);
    const available = new Set(resourceServerInfo.scope.split(' '));
    const scope = requested.filter(item => available.has(item)).join(' ') || undefined;

    const token = new provider.AccessToken({
      accountId: account.accountId,
      client,
      gty: 'token_exchange',
      scope
    });
    token.resourceServer = new provider.ResourceServer(target, resourceServerInfo);
    token.kneTenantId = subject[claims.tenantId];
    token.kneActor = client.clientId;
    ctx.oidc.entity('AccessToken', token);
    const value = await token.save();

    ctx.body = {
      access_token: value,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: token.expiration,
      scope: token.scope
    };
  };
};

module.exports = { GRANT_TYPE, ACCESS_TOKEN_TYPE, PARAMETERS, createTokenExchangeHandler };
