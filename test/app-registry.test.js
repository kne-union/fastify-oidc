const { expect } = require('chai');
const createAppRegistry = require('../libs/resource/app-registry');

const createRegistry = upstreamStatus => {
  const calls = { register: 0, error: 0, warn: 0 };
  const registry = createAppRegistry({
    fastify: { log: { error: () => calls.error++, warn: () => calls.warn++ } },
    options: { runtime: { app: { code: 'crm', name: 'CRM', tenantMode: 'client', permissions: { modules: [] } } }, appRegisterRetryMax: 1, getTenant: () => null },
    serviceClient: {
      enabled: () => true,
      registerApp: async () => {
        calls.register++;
        throw Object.assign(new Error('rejected'), { upstreamStatus });
      }
    }
  });
  return { registry, calls };
};

describe('@kne/fastify-oidc app-registry', function () {
  this.timeout(5000);

  it('should stop retrying when host rejects with 4xx', async () => {
    const { registry, calls } = createRegistry(403);
    await registry.start();
    await new Promise(resolve => setTimeout(resolve, 1200));
    registry.stop();
    expect(calls).to.include({ register: 1, error: 1, warn: 0 });
    expect(registry.getState().lastError.upstreamStatus).to.equal(403);
  });

  it('should keep retrying on 5xx and 429', async () => {
    for (const status of [503, 429]) {
      const { registry, calls } = createRegistry(status);
      await registry.start();
      await new Promise(resolve => setTimeout(resolve, 1200));
      registry.stop();
      expect(calls.register).to.equal(2);
      expect(calls.error).to.equal(0);
    }
  });
});
