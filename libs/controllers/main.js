const fp = require('fastify-plugin');

module.exports = fp(async (fastify, options) => {
  const { services } = fastify[options.name];
  fastify.get(
    `${options.prefix}/welcome`,
    {
      onRequest: [],
      schema: {
        description: '接口说明',
        summary: '接口主题',
        query: {}
      }
    },
    async request => {
      return { message: 'welcome' };
    }
  );
});
