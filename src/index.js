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
  return {
    ...body,
    broker_refresh_token: body.broker_refresh_token ?? refreshToken,
  };
}

async function validateOpenRouterKey(baseURL, apiKey) {
  const response = await fetch(brokerEndpoint(baseURL || 'https://openrouter.ai/api/v1', '/key'), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return response.ok;
}

const DEFAULT_WEB_SEARCH_ENGINE = 'auto';
const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8;

// Inject OpenRouter's `openrouter:web_search` server tool into an outbound
// /chat/completions request body. This rides on the model's own request so the
// model can search inline (same architecture as Claude Code's WebSearch:
// model-decided, executed server-side, full conversation context). Returns the
// mutated body string, or the original if injection isn't applicable / already
// present. Never throws — web search must never break an inference request.
function injectWebSearchTool(bodyText, { engine, maxResults, maxCharacters }) {
  try {
    if (typeof bodyText !== 'string' || !bodyText) return bodyText;
    const body = JSON.parse(bodyText);
    // Only chat/completions requests carry a messages array + tools.
    if (!Array.isArray(body.messages)) return bodyText;
    const tools = Array.isArray(body.tools) ? body.tools : [];
    if (tools.some((t) => t && t.type === 'openrouter:web_search')) return bodyText;
    const parameters = { engine, max_results: maxResults };
    if (Number.isFinite(maxCharacters)) parameters.max_characters = maxCharacters;
    body.tools = [...tools, { type: 'openrouter:web_search', parameters }];
    return JSON.stringify(body);
  } catch {
    return bodyText;
  }
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

async function readOpenCodeAuth(client, providerID) {
  if (!client?.auth?.get) return;
  try {
    const response = await client.auth.get({ path: { id: providerID } });
    return response?.data ?? response;
  } catch {}

  try {
    const response = await client.auth.get({ providerID });
    return response?.data ?? response;
  } catch {}
}

export default async function openRouterAuthBrokerPlugin(ctx, options = {}) {
  const providerID = options.providerID ?? DEFAULT_PROVIDER_ID;
  const brokerUrl = options.brokerUrl;
  const authPort = Number(options.authPort ?? DEFAULT_AUTH_PORT);
  const startHeaders = Array.isArray(options.startHeaders) ? options.startHeaders : [];
  const autoOpenBrowser = options.openBrowser !== false;
  const autoLogin = options.autoLogin === true;
  const webSearchEnabled = options.webSearch !== false;
  const webSearchEngine = options.webSearchEngine ?? DEFAULT_WEB_SEARCH_ENGINE;
  const webSearchMaxResults = Number(options.webSearchMaxResults ?? DEFAULT_WEB_SEARCH_MAX_RESULTS);
  const webSearchMaxCharacters = options.webSearchMaxCharacters != null
    ? Number(options.webSearchMaxCharacters)
    : undefined;
  const webSearchParams = {
    engine: webSearchEngine,
    maxResults: webSearchMaxResults,
    maxCharacters: webSearchMaxCharacters,
  };
  let autoLoginPromise;
  let cachedApiKey;
  let cachedRefreshToken;
  let refreshPromise;
  let latestGetAuth;

  function rememberCredentials(credentials) {
    cachedApiKey = credentials.openrouter_api_key;
    cachedRefreshToken = credentials.broker_refresh_token ?? cachedRefreshToken;
  }

  function cloneFetchInput(input) {
    return input instanceof Request ? input.clone() : input;
  }

  async function refreshCredentials() {
    if (!cachedRefreshToken) return;
    refreshPromise ??= rotateCredentials(brokerUrl, cachedRefreshToken)
      .then(async (credentials) => {
        rememberCredentials(credentials);
        await saveOpenCodeAuth(ctx.client, providerID, credentials);
        return credentials;
      })
      .finally(() => {
        refreshPromise = undefined;
      });
    return refreshPromise;
  }

  async function readStoredAuth() {
    if (latestGetAuth) {
      try {
        return await latestGetAuth();
      } catch {}
    }
    return readOpenCodeAuth(ctx.client, providerID);
  }

  async function refreshAndRetryOnUnauthorized(response, input, init, headers, fetcher) {
    if (response.status !== 401 || !cachedRefreshToken) return response;

    const staleAuthorization = headers.get('Authorization');
    const latestAuth = await readStoredAuth();
    if (latestAuth?.type === 'api' && latestAuth.key && `Bearer ${latestAuth.key}` !== staleAuthorization) {
      cachedApiKey = latestAuth.key;
      cachedRefreshToken = latestAuth.metadata?.broker_refresh_token ?? cachedRefreshToken;
      headers.set('Authorization', `Bearer ${latestAuth.key}`);
      return fetcher(cloneFetchInput(input), { ...init, headers });
    }

    const credentials = await refreshCredentials().catch((error) => {
      console.error(`OpenRouter broker credential rotation failed after 401: ${error.message}`);
      return undefined;
    });
    if (!credentials?.openrouter_api_key) return response;

    headers.set('Authorization', `Bearer ${credentials.openrouter_api_key}`);
    return fetcher(cloneFetchInput(input), { ...init, headers });
  }

  return {
    auth: {
      provider: providerID,
      async loader(getAuth, provider) {
        latestGetAuth = getAuth;
        const auth = await getAuth();
        if (auth?.type === 'api' && auth.key) {
          cachedApiKey = auth.key;
          cachedRefreshToken = auth.metadata?.broker_refresh_token ?? cachedRefreshToken;
          const expiresAt = auth.metadata?.openrouter_key_expires_at;
          const expiresSoon = expiresAt ? Date.parse(expiresAt) < Date.now() + 24 * 60 * 60 * 1000 : false;
          const validateOnLoad = options.validateOnLoad !== false;
          const valid = validateOnLoad && !expiresSoon
            ? await validateOpenRouterKey(provider?.options?.baseURL, auth.key).catch(() => true)
            : true;
          if ((expiresSoon || !valid) && auth.metadata?.broker_refresh_token) {
            const credentials = await refreshCredentials();
            return { apiKey: credentials.openrouter_api_key };
          }
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
      // Install the fetch wrapper when auto-login OR web search is enabled. Web
      // search injects the openrouter:web_search server tool into the outbound
      // request body so the model can search inline.
      if (!autoLogin && !webSearchEnabled) return;

      const configuredFetch = provider.options.fetch;
      provider.options.fetch = async (input, init = {}) => {
        // Best-effort inline web search injection (never throws, fails open).
        if (webSearchEnabled) {
          const url = input instanceof Request ? input.url : String(input ?? '');
          if (url.includes('/chat/completions') && typeof init.body === 'string') {
            init = { ...init, body: injectWebSearchTool(init.body, webSearchParams) };
          }
        }

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

        const fetcher = configuredFetch ?? fetch;
        const existing = headers.get('Authorization');
        if (existing && existing !== 'Bearer ' && !existing.endsWith('undefined')) {
          const response = await fetcher(cloneFetchInput(input), { ...init, headers });
          return refreshAndRetryOnUnauthorized(response, input, init, headers, fetcher);
        }

        // No usable Authorization yet. If auto-login is off, just forward (the
        // broker's auth loader supplies the key through OpenCode's normal flow).
        if (!autoLogin) {
          const response = await fetcher(cloneFetchInput(input), { ...init, headers });
          return refreshAndRetryOnUnauthorized(response, input, init, headers, fetcher);
        }

        if (!cachedApiKey) {
          autoLoginPromise ??= runBrokerLogin({ brokerUrl, authPort, startHeaders, autoOpenBrowser })
            .then(async (credentials) => {
              rememberCredentials(credentials);
              await saveOpenCodeAuth(ctx.client, providerID, credentials);
              return credentials;
            })
            .finally(() => {
              autoLoginPromise = undefined;
            });
          await autoLoginPromise;
        }

        headers.set('Authorization', `Bearer ${cachedApiKey}`);
        const response = await fetcher(cloneFetchInput(input), { ...init, headers });
        return refreshAndRetryOnUnauthorized(response, input, init, headers, fetcher);
      };
    },
  };
}
