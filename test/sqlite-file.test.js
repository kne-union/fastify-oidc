const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./support/app');

/**
 * 文件型 sqlite 下，事务会单独占用一个连接；其他插件同时在默认连接上写库时，
 * 事务连接写入会 SQLITE_BUSY。IdP 初始化、密钥轮换都必须在其他插件并发写库时稳定成功。
 */
describe('@kne/fastify-oidc sqlite 文件库并发写入', function () {
  this.timeout(60000);

  let dir;
  let app;
  let writers;

  const startWriters = fastify => {
    const state = { stopped: false, count: 0 };
    const loop = async () => {
      while (!state.stopped) {
        await fastify.sequelize.instance.query('INSERT INTO busy_writer (v) VALUES (1)');
        state.count++;
      }
    };
    state.done = Promise.all(Array.from({ length: 4 }, loop));
    return state;
  };

  const stopWriters = async () => {
    if (writers) {
      writers.stopped = true;
      await writers.done;
      writers = null;
    }
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-oidc-sqlite-'));
  });

  afterEach(async () => {
    await stopWriters();
    if (app) {
      await app.fastify.close();
      app = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const create = () =>
    createApp({
      db: { dialect: 'sqlite', storage: path.join(dir, 'data.db'), logging: false },
      beforeSync: async fastify => {
        await fastify.sequelize.instance.query('CREATE TABLE busy_writer (v INTEGER)');
        writers = startWriters(fastify);
      }
    });

  it('should init IdP while other plugins keep writing on the shared connection', async () => {
    app = await create();
    expect(writers.count).to.be.greaterThan(0);
    const keys = await app.fastify.oidc.services.key.list();
    expect(keys.map(item => item.status).sort()).to.deep.equal(['active', 'next']);
    const res = await fetch(`${app.origin}/oidc/.well-known/openid-configuration`);
    expect(res.status).to.equal(200);
  });

  it('should rotate keys while other plugins keep writing on the shared connection', async () => {
    app = await create();
    for (let i = 0; i < 3; i++) {
      await app.fastify.oidc.services.key.rotate();
    }
    const keys = await app.fastify.oidc.services.key.list();
    expect(keys.filter(item => item.status === 'active')).to.have.length(1);
    expect(keys.filter(item => item.status === 'next')).to.have.length(1);
  });
});
