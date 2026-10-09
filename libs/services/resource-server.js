const fp = require('fastify-plugin');
const httpErrors = require('http-errors');
const { createError } = require('../utils/intl');

const { NotFound, BadRequest } = httpErrors;

module.exports = fp(async (fastify, options) => {
  const { models, services } = fastify[options.name];
  if (!options.runtime.idpEnabled) {
    return;
  }
  const { Op } = fastify.sequelize.Sequelize;

  const assertIdentifier = identifier => {
    try {
      new URL(identifier);
    } catch (e) {
      throw createError(BadRequest, 'resourceServerIdentifierInvalid');
    }
  };

  const getInstance = async ({ id }) => {
    const item = await models.resourceServer.findByPk(id);
    if (!item) {
      throw createError(NotFound, 'resourceServerNotFound');
    }
    return item;
  };

  const list = async ({ filter = {}, perPage = 20, currentPage = 1 } = {}) => {
    const where = {};
    if (filter.keyword) {
      where[Op.or] = [{ identifier: { [Op.like]: `%${filter.keyword}%` } }, { name: { [Op.like]: `%${filter.keyword}%` } }];
    }
    if (filter.status) {
      where.status = filter.status;
    }
    const { rows, count } = await models.resourceServer.findAndCountAll({
      where,
      offset: perPage * (currentPage - 1),
      limit: perPage,
      order: [['createdAt', 'DESC']]
    });
    return { pageData: rows, totalCount: count };
  };

  const detail = async ({ id }) => getInstance({ id });

  const create = async ({ identifier, name, scope, accessTokenTTL, includePermissions, description }) => {
    assertIdentifier(identifier);
    if (await models.resourceServer.count({ where: { identifier } })) {
      throw createError(BadRequest, 'resourceServerExists', { identifier });
    }
    return models.resourceServer.create({
      identifier,
      name,
      scope: scope || options.defaultResourceScope,
      accessTokenTTL,
      includePermissions,
      description
    });
  };

  const save = async ({ id, name, scope, accessTokenTTL, includePermissions, description }) => {
    const item = await getInstance({ id });
    await item.update({ name, scope: scope || options.defaultResourceScope, accessTokenTTL, includePermissions, description });
    return item;
  };

  const setStatus = async ({ id, status }) => {
    const item = await getInstance({ id });
    await item.update({ status });
  };

  const remove = async ({ id }) => {
    const item = await getInstance({ id });
    await item.destroy();
  };

  const findByIdentifier = async identifier => {
    return models.resourceServer.findOne({ where: { identifier, status: 'open' } });
  };

  const listIdentifiers = async () => {
    const rows = await models.resourceServer.findAll({ attributes: ['identifier'], where: { status: 'open' } });
    return rows.map(row => row.identifier);
  };

  const seed = async resourceServers => {
    for (const item of resourceServers || []) {
      if (await models.resourceServer.count({ where: { identifier: item.identifier } })) {
        continue;
      }
      await create(item);
    }
  };

  services.resourceServer = { list, detail, create, save, setStatus, remove, findByIdentifier, listIdentifiers, seed };
});
