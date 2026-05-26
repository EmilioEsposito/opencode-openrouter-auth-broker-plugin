import { execFile } from 'node:child_process';
import http from 'node:http';

const DEFAULT_PROVIDER_ID = 'openrouter-broker';
const DEFAULT_BROKER_URL = 'http://localhost:3000';
const DEFAULT_AUTH_PORT = 19877;

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

function waitForCallback(port, path = '/callback') {
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
        resolve(code);
        closeTimer = setTimeout(() => server.close(), 15000);
      }
    });

    server.on('error', (error) => {
      if (closeTimer) clearTimeout(closeTimer);
      reject(error);
    });
    server.listen(port, '127.0.0.1');
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

export default async function openRouterAuthBrokerPlugin(_ctx, options = {}) {
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID;
  const brokerUrl = options.brokerUrl ?? DEFAULT_BROKER_URL;
  const authPort = Number(options.authPort ?? DEFAULT_AUTH_PORT);
  const startHeaders = Array.isArray(options.startHeaders) ? options.startHeaders : [];
  const autoOpenBrowser = options.openBrowser !== false;

  return {
    auth: {
      provider: providerID,
      async loader(getAuth) {
        const auth = await getAuth();
        if (auth?.type === 'api' && auth.key) {
          return {
            apiKey: 'opencode-openrouter-auth-broker',
            async fetch(input, init = {}) {
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
              headers.set('Authorization', `Bearer ${auth.key}`);
              return fetch(input, { ...init, headers });
            },
          };
        }
        return {};
      },
      methods: [
        {
          type: 'oauth',
          label: 'Browser sign-in',
          async authorize() {
            const returnTo = `http://127.0.0.1:${authPort}/callback`;
            const callbackPromise = waitForCallback(authPort);
            const url = await resolveAuthUrl({ brokerUrl, returnTo, startHeaders });
            if (autoOpenBrowser) openBrowser(url);

            return {
              url,
              instructions: 'Complete OpenRouter authorization in your browser. OpenCode will store the broker-managed OpenRouter API key when authorization completes.',
              method: 'auto',
              async callback() {
                try {
                  const code = await callbackPromise;
                  const credentials = await exchangeCode(brokerUrl, code);
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
      if (provider?.options?.apiKey === '') {
        delete provider.options.apiKey;
      }
    },
  };
}
