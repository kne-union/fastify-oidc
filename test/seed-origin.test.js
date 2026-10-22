const { expect } = require('chai');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, getFreePort } = require('./support/app');

/**
 * 首次启动后修改 ORIGIN（端口 / 域名）重启：已入库的 self client 需补上新 origin 的回调地址与资源，
 * 否则授权请求会报 invalid_redirect_uri / invalid_target；管理端额外维护的回调地址与资源需保留。
 */
describe('@kne/fastify-oidc ORIGIN 变更后的 seed', function () {
  this.timeout(60000);

  let dir;
  let app;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fastify-oidc-seed-'));
  });

  afterEach(async () => {
    if (app) {
      await app.fastify.close();
      app = null;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const create = port => createApp({ port, db: { dialect: 'sqlite', storage: path.join(dir, 'data.db'), logging: false } });

  const getSelfClient = fastify => fastify.oidc.models.client.findOne({ where: { clientId: 'oidc-spa' } });

  it('should append redirect uris and resources of the new origin and keep manually added ones', async () => {
    app = await create(await getFreePort());
    const firstOrigin = app.origin;
    const first = await getSelfClient(app.fastify);
    await app.fastify.oidc.services.client.save({
      id: first.id,
      metadata: Object.assign({}, first.metadata, {
        redirect_uris: [...first.metadata.redirect_uris, 'https://manual.example.com/oidc-callback']
      }),
      allowedResources: [...first.allowedResources, `${firstOrigin}/api/oidc`]
    });
    await app.fastify.close();

    app = await create(await getFreePort());
    expect(app.origin).to.not.equal(firstOrigin);
    const { metadata, allowedResources } = await getSelfClient(app.fastify);
    expect(metadata.redirect_uris).to.deep.equal([`${firstOrigin}/oidc-callback`, 'https://manual.example.com/oidc-callback', `${app.origin}/oidc-callback`]);
    expect(metadata.post_logout_redirect_uris).to.deep.equal([`${firstOrigin}/`, `${app.origin}/`]);
    expect(allowedResources).to.deep.equal([`${firstOrigin}/api`, `${firstOrigin}/api/oidc`, `${app.origin}/api`]);

    const authorize = new URL(`${app.origin}/oidc/auth`);
    authorize.search = new URLSearchParams({
      client_id: 'oidc-spa',
      response_type: 'code',
      scope: 'openid',
      redirect_uri: `${app.origin}/oidc-callback`,
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
      resource: `${app.origin}/api`
    }).toString();
    const res = await fetch(authorize, { redirect: 'manual' });
    expect(res.status).to.equal(303);
    expect(res.headers.get('location')).to.not.include('invalid_redirect_uri');
    expect(res.headers.get('location')).to.not.include('invalid_target');
  });

  it('should not touch the client when origin is unchanged', async () => {
    const port = await getFreePort();
    app = await create(port);
    const before = await getSelfClient(app.fastify);
    await app.fastify.close();

    app = await create(port);
    const after = await getSelfClient(app.fastify);
    expect(after.metadata).to.deep.equal(before.metadata);
    expect(after.allowedResources).to.deep.equal(before.allowedResources);
    expect(after.updatedAt.getTime()).to.equal(before.updatedAt.getTime());
  });
});
