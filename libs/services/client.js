const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { encrypt, decrypt, randomSecret } = require('../utils/crypto');
const { createError } = require('../utils/intl');

const { NotFound, BadRequest } = httpErrors;

const PUBLIC_DEFAULTS = {
  application_type: 'web',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none'
};

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { Op } = fastify.sequelize.Sequelize;
  const secret = options.keyEncryptionSecret;

  const normalizeMetadata = (metadata = {}) => {
    const result = Object.assign({}, PUBLIC_DEFAULTS, metadata);
    if (!Array.isArray(result.redirect_uris)) {
      result.redirect_uris = result.grant_types.includes('authorization_code') ? [] : undefined;
    }
    ['client_id', 'client_secret', 'client_name', 'allowed_resources'].forEach(key => delete result[key]);
    return result;
  };

  const isConfidential = metadata => metadata.token_endpoint_auth_method !== 'none';

  const validate = async ({ clientId, metadata, allowedResources }) => {
    const provider = fastify[options.name].idp.getProvider();
    if (!provider) {
      return;
    }
    try {
      await provider.Client.validate(
        Object.assign({}, metadata, {
          client_id: clientId,
          client_secret: isConfidential(metadata) ? 'validate-only-secret' : undefined,
          allowed_resources: allowedResources || []
        })
      );
    } catch (e) {
      throw createError(BadRequest, 'clientMetadataInvalid', { reason: e.error_description || e.message });
    }
  };

  const format = item => {
    const data = item.get({ plain: true });
    delete data.clientSecret;
    data.hasSecret = !!item.clientSecret;
    data.allowedResources = data.allowedResources || [];
    return data;
  };

  const getInstance = async ({ id }) => {
    const item = await models.client.findByPk(id);
    if (!item) {
      throw createError(NotFound, 'clientNotFound');
    }
    return item;
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
    if (filter.keyword) {
      where[Op.or] = [{ clientId: { [Op.like]: `%${filter.keyword}%` } }, { clientName: { [Op.like]: `%${filter.keyword}%` } }];
    }
    if (filter.status) {
      where.status = filter.status;
    }
    const { rows, count } = await models.client.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows.map(format), totalCount: count };
  };

  const detail = async ({ id }) => format(await getInstance({ id }));

  const create = async ({ clientId, clientName, clientSecret, metadata, allowedResources = [], description }) => {
    clientId = clientId || randomSecret(12);
    if (await models.client.count({ where: { clientId } })) {
      throw createError(BadRequest, 'clientIdExists', { clientId });
    }
    const normalized = normalizeMetadata(metadata);
    await validate({ clientId, metadata: normalized, allowedResources });
    const plainSecret = isConfidential(normalized) ? clientSecret || randomSecret(32) : null;
    const item = await models.client.create({
      clientId,
      clientName,
      clientSecret: plainSecret ? encrypt(secret, plainSecret) : null,
      metadata: normalized,
      allowedResources,
      description
    });
    return Object.assign(format(item), plainSecret ? { clientSecret: plainSecret } : {});
  };

  const save = async ({ id, clientName, metadata, allowedResources, description }) => {
    const item = await getInstance({ id });
    const nextMetadata = metadata ? normalizeMetadata(metadata) : item.metadata;
    const nextResources = allowedResources || item.allowedResources || [];
    await validate({ clientId: item.clientId, metadata: nextMetadata, allowedResources: nextResources });
    const patch = { metadata: nextMetadata, allowedResources: nextResources };
    if (clientName !== undefined) patch.clientName = clientName;
    if (description !== undefined) patch.description = description;
    if (isConfidential(nextMetadata) && !item.clientSecret) {
      patch.clientSecret = encrypt(secret, randomSecret(32));
    }
    if (!isConfidential(nextMetadata)) {
      patch.clientSecret = null;
    }
    await item.update(patch);
    return format(item);
  };

  const rotateSecret = async ({ id }) => {
    const item = await getInstance({ id });
    if (!isConfidential(item.metadata)) {
      throw createError(BadRequest, 'publicClientNoSecret');
    }
    const plainSecret = randomSecret(32);
    await item.update({ clientSecret: encrypt(secret, plainSecret) });
    return { clientId: item.clientId, clientSecret: plainSecret };
  };

  const setStatus = async ({ id, status }) => {
    const item = await getInstance({ id });
    await item.update({ status });
  };

  const remove = async ({ id }) => {
    const item = await getInstance({ id });
    await item.destroy();
  };

  const findForProvider = async clientId => {
    const item = await models.client.findOne({ where: { clientId, status: 'open' } });
    if (!item) {
      return undefined;
    }
    return Object.assign({}, item.metadata, {
      client_id: item.clientId,
      client_name: item.clientName || undefined,
      client_secret: item.clientSecret ? decrypt(secret, item.clientSecret) : undefined,
      allowed_resources: item.allowedResources || []
    });
  };

  const seed = async clients => {
    for (const { clientId, clientName, clientSecret, allowedResources, description, ...metadata } of clients || []) {
      if (await models.client.count({ where: { clientId } })) {
        continue;
      }
      await create({ clientId, clientName, clientSecret, metadata, allowedResources, description });
    }
  };

  services.client = { list, detail, create, save, rotateSecret, setStatus, remove, findForProvider, seed };
});
