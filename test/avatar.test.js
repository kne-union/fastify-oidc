const { expect } = require('chai');
const { createApp, getFreePort } = require('./support/app');

const USERS = [{ id: '3001', nickname: '赵六', email: 'zhaoliu@test.com', password: 'pwd', avatar: 'idp-avatar-1' }];

describe('@kne/fastify-oidc central 头像同步', function () {
  this.timeout(30000);
  let idp, child, idpOrigin;

  const readMirror = async () => (await child.fastify.account.models.user.findByPk('3001')).avatar;
  const setIdpAvatar = avatar => idp.fastify.account.models.user.update({ avatar }, { where: { id: '3001' } });

  before(async () => {
    const [idpPort, childPort] = [await getFreePort(), await getFreePort()];
    idpOrigin = `http://127.0.0.1:${idpPort}`;
    const childOrigin = `http://127.0.0.1:${childPort}`;
    idp = await createApp({
      port: idpPort,
      users: USERS,
      files: [
        { id: 'idp-avatar-1', filename: 'a.png', content: 'avatar-one' },
        { id: 'idp-avatar-2', filename: 'b.png', content: 'avatar-two' }
      ],
      oidc: {
        isMain: true,
        clients: [
          {
            clientId: 'child-service',
            clientSecret: 'child-secret',
            grant_types: ['client_credentials'],
            response_types: [],
            token_endpoint_auth_method: 'client_secret_basic',
            allowedResources: [`${idpOrigin}/api/oidc`]
          }
        ]
      }
    });
    child = await createApp({
      port: childPort,
      mode: 'central',
      files: [],
      oidc: {
        issuer: `${idpOrigin}/oidc`,
        clientId: 'child-spa',
        audience: `${childOrigin}/api`,
        serviceClient: { clientId: 'child-service', clientSecret: 'child-secret' },
        userMirrorTTL: 0
      }
    });
  });

  after(async () => {
    await child.fastify.close();
    await idp.fastify.close();
  });

  it('should return absolute avatarUrl from service api', async () => {
    const profile = await child.fastify.oidc.serviceClient.getUserProfile('3001');
    expect(profile.avatar).to.equal('idp-avatar-1');
    expect(profile.avatarUrl).to.equal(`${idpOrigin}/api/v1/static/file/idp-avatar-1?filename=a.png`);
  });

  it('should copy avatar into local file manager and store local file id', async () => {
    const user = await child.fastify.oidc.userMirror.ensure('3001');
    const local = child.fastify.fileManager.records.get(user.avatar);
    expect(user.avatar).to.not.equal('idp-avatar-1');
    expect(local.content.toString()).to.equal('avatar-one');
    expect(local.options).to.deep.equal({ oidcAvatarSource: 'idp-avatar-1' });
    expect(await readMirror()).to.equal(user.avatar);
  });

  it('should not download again when idp avatar is unchanged', async () => {
    const uploads = child.fastify.fileManager.stats.uploads;
    const before = await readMirror();
    await child.fastify.oidc.userMirror.ensure('3001');
    expect(child.fastify.fileManager.stats.uploads).to.equal(uploads);
    expect(await readMirror()).to.equal(before);
  });

  it('should replace local file in place when idp avatar changes', async () => {
    const before = await readMirror();
    await setIdpAvatar('idp-avatar-2');
    await child.fastify.oidc.userMirror.ensure('3001');
    expect(await readMirror()).to.equal(before);
    const local = child.fastify.fileManager.records.get(before);
    expect(local.content.toString()).to.equal('avatar-two');
    expect(local.options).to.deep.equal({ oidcAvatarSource: 'idp-avatar-2' });
  });

  it('should clear mirror avatar when idp avatar is removed', async () => {
    await setIdpAvatar(null);
    await child.fastify.oidc.userMirror.ensure('3001');
    expect(await readMirror()).to.equal(null);
  });
});
