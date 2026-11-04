const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { fillGrantFromDetails } = require('../idp/grant-helpers');
const { createError } = require('../utils/intl');

const { BadRequest } = httpErrors;

module.exports = fp(async (fastify, options) => {
  const { services, translator } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const getIdp = () => fastify[options.name].idp;

  const loadInteraction = async ({ request, reply, uid, prompt }) => {
    const provider = getIdp().getProvider();
    let interaction;
    try {
      interaction = await provider.interactionDetails(request.raw, reply.raw);
    } catch (e) {
      throw createError(BadRequest, 'interactionExpired');
    }
    if (interaction.uid !== uid) {
      throw createError(BadRequest, 'interactionMismatch');
    }
    if (prompt && interaction.prompt.name !== prompt) {
      throw createError(BadRequest, 'interactionPromptMismatch', { current: interaction.prompt.name, expected: prompt });
    }
    return { provider, interaction };
  };

  const finish = async ({ provider, request, reply, result, merge = true }) => {
    const redirectTo = await provider.interactionResult(request.raw, reply.raw, result, { mergeWithLastSubmission: merge });
    return { redirectTo };
  };

  const details = async ({ request, reply, uid }) => {
    const { provider, interaction } = await loadInteraction({ request, reply, uid });
    const { identity } = getIdp();
    const { prompt, params, session } = interaction;
    const client = await provider.Client.find(params.client_id);
    const output = {
      uid: interaction.uid,
      prompt: { name: prompt.name, reasons: prompt.reasons, details: prompt.details },
      params: {
        clientId: params.client_id,
        scope: params.scope,
        resource: params.resource,
        tenantId: params.tenant_id,
        loginHint: params.login_hint,
        uiLocales: params.ui_locales
      },
      client: client ? { clientId: client.clientId, clientName: client.clientName, logoUri: client.logoUri, clientUri: client.clientUri } : null,
      user: null,
      tenants: null
    };
    if (session?.accountId) {
      const user = await identity.getUser(session.accountId);
      output.user = user && { id: String(user.id), nickname: user.nickname, avatar: user.avatar, email: user.email, phone: user.phone };
    }
    if (prompt.name === 'tenant' && session?.accountId) {
      output.tenants = await identity.listTenants(session.accountId, services.app.scopeOfClient(params.client_id));
    }
    if (prompt.name === 'mfa' && session?.accountId) {
      const current = await services.sessionTenant.get({ sessionUid: session.uid });
      const mfa = current ? await identity.getTenantMfa(current.tenantId) : { enabled: false };
      output.mfa = {
        method: 'sms',
        tenantId: current?.tenantId || null,
        maxAge: mfa.maxAge ?? null,
        phoneMissing: !output.user?.phone,
        phoneMasked: output.user?.phone ? services.mfa.maskPhone(output.user.phone) : null,
        resendAfter: await services.mfa.getChallengeState({ interactionUid: interaction.uid })
      };
    }
    return output;
  };

  const login = async ({ request, reply, uid, credentials, remember = true }) => {
    const { provider } = await loadInteraction({ request, reply, uid, prompt: 'login' });
    const { status, user } = await getIdp().identity.verifyCredentials(credentials);
    if (!user) {
      return { status };
    }
    return finish({
      provider,
      request,
      reply,
      result: { login: { accountId: String(user.id), remember: remember !== false, amr: ['pwd'] } },
      merge: false
    });
  };

  const selectTenant = async ({ request, reply, uid, tenantId }) => {
    const { provider, interaction } = await loadInteraction({ request, reply, uid, prompt: 'tenant' });
    const accountId = interaction.session?.accountId;
    const scope = services.app.scopeOfClient(interaction.params.client_id);
    if (!accountId || !(await getIdp().identity.isTenantMember(accountId, tenantId, scope))) {
      throw createError(BadRequest, 'tenantNotAvailable');
    }
    return finish({ provider, request, reply, result: { tenant: { tenantId: String(tenantId) } } });
  };

  // 租户开启 MFA 但账号没有手机号：直接以 access_denied 结束交互
  const mfaSend = async ({ request, reply, uid }) => {
    const { provider, interaction } = await loadInteraction({ request, reply, uid, prompt: 'mfa' });
    const accountId = interaction.session?.accountId;
    const user = accountId && (await getIdp().identity.getUser(accountId));
    if (!user?.phone) {
      return finish({
        provider,
        request,
        reply,
        result: { error: 'access_denied', error_description: await translator.t(request, 'mfaPhoneRequired') },
        merge: false
      });
    }
    return services.mfa.sendCode({ interactionUid: interaction.uid, accountId, phone: user.phone });
  };

  const mfaVerify = async ({ request, reply, uid, code }) => {
    const { provider, interaction } = await loadInteraction({ request, reply, uid, prompt: 'mfa' });
    const { session } = interaction;
    const { method } = await services.mfa.verifyCode({ interactionUid: interaction.uid, accountId: session.accountId, code });
    await services.mfa.markSession({ sessionUid: session.uid, accountId: session.accountId, method });
    // 重新提交 login 以把 amr 写进会话（id_token 的 amr），沿用原登录时间保持 auth_time 不变
    const current = await provider.Session.findByUid(session.uid);
    const amr = [...new Set([...(current?.amr || session.amr || ['pwd']), method, 'mfa'])];
    const login = Object.assign({ accountId: session.accountId, amr, remember: !current?.transient }, current?.loginTs ? { ts: current.loginTs } : {}, current?.acr ? { acr: current.acr } : {});
    return finish({ provider, request, reply, result: { login, mfa: { accountId: session.accountId, method } } });
  };

  const confirm = async ({ request, reply, uid }) => {
    const { provider, interaction } = await loadInteraction({ request, reply, uid, prompt: 'consent' });
    const { params, session, prompt } = interaction;
    let grant;
    if (interaction.grantId) {
      grant = await provider.Grant.find(interaction.grantId);
    }
    if (!grant) {
      grant = new provider.Grant({ accountId: session.accountId, clientId: params.client_id });
    }
    fillGrantFromDetails(grant, prompt.details);
    const grantId = await grant.save();
    return finish({ provider, request, reply, result: { consent: { grantId } } });
  };

  const abort = async ({ request, reply, uid }) => {
    const { provider } = await loadInteraction({ request, reply, uid });
    return finish({
      provider,
      request,
      reply,
      result: { error: 'access_denied', error_description: await translator.t(request, 'interactionAborted') },
      merge: false
    });
  };

  services.interaction = { details, login, selectTenant, mfaSend, mfaVerify, confirm, abort };
});
