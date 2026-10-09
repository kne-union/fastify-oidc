const { expect } = require('chai');
const resolveOptions = require('../libs/utils/resolve-options');
const { encrypt, decrypt } = require('../libs/utils/crypto');
const createRevocation = require('../libs/resource/revocation');
const { normalizeClaims } = require('../libs/resource/normalize-user');

const base = { name: 'oidc', prefix: '/api/oidc', mountPath: '/oidc' };

describe('@kne/fastify-oidc 单元测试', () => {
  describe('resolve-options', () => {
    it('should derive issuer, audience and claim namespace from origin in standalone mode', () => {
      const runtime = resolveOptions(Object.assign({}, base, { mode: 'standalone', origin: 'https://a.example.com/' }));
      expect(runtime.idpEnabled).to.equal(true);
      expect(runtime.issuer).to.equal('https://a.example.com/oidc');
      expect(runtime.audience).to.equal('https://a.example.com/api');
      expect(runtime.clientId).to.equal('oidc-spa');
      expect(runtime.claims.tenantId).to.equal('https://a.example.com/tenant_id');
      expect(runtime.serviceAudience).to.equal('https://a.example.com/api/oidc');
    });

    it('should use issuer origin as claim namespace in central mode', () => {
      const runtime = resolveOptions(Object.assign({}, base, { mode: 'central', origin: 'https://b.example.com', issuer: 'https://a.example.com/oidc/' }));
      expect(runtime.idpEnabled).to.equal(false);
      expect(runtime.issuer).to.equal('https://a.example.com/oidc');
      expect(runtime.audience).to.equal('https://b.example.com/api');
      expect(runtime.claimNamespace).to.equal('https://a.example.com/');
      expect(runtime.jwksUri).to.equal('https://a.example.com/oidc/jwks');
    });

    it('should reject invalid configuration', () => {
      expect(() => resolveOptions(Object.assign({}, base, { mode: 'other', origin: 'https://a.example.com' }))).to.throw('mode');
      expect(() => resolveOptions(Object.assign({}, base, { mode: 'standalone' }))).to.throw('ORIGIN');
      expect(() => resolveOptions(Object.assign({}, base, { mode: 'central', origin: 'https://b.example.com' }))).to.throw('OIDC_ISSUER');
      expect(() => resolveOptions(Object.assign({}, base, { mode: 'standalone', origin: 'https://a.example.com', issuer: 'https://a.example.com' }))).to.throw('路径');
    });

    it('should allow custom claim namespace', () => {
      const runtime = resolveOptions(Object.assign({}, base, { mode: 'standalone', origin: 'https://a.example.com', claimNamespace: 'https://kne/' }));
      expect(runtime.claims.roles).to.equal('https://kne/roles');
    });
  });

  describe('crypto', () => {
    it('should encrypt and decrypt with the same secret only', () => {
      const cipher = encrypt('secret-a', 'hello');
      expect(cipher).to.not.include('hello');
      expect(decrypt('secret-a', cipher)).to.equal('hello');
      expect(() => decrypt('secret-b', cipher)).to.throw();
    });
  });

  describe('revocation', () => {
    it('should revoke by sid and by subject issued-at', async () => {
      const revocation = createRevocation({ ttl: 60 });
      const now = Math.floor(Date.now() / 1000);
      await revocation.revokeSession('sid-1');
      expect(await revocation.isRevoked({ sid: 'sid-1', sub: 'u1', iat: now })).to.equal(true);
      expect(await revocation.isRevoked({ sid: 'sid-2', sub: 'u1', iat: now })).to.equal(false);
      await revocation.revokeSubject('u1');
      expect(await revocation.isRevoked({ sid: 'sid-2', sub: 'u1', iat: now - 10 })).to.equal(true);
      expect(await revocation.isRevoked({ sid: 'sid-2', sub: 'u1', iat: now + 10 })).to.equal(false);
    });

    it('should use custom store', async () => {
      const data = new Map();
      const revocation = createRevocation({ ttl: 60, store: { get: async key => data.get(key), set: async (key, value) => data.set(key, value) } });
      await revocation.revokeSession('sid-x');
      expect(data.has('sid:sid-x')).to.equal(true);
    });
  });

  describe('normalize-user', () => {
    it('should normalize user and client claims', () => {
      const { claims } = resolveOptions(Object.assign({}, base, { mode: 'standalone', origin: 'https://a.example.com' }));
      const user = normalizeClaims({ sub: '1', scope: 'api', [claims.tenantId]: 't1', [claims.roles]: ['admin'], client_id: 'spa' }, claims);
      expect(user).to.include({ userId: '1', tenantId: 't1', clientId: 'spa', isClient: false });
      expect(user.permissions).to.equal(null);
      const client = normalizeClaims({ sub: 'svc', client_id: 'svc', [claims.clientToken]: true }, claims);
      expect(client.isClient).to.equal(true);
      expect(client.userId).to.equal(null);
    });
  });
});
