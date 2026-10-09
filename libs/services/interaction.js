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
      output.tenants = await identity.listTenants(session.accountId);
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
    if (!accountId || !(await getIdp().identity.isTenantMember(accountId, tenantId))) {
      throw createError(BadRequest, 'tenantNotAvailable');
    }
    return finish({ provider, request, reply, result: { tenant: { tenantId: String(tenantId) } } });
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

  services.interaction = { details, login, selectTenant, confirm, abort };
});
