# ADR: Inline web search via outbound-request injection

**Status:** Accepted (implemented in 0.2.0)

## Context

OpenCode has no built-in web search for custom OpenRouter providers. We wanted
to give the agent real web search (discovery of pages it can't guess the URL
for — distinct from `webfetch`, which retrieves a known URL) with these
constraints:

- **Model-controlled** — search only when the model decides it needs current
  information, not forced on every request.
- **Single backend / no new vendor** — route through OpenRouter only; do not
  add a separate search vendor or credential.
- **No telemetry**, and never hit an unauthenticated consumer search endpoint
  whose queries are training-eligible.
- **Reuse the broker-managed key** — no second credential, no separate login.

OpenRouter exposes web search **only** through the chat/completions
[`openrouter:web_search` server tool](https://openrouter.ai/docs/guides/features/server-tools/web-search)
(or the deprecated, always-on `web` plugin / `:online` variant). There is no raw
"search → JSON results" REST endpoint.

## Decision

Inject `{ "type": "openrouter:web_search", parameters: { engine, max_results } }`
into the `tools` array of each `/chat/completions` request, from inside the
plugin's outbound `fetch` wrapper (the same wrapper that injects the broker auth
header). The **session model runs the search inline**, mid-turn, with full
conversation context — one hop, no second model call. OpenRouter executes the
tool server-side under the broker key and returns the answer with
`url_citation` annotations.

This mirrors Claude Code's WebSearch architecture: the capability is attached to
every turn, but the model only invokes (and bills) it when needed.

Enabled by default; `webSearch: false` disables injection. Engine defaults to
`auto` (native provider search, falling back to Exa via OpenRouter's
server-side key for models without native search — never the consumer endpoint).

## Alternatives considered (verified empirically by capturing the outbound body)

- **OpenCode built-in `websearch`** — gated behind `OPENCODE_ENABLE_EXA` (an env
  var, not shippable via config) and hits Exa's *unauthenticated consumer*
  endpoint where queries are training-eligible. Rejected on privacy + delivery.
- **Config-level injection** — provider `options.extraBody`, `options.tools`,
  and the `chat.params` hook are all silently dropped/rebuilt by
  `@ai-sdk/openai-compatible` / OpenCode before the request hits the wire.
  Per-model `options.plugins` *does* reach the wire but uses the deprecated,
  always-on `web` plugin (one paid search per message). The outbound `fetch`
  wrapper is the one seam downstream OpenCode logic cannot overwrite.
- **Visible custom tool + second LLM call** — a `web_search` tool whose
  `execute()` makes a separate grounded chat/completions call. Works and is
  visible/governable, but costs a second model hop, needs a dedicated search
  model (the tool context does not expose the session model), and loses
  conversation context. Rejected once inline injection was proven.
- **Community plugins** — Firecrawl adds a new vendor; `opencode-websearch`
  (native) keys on standard provider ids and can't see a custom provider;
  `opencode-websearch-cited` hardcodes provider id `openrouter` + a separate key
  and uses the deprecated `web` plugin. None reuse a broker-managed key as-is.

Note: with no web search configured, models still appear to "ground" answers —
that is OpenCode's `webfetch` guessing canonical URLs, not search. Confirmed the
server tool sends `web_search_requests=none` until injected.

## Consequences

- **No second model hop, no dedicated search model, full context.** Simplest
  possible integration; no `@opencode-ai/plugin` dependency.
- **Visibility tradeoff:** because the search is a server-side tool executed
  inside the completion, OpenCode does not render a "web search" tool-call line.
  Grounding surfaces as inline citations rather than a visible step. (Claude
  Code shows a chip because its harness renders Anthropic's `server_tool_use`
  blocks; OpenCode does not render OpenRouter's equivalent. Same architecture,
  different harness rendering.)
- **Not governed by OpenCode's tool/permission layer** — it is a provider-side
  tool, not an OpenCode function tool. Acceptable because it is read-only web
  search routed through the same provider already in use.
- **Depends on the outbound `fetch` interception seam.** Robust today and
  fail-open (injection is wrapped in try/catch and never breaks an inference
  request), but a future change to how OpenCode serializes requests could
  require revisiting. The injector tolerates non-JSON bodies and skips requests
  that already carry the tool.

## Verification

Build the plugin, point the plugin entry at the local `dist` build, and ask a
current-events question. Grounding shows as inline citations with
`?utm_source=...` markers. To prove the server tool fired, capture the response
for `usage.server_tool_use.web_search_requests` with a fetch-wrapping observer
plugin listed **before** this plugin (so it becomes the inner `configuredFetch`
and sees the post-injection body). A "reply ok" prompt should yield zero
searches; a current-events prompt should yield ≥1.
