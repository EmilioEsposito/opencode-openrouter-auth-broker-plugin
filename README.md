# OpenCode OpenRouter Auth Broker Plugin

Generic OpenCode plugin for broker-managed OpenRouter credentials.

The plugin registers a native OpenCode auth provider. Users authenticate through OpenCode's existing provider login flow; the broker performs browser-based OpenRouter auth, creates a managed OpenRouter API key, and returns it to OpenCode for storage in OpenCode's normal auth store.

## Broker Contract

The broker is expected to implement:

- `GET /auth/openrouter/start?return_to=http://127.0.0.1:<port>/callback`
- `POST /auth/openrouter/credential` with `{ "code": "..." }`
- `POST /credentials/rotate` with `Authorization: Bearer <broker_refresh_token>`

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

On provider load, the plugin validates the stored OpenRouter key. If OpenRouter rejects it and a `broker_refresh_token` is available in auth metadata, the plugin rotates the key through the broker before the model request is sent. Set `validateOnLoad: false` to skip this validation call.

If an inference request still reaches OpenRouter with an expired or revoked stored key, the plugin traps a `401` response. It first re-reads OpenCode auth and retries with a newer stored key if another OpenCode instance already refreshed it. If auth still contains the stale key, it rotates credentials through the broker, saves the replacement key to OpenCode auth, and retries the request once.

Provider loading fails open when the broker is temporarily unreachable: OpenCode keeps the configured provider visible with its stored key instead of failing startup. A later request that receives `401` retries broker rotation, so the provider recovers without editing config or signing in again after broker connectivity returns. Broker and OpenRouter credential-management requests are bounded to 10 seconds by default; set `requestTimeoutMs` to a positive millisecond value to override that limit.

## Web Search

The plugin can give your session model inline web search backed by OpenRouter's
(non-deprecated)
[`openrouter:web_search` server tool](https://openrouter.ai/docs/guides/features/server-tools/web-search).
It works like Claude Code's WebSearch: the capability is offered on every turn,
but the model only searches when it decides it needs current information, and the
search runs **inside the model's own completion** with full conversation context
— no second model call, no separate search vendor, no telemetry.

Mechanism: the plugin's outbound `fetch` wrapper appends
`{ "type": "openrouter:web_search", ... }` to the `tools` array of each
`/chat/completions` request for this provider. OpenRouter executes the search
server-side under the broker-managed key and returns the grounded answer with
`url_citation` annotations. Injection is best-effort and fails open — it never
breaks an inference request.

It is enabled by default. Disable it with `webSearch: false`.

```json
{
  "plugin": [
    [
      "opencode-openrouter-auth-broker-plugin",
      {
        "providerID": "openrouter-broker",
        "brokerUrl": "https://your-broker.example.com",
        "webSearch": true,
        "webSearchEngine": "auto",
        "webSearchMaxResults": 8
      }
    ]
  ]
}
```

Web search options (all optional):

| Option                   | Default  | Description                                                                                                                        |
| ------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `webSearch`              | `true`   | Set `false` to not inject the web search server tool.                                                                             |
| `webSearchEngine`        | `"auto"` | `auto` \| `native` \| `exa` \| `firecrawl` \| `parallel` \| `perplexity`. `auto` uses native provider search, falling back to Exa. |
| `webSearchMaxResults`    | `8`      | Max results per search (1–25).                                                                                                     |
| `webSearchMaxCharacters` | _unset_  | Optional per-result character cap forwarded to OpenRouter.                                                                         |

The search runs through OpenRouter under the broker-managed key. With
`webSearchEngine: "auto"`, native-search-capable providers (Anthropic, OpenAI,
Google, …) serve the search themselves; models without native search fall back
to Exa via OpenRouter's server-side key, never an unauthenticated consumer
search endpoint.

> **Visibility note:** because the search is a server-side tool executed inside
> the completion, OpenCode does not render it as a separate tool-call line.
> Grounding surfaces as inline citations in the model's answer rather than a
> visible "web search" step.

## Publishing

This package publishes through GitHub Actions trusted publishing from
`.github/workflows/publish.yml`.

For maintainer release steps and verification, use:

- `.claude/skills/publish-package/SKILL.md`
