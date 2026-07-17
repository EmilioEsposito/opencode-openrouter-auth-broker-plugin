import assert from 'node:assert/strict';
import test from 'node:test';

import openRouterAuthBrokerPlugin from '../src/index.js';

const originalFetch = globalThis.fetch;
const originalConsoleError = console.error;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
});

function expiredAuth() {
  return {
    type: 'api',
    key: 'sk-or-v1-expired',
    metadata: {
      broker_refresh_token: 'broker-refresh-token',
      openrouter_key_expires_at: '2020-01-01T00:00:00Z',
    },
  };
}

function successfulRotation() {
  return {
    openrouter_api_key: 'sk-or-v1-recovered',
    openrouter_key_hash: 'recovered-hash',
    openrouter_key_label: 'recovered-label',
    openrouter_key_expires_at: '2099-01-01T00:00:00Z',
  };
}

async function createPlugin(options = {}) {
  const saved = [];
  const plugin = await openRouterAuthBrokerPlugin(
    {
      client: {
        auth: {
          async set(value) {
            saved.push(value);
          },
        },
      },
    },
    {
      providerID: 'lz-openrouter',
      brokerUrl: 'https://broker.example/api',
      autoLogin: true,
      ...options,
    },
  );
  return { plugin, saved };
}

test('expired credential keeps provider load available when broker refresh fails', async () => {
  const errors = [];
  console.error = (message) => errors.push(String(message));
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://broker.example/api/credentials/rotate');
    assert.equal(init.method, 'POST');
    assert.ok(init.signal instanceof AbortSignal);
    throw new TypeError('fetch failed');
  };

  const { plugin } = await createPlugin({ requestTimeoutMs: 25 });
  const loaded = await plugin.auth.loader(async () => expiredAuth(), {
    options: { baseURL: 'https://openrouter.ai/api/v1' },
  });

  assert.deepEqual(loaded, { apiKey: 'sk-or-v1-expired' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /keeping the provider available for request-time recovery/);
});

test('broker rotation is bounded by the configured request timeout', async () => {
  console.error = () => {};
  globalThis.fetch = async (_input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

  const { plugin } = await createPlugin({ requestTimeoutMs: 10 });
  const started = performance.now();
  const loaded = await plugin.auth.loader(async () => expiredAuth(), {
    options: { baseURL: 'https://openrouter.ai/api/v1' },
  });

  assert.deepEqual(loaded, { apiKey: 'sk-or-v1-expired' });
  assert.ok(performance.now() - started < 500);
});

test('expired credential self-heals on the next 401 after broker connectivity returns', async () => {
  const errors = [];
  console.error = (message) => errors.push(String(message));
  let brokerCalls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://broker.example/api/credentials/rotate');
    assert.ok(init.signal instanceof AbortSignal);
    brokerCalls += 1;
    if (brokerCalls === 1) throw new TypeError('broker temporarily unreachable');
    return new Response(JSON.stringify(successfulRotation()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { plugin, saved } = await createPlugin();
  const auth = expiredAuth();
  const loaded = await plugin.auth.loader(async () => auth, {
    options: { baseURL: 'https://openrouter.ai/api/v1' },
  });
  assert.deepEqual(loaded, { apiKey: auth.key });

  let inferenceCalls = 0;
  const config = {
    provider: {
      'lz-openrouter': {
        options: {
          async fetch(_input, init) {
            inferenceCalls += 1;
            const authorization = new Headers(init.headers).get('Authorization');
            if (inferenceCalls === 1) {
              assert.equal(authorization, `Bearer ${auth.key}`);
              return new Response('expired', { status: 401 });
            }
            assert.equal(authorization, 'Bearer sk-or-v1-recovered');
            return new Response('ok', { status: 200 });
          },
        },
      },
    },
  };
  plugin.config(config);

  const response = await config.provider['lz-openrouter'].options.fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    { headers: { Authorization: `Bearer ${auth.key}` } },
  );

  assert.equal(response.status, 200);
  assert.equal(brokerCalls, 2);
  assert.equal(inferenceCalls, 2);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].path.id, 'lz-openrouter');
  assert.equal(saved[0].body.key, 'sk-or-v1-recovered');
  assert.equal(saved[0].body.metadata.broker_refresh_token, 'broker-refresh-token');
  assert.equal(errors.length, 1);
});

test('concurrent expired-key loads share one credential rotation', async () => {
  let resolveRotation;
  let brokerCalls = 0;
  globalThis.fetch = async () => {
    brokerCalls += 1;
    await new Promise((resolve) => {
      resolveRotation = resolve;
    });
    return new Response(JSON.stringify(successfulRotation()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const { plugin } = await createPlugin();
  const provider = { options: { baseURL: 'https://openrouter.ai/api/v1' } };
  const first = plugin.auth.loader(async () => expiredAuth(), provider);
  const second = plugin.auth.loader(async () => expiredAuth(), provider);
  await new Promise((resolve) => setImmediate(resolve));
  resolveRotation();

  const loaded = await Promise.all([first, second]);
  assert.deepEqual(loaded, [
    { apiKey: 'sk-or-v1-recovered' },
    { apiKey: 'sk-or-v1-recovered' },
  ]);
  assert.equal(brokerCalls, 1);
});
