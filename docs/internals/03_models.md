# Models

Every model call goes through `packages/aikit`, which owns the wire shape, adapters, catalog format,
error normalization and cost. The harness owns where credentials live, catalog freshness, the
thinking level that runs, and retries.

## One Wire Protocol

aikit's `Message.Context` and event stream are the only shape the harness speaks. The harness stores
aikit messages as entry JSON ([codec.ts](../../packages/harness/src/context/codec.ts)), so a change
to aikit's message schema is a change to stored sessions, and readers must keep accepting old ones.

The transport underneath is the AI SDK. A catalog entry's `npm` names the package that calls it, and
that package decides the entry's `protocol` ([registry.ts](../../packages/aikit/src/llm/registry.ts)).
A provider is the catalog's id (`deepseek`, `zai`, `anthropic`); a protocol is one of the few aikit
knows, and many providers share `openai-compatible`. `openai-codex` and `github-copilot` have virtual
package names that resolve to [providers/](../../packages/aikit/src/providers/). Both send
Responses requests through our own Responses model, because it can declare tools added
mid-conversation in place. Copilot also routes Claude models to Anthropic Messages and other
vendors' models to Chat Completions.

A session can switch models between turns. [transform.ts](../../packages/aikit/src/llm/transform.ts)
never replays an errored or aborted assistant message, and replays signatures and reasoning items
only to the provider and protocol that produced them. Relaxing either rule sends one vendor's opaque
state to another, which rejects it.

A new protocol must be added to every table keyed on it: `KnownProviderEnum`, the package maps in
`registry.ts`, `registerAISDKProtocols`, `OptionsByProtocol`, and the harness's OAuth branches if it
logs in. modelgen drops models.dev models whose package is not in the map, and a provider left
with none.

## Credentials

API keys come only from the environment of the process running the harness. aikit tries the catalog
entry's `key`, then each `env` name ([runtime.ts](../../packages/aikit/src/llm/runtime.ts)). Settings
never hold a key: `apiKey: "${NAME}"` names the variable to read.

OAuth exists for `openai-codex` and `github-copilot`. Logins share one `auth.json`, keyed by provider
([storage.ts](../../packages/aikit/src/oauth/storage.ts)). A read treats an unreadable file as "no
login"; a write refuses it, because it rewrites the whole file and would drop the other logins.

[global.ts](../../packages/harness/src/global.ts) picks the file. An explicit `--home` pins
`<home>/aikit/auth.json`; otherwise aikit resolves `CODEWORK_CREDENTIALS`, then the default home. The
harness and the RPC server both ask `Global.authFile`, so a login saved by one is visible to the other.
`Harness.layer` resolves it once and hands the same value to model calls, MCP and the `Credentials`
service that provider lists read.

An environment token beats a stored login: `OPENAI_CODEX_API_KEY` for Codex, `COPILOT_GITHUB_TOKEN`
for Copilot. Copilot reads only that variable, never `GITHUB_TOKEN`, `GH_TOKEN` or another app's
sign-in: those usually lack Copilot access, and a token
CodeWork was never given must not become the identity a run bills as. A Copilot login's plan-specific
host travels only with that login's token ([catalog.ts](../../packages/harness/src/model/catalog.ts)).

A browser callback or device code cannot cross RPC. The CLI runs the login locally and sends the
credentials to the server, which stores them in its own home
([oauth.ts](../../packages/codework/src/server/oauth.ts)). Provider lists report credentials by
presence, not validity; nothing is sent to check them.

## The Model Catalog

`aikit modelgen` ([modelgen.ts](../../packages/aikit/src/cli/modelgen.ts)) builds the catalog from
models.dev and OpenRouter's public listing. Every four hours, CI rebuilds and checks it, and uploads
it to catalog.codework.sh only when the bytes changed
([catalog.yml](../../.github/workflows/catalog.yml), [catalog.ts](../../packages/aikit/scripts/catalog.ts),
[infra/catalog](../../infra/catalog/)). Keys are sorted so identical content gives identical bytes. A
catalog with an invalid entry, or missing a required flagship model, is never published: a broken
upstream must not empty every client's catalog.

The published catalog is built once, for everyone, without credentials. Where models.dev is wrong
(accepted efforts, temperature, real context windows, ids the API refuses), modelgen carries narrow
hand rules, each checked live against the provider. Provider model APIs verify a rule; they are not a
source. Narrowing to one account happens on the client with its credential: OpenRouter's
`/models/user` at download, Copilot's `/models` at login. `openai-codex` is derived from the `openai`
entries, since Codex serves the same models at the same prices.

The harness keeps the catalog at `<home>/models.gen.json`
([catalog.ts](../../packages/harness/src/model/catalog.ts)). A one-shot command checks it once; a
server checks on a timer and reloads aikit whenever the file's mtime moves. The download is
conditional on the MD5 of the last downloaded bytes, which equals R2's ETag only because the workflow
uploads with a single PUT. Those raw bytes are kept apart from the catalog because OpenRouter
narrowing changes what gets written ([remote.ts](../../packages/aikit/src/model/remote.ts)).

- A failed download keeps the old file. With no file, aikit reads its bundled baseline of `anthropic`,
  `openai` and `openrouter`, so an offline first run has no Codex or Copilot models.
- A provider in the file replaces the baseline's copy whole. Settings `models` entries overlay per
  model ([settings](./07_settings.md)).
- `CODEWORK_MODELS_FILE` pins a user-managed file. It is reloaded on change, and only an explicit
  `codework models refresh` writes it.
- The client drops models whose protocol or API method this aikit lacks, instead of failing at call
  time. That lets additive changes stay at `v1/`; a breaking change needs a new path, such as `v2/`.

The model is resolved once per turn setup and reused, so a reload never changes it under a running
turn. A provider with credentials but no catalog entries does not exist: lookup fails with
`ModelNotFoundError`, it never appears in a picker or default selection, and MCP servers that borrow
its token get none. A settings entry is the only way to use an unlisted model.

## Thinking Levels

One ladder runs from `off` to `max`. A catalog entry's `thinkingLevelMap` maps each level to the
provider's value; `null` marks a rejected level, and `xhigh` and `max` exist only when mapped
([model.ts](../../packages/aikit/src/model/model.ts)).

State clamps the level when it composes a session's config
([state.ts](../../packages/harness/src/state/state.ts)). The chosen level stays as written. What
runs, is stamped on the message and is shown is the clamped level, re-fitted whenever the model
changes. Clamping walks up before down, so an unsupported level gets more thinking, not less.

aikit clamps again and fits the thinking budget and the answer under one output ceiling and the
remaining context ([thinking.ts](../../packages/aikit/src/llm/thinking.ts)). When Anthropic's minimum
budget no longer fits, the turn goes out with thinking off rather than as an invalid request. Adapters
may drop an effort they think a model rejects, so trust the message's `providerThinkingLevel`, read
off the exact request body, over the requested level.

## Provider Errors

aikit turns every failure into a JSON-safe `Failure`: a category, `retryable`, and status, code,
request id and requested wait when known ([failure.ts](../../packages/aikit/src/llm/failure.ts)). It
classifies by provider code first, then HTTP status. Quota is told apart from rate limiting because a
quota often arrives as a retryable 429. The failure rides on the terminal message and is persisted.

The harness lifts it into `Runner.ProviderError` ([run.ts](../../packages/harness/src/runner/run.ts)),
the stable boundary for SDK and RPC consumers, who inspect `reason._tag`. The categories mirror
aikit's, but the vocabulary is the harness's own. Catalog failures are a separate `ModelCatalogError`.

A failure surfaces either thrown while opening the stream (a missing key) or as a failed terminal.
Inside `LLM.run` a failed terminal is the result, not an error, so it is published durably.
Interrupting a turn aborts the transport, but the consumer stays alive to publish aikit's terminal,
and the usage that request spent is still recorded.

## Retries

Only one of two retry layers is on. The provider SDK's `maxRetries` defaults to 0 in
[settings.ts](../../packages/plugin/src/settings.ts), so the layers never multiply and a quota error
reaches the loop. The agent-level policy in [retry.ts](../../packages/harness/src/runner/retry.ts)
retries only failures the provider calls transient, never a quota, and leaves context overflow to
compaction. A server's `retry-after` can raise the delay but not lower it; one beyond the policy's
ceiling gives up rather than retrying into the same rejection.

Nothing is committed before a turn ends, so each attempt resends the same context as a new draft. The
attempt count is persisted, and a host that died mid-request counts as a retryable transport failure
([runtime](./04_runtime.md)).

## Usage and Cost

aikit prices each response from the catalog at that moment, including context tiers, the service tier
actually served, and Anthropic's 1h cache writes
([pricing.ts](../../packages/aikit/src/llm/pricing.ts), `calculateCost` in
[model.ts](../../packages/aikit/src/model/model.ts)). Cost is stored on the message, so a later
price change never rewrites history. aikit's `usage.input` excludes cached tokens; telemetry adds them
back, as the GenAI conventions count them.

The rollup ([usage.ts](../../packages/harness/src/usage/usage.ts)) counts committed and aborted
assistant entries, because an aborted request is still billed. Each entry counts once, at the
transition that finalises it.
