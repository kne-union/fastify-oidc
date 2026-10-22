const crypto = require('node:crypto');
const fp = require('fastify-plugin');

/**
 * 模拟 @kne/fastify-file-manager 的最小形态：services.getFileUrl / uploadFromUrl / getFileInstance 与公开的 /file/ 静态地址
 * files: [{ id, filename, content }]
 */
module.exports = fp(
  async (fastify, { files = [], prefix = '/api/v1/static' } = {}) => {
    const records = new Map();
    const stats = { uploads: 0 };

    const save = ({ id, filename, content, options = {} }) => {
      const record = { id: id || crypto.randomUUID(), filename, content: Buffer.from(content), options };
      records.set(record.id, record);
      return record;
    };
    files.forEach(save);

    const getFileInstance = async ({ id }) => {
      const record = records.get(String(id));
      if (!record) {
        throw new Error('文件不存在');
      }
      return record;
    };

    const getFileUrl = async ({ id }) => {
      const record = await getFileInstance({ id });
      return `${prefix}/file/${record.id}?filename=${record.filename}`;
    };

    const uploadFromUrl = async ({ id, url, options }) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error('下载文件失败');
      }
      stats.uploads += 1;
      const filename = new URL(url).searchParams.get('filename') || 'file';
      const record = save({ id, filename, content: Buffer.from(await response.arrayBuffer()), options });
      return { id: record.id, filename: record.filename };
    };

    fastify.get(`${prefix}/file/:id`, async (request, reply) => {
      const record = records.get(request.params.id);
      if (!record) {
        return reply.code(404).send();
      }
      return reply.type('application/octet-stream').send(record.content);
    });

    fastify.decorate('fileManager', { records, stats, services: { getFileUrl, uploadFromUrl, getFileInstance } });
  },
  { name: 'fastify-file-manager' }
);
