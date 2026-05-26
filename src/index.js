import { execFile } from 'node:child_process';
import http from 'node:http';

const DEFAULT_PROVIDER_ID = 'openrouter-broker';
const DEFAULT_AUTH_PORT = 0;

function brokerEndpoint(brokerUrl, path) {
  return `${String(brokerUrl).replace(/\/$/, '')}${path}`;
}

function parseStartHeaders(values = []) {
  const headers = {};
  for (const value of values) {
    const index = String(value).indexOf(':');
    if (index === -1) continue;
    const name = String(value).slice(0, index).trim();
    const headerValue = String(value).slice(index + 1).trim();
    if (name) headers[name] = headerValue;
  }
  return headers;
}

function startCallbackServer(port, path = '/callback') {
  return new Promise((resolve, reject) => {
    let completedCode;
    let closeTimer;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== path) {
        res.writeHead(404).end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      if (!code && completedCode) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><h1>OpenRouter auth complete</h1><p>You can close this window.</p>');
        return;
      }
      if (!code) {
        res.writeHead(400).end('Missing code');
        reject(new Error('Broker callback did not include code'));
        server.close();
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><h1>OpenRouter auth complete</h1><p>You can close this window.</p>');
      if (!completedCode) {
        completedCode = code;
        resolveCode(code);
        closeTimer = setTimeout(() => server.close(), 15000);
      }
    });

    let resolveCode;
    const callbackPromise = new Promise((resolveCallback) => {
      resolveCode = resolveCallback;
    });

    server.on('error', (error) => {
      if (closeTimer) clearTimeout(closeTimer);
      reject(error);
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not determine callback server port'));
        return;
      }
      resolve({ port: address.port, callbackPromise });
    });
  });
}

async function resolveAuthUrl({ brokerUrl, returnTo, startHeaders }) {
  const authUrl = new URL(brokerEndpoint(brokerUrl, '/auth/openrouter/start'));
  authUrl.searchParams.set('return_to', returnTo);

  if (!startHeaders?.length) return authUrl.toString();

  const response = await fetch(authUrl, {
    redirect: 'manual',
    headers: parseStartHeaders(startHeaders),
  });

  if (![301, 302, 303, 307, 308].includes(response.status)) {
    const text = await response.text();
    throw new Error(`Auth start failed with ${response.status}: ${text}`);
  }

  const location = response.headers.get('location');
  if (!location) throw new Error('Auth start response did not include Location header');
  return location;
}

function openBrowser(url) {
  if (process.env.OPENCODE_OPENROUTER_AUTH_NO_OPEN === '1') return;

  if (process.platform === 'darwin') {
    execFile('open', [url]);
    return;
  }
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url]);
    return;
  }
  execFile('xdg-open', [url]);
}

async function exchangeCode(brokerUrl, code) {
  const response = await fetch(brokerEndpoint(brokerUrl, '/auth/openrouter/credential'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail || body.error?.message || `Credential exchange failed with ${response.status}`);
  }
  return body;
}

async function rotateCredentials(brokerUrl, refreshToken) {
  const response = await fetch(brokerEndpoint(brokerUrl, '/credentials/rotate'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.detail || body.error?.message || `Credential rotation failed with ${response.status}`);
  }
  return body;
}

async function runBrokerLogin({ brokerUrl, authPort, startHeaders, autoOpenBrowser }) {
  if (!brokerUrl) throw new Error('Missing required plugin option: brokerUrl');
  const callback = await startCallbackServer(authPort);
  const returnTo = `http://127.0.0.1:${callback.port}/callback`;
  const url = await resolveAuthUrl({ brokerUrl, returnTo, startHeaders });
  if (autoOpenBrowser) openBrowser(url);
  const code = await callback.callbackPromise;
  return exchangeCode(brokerUrl, code);
}

async function saveOpenCodeAuth(client, providerID, credentials) {
  if (!client?.auth?.set) return;
  const auth = {
    type: 'api',
    key: credentials.openrouter_api_key,
    metadata: {
      broker_refresh_token: credentials.broker_refresh_token ?? '',
      openrouter_key_hash: credentials.openrouter_key_hash ?? '',
      openrouter_key_label: credentials.openrouter_key_label ?? '',
      openrouter_key_expires_at: credentials.openrouter_key_expires_at ?? '',
    },
  };

  try {
    await client.auth.set({ path: { id: providerID }, body: auth });
    return;
  } catch {}

  try {
    await client.auth.set({ providerID, auth });
  } catch {}
}

export default async function openRouterAuthBrokerPlugin(ctx, options = {}) {
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID;
  const brokerUrl = options.brokerUrl;
  const authPort = Number(options.authPort ?? DEFAULT_AUTH_PORT);
  const startHeaders = Array.isArray(options.startHeaders) ? options.startHeaders : [];
  const autoOpenBrowser = options.openBrowser !== false;
  const autoLogin = options.autoLogin === true;
  let autoLoginPromise;
  let cachedApiKey;

  return {
    auth: {
      provider: providerID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type === 'api' && auth.key) {
          return { apiKey: auth.key };
        }
        return {};
      },
      methods: [
        {
          type: 'oauth',
          label: 'Browser sign-in',
          async authorize() {
            const loginPromise = runBrokerLogin({ brokerUrl, authPort, startHeaders, autoOpenBrowser });

            return {
              url: 'about:blank',
              instructions: 'Complete OpenRouter authorization in your browser. OpenCode will store the broker-managed OpenRouter API key when authorization completes.',
              method: 'auto',
              async callback() {
                try {
                  const credentials = await loginPromise;
                  return {
                    type: 'success',
                    provider: providerID,
                    key: credentials.openrouter_api_key,
                    metadata: {
                      broker_refresh_token: credentials.broker_refresh_token ?? '',
                      openrouter_key_hash: credentials.openrouter_key_hash ?? '',
                      openrouter_key_label: credentials.openrouter_key_label ?? '',
                      openrouter_key_expires_at: credentials.openrouter_key_expires_at ?? '',
                    },
                  };
                } catch {
                  console.error('OpenRouter broker auth failed');
                  return { type: 'failed' };
                }
              },
            };
          },
        },
        {
          type: 'api',
          label: 'Paste OpenRouter API key',
        },
      ],
    },
    config(config) {
      const provider = config.provider?.[providerID];
      if (!provider) return;
      provider.options ??= {};
      if (provider.options.apiKey === '') {
        delete provider.options.apiKey;
      }
      if (!autoLogin) return;

      const configuredFetch = provider.options.fetch;
      provider.options.fetch = async (input, init = {}) => {
        const headers = new Headers(input instanceof Request ? input.headers : undefined);
        if (init.headers) {
          const entries = init.headers instanceof Headers
            ? init.headers.entries()
            : Array.isArray(init.headers)
              ? init.headers
              : Object.entries(init.headers);
          for (const [key, value] of entries) {
            if (value !== undefined) headers.set(key, String(value));
          }
        }

        const existing = headers.get('Authorization');
        if (existing && existing !== 'Bearer ' && !existing.endsWith('undefined')) {
          return (configuredFetch ?? fetch)(input, { ...init, headers });
        }

        if (!cachedApiKey) {
          autoLoginPromise ??= runBrokerLogin({ brokerUrl, authPort, startHeaders, autoOpenBrowser })
            .then(async (credentials) => {
              cachedApiKey = credentials.openrouter_api_key;
              await saveOpenCodeAuth(ctx.client, providerID, credentials);
              return credentials;
            })
            .finally(() => {
              autoLoginPromise = undefined;
            });
          await autoLoginPromise;
        }

        headers.set('Authorization', `Bearer ${cachedApiKey}`);
        return (configuredFetch ?? fetch)(input, { ...init, headers });
      };
    },
  };
}
