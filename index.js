const fp = require('fastify-plugin');
const path = require('node:path');

module.exports = fp(async (fastify, options) => {
  options = Object.assign(
    {},
    {
      dbTableNamePrefix: 't_',
      name: 'oidc'
    },
    options
  );

  fastify.register(require('@kne/fastify-namespace'), {
    options,
    name: options.name,
    modules: [
      ['controllers', path.resolve(__dirname, './libs/controllers')],
      [
        'models',
        await fastify.sequelize.addModels(path.resolve(__dirname, './libs/models'), {
          prefix: options.dbTableNamePrefix
        })
      ],
      ['services', path.resolve(__dirname, './libs/services')]
    ]
  });
});
