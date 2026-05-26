# OpenCode OpenRouter Auth Broker Plugin

Generic OpenCode plugin for broker-managed OpenRouter credentials.

The plugin registers a native OpenCode auth provider. Users authenticate through OpenCode's existing provider login flow; the broker performs browser-based OpenRouter auth, creates a managed OpenRouter API key, and returns it to OpenCode for storage in OpenCode's normal auth store.

## Broker Contract

The broker is expected to implement:

- `GET /auth/openrouter/start?return_to=http://127.0.0.1:<port>/callback`
- `POST /auth/openrouter/credential` with `{ "code": "..." }`

The credential exchange response must include:

```json
{
  "openrouter_api_key": "sk-or-v1-...",
  "broker_refresh_token": "...",
  "openrouter_key_hash": "...",
  "openrouter_key_label": "...",
  "openrouter_key_expires_at": "..."
}
```

## OpenCode Config

```json
{
  "plugin": [
    [
      "opencode-openrouter-auth-broker-plugin",
      {
        "providerID": "openrouter-broker",
        "brokerUrl": "https://your-broker.example.com",
        "envName": "OPENROUTER_API_KEY"
      }
    ]
  ],
  "provider": {
    "openrouter-broker": {
      "name": "OpenRouter Broker",
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://openrouter.ai/api/v1"
      },
      "models": {
        "openai/gpt-5.5": {
          "name": "GPT-5.5"
        }
      }
    }
  }
}
```

## Login

```bash
opencode providers login --provider openrouter-broker --method "Browser sign-in"
```

OpenCode will print/open the browser auth URL and wait for the localhost callback. On success it stores the returned OpenRouter API key as the provider credential in OpenCode's normal auth store.

The plugin opens the browser automatically by default when auth starts. Set plugin option `openBrowser: false` or environment variable `OPENCODE_OPENROUTER_AUTH_NO_OPEN=1` to only print the URL.

The local callback server uses an ephemeral port by default, so it should not collide with common development ports. Set `authPort` only if your broker requires a fixed callback port.

For deployments where the broker requires identity headers during auth-start, configure `startHeaders` in plugin options. This is intended for controlled enterprise/MDM environments.

## Optional Auto-login

Set `autoLogin: true` to have the plugin start the same browser auth flow automatically on the first model request when no usable provider credential is present.

```json
{
  "providerID": "openrouter-broker",
  "brokerUrl": "https://your-broker.example.com",
  "autoLogin": true
}
```

## Revoked Key Handling

Revoked-key refresh is planned, but not enabled in the current version. If a broker-managed OpenRouter key is revoked directly in OpenRouter, re-run the browser sign-in flow to mint a fresh key.
