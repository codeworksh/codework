# GitHub Copilot

The GitHub Copilot provider lets you use models served by `api.githubcopilot.com` — Claude, GPT, Gemini, Grok, Kimi, and others — with a Copilot subscription.

## Setup

Copilot authenticates with GitHub OAuth. Sign in through the bundled CLI device flow:

```bash
pnpm aikit auth --github-copilot

# GitHub Enterprise
pnpm aikit auth --github-copilot --enterprise your.ghe.domain
```

Credentials are stored in `~/.codework/aikit/auth.json` under the `github-copilot` key. Login records the plan-specific API endpoint (individual vs. business) and the account's available model ids.

A token can also be supplied directly, instead of logging in:

```bash
export COPILOT_GITHUB_TOKEN="ghu_..."
```

Precedence is `COPILOT_GITHUB_TOKEN` → `auth.json`, and nothing else. Two sources are deliberately excluded:

- `GITHUB_TOKEN` / `GH_TOKEN` — usually set for git or `gh` and carrying no Copilot access; in GitHub Actions `GITHUB_TOKEN` is a workflow token. Reading them would turn a working login into an unexplained 401.
- Credentials another application stored for itself, such as an editor's Copilot sign-in in `~/.config/github-copilot/hosts.json`. A token codework was never given should not silently become the identity its runs bill and act as — least of all invisibly, since `auth --status` only reports what is in `auth.json`.

GitHub OAuth tokens are used directly as the `Authorization: Bearer` credential. They do not expire; re-run `auth --github-copilot` if calls start returning persistent `401`s.

## Language Models

```ts
import { llm, stream, Message } from "@codeworksh/aikit";

// Claude Opus 5 via the Anthropic Messages route
const model = await llm("github-copilot", "claude-opus-5");

const message = await stream.complete(model, {
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Explain recursion briefly." }],
		}),
	],
});
```

## Endpoint routing

Each catalog model carries `api.method`, which selects the wire protocol on the shared Copilot host:

| Models                                                 | `api.method` | Endpoint                 |
| ------------------------------------------------------ | ------------ | ------------------------ |
| `claude-(haiku\|sonnet\|opus\|fable)-[45]*`            | `messages`   | `POST /v1/messages`      |
| `gpt-5+`, `grok-*`, `oswe*`, `mai-*`                   | `responses`  | `POST /responses`        |
| everything else (`gpt-4.1`, `gemini-*`, `kimi-*`, ...) | `chat`       | `POST /chat/completions` |

The authenticated `/models` catalog's `supported_endpoints` is authoritative; the static routing above is the offline approximation.

Every request sends the Copilot identity headers (`User-Agent: GitHubCopilotChat/…`, `Editor-Version`, `Editor-Plugin-Version`, `Copilot-Integration-Id`, `X-GitHub-Api-Version`) plus `x-initiator` (`user` vs `agent`, inferred from the last message role) and `Copilot-Vision-Request` when the payload contains images. `options.sessionId` maps to `X-Interaction-Id` for session grouping.

## Thinking / reasoning

Copilot models carry `thinkingLevelMap` derived from the live catalog's `reasoning_options`, with manual overrides for verified behavior (e.g. Opus 4.7/4.8/5 clamp `minimal` to `low`). Adaptive Claude models send `effort` instead of a token budget; Responses models send `reasoningEffort` with `store: false` + encrypted reasoning content; the chat route has no reasoning control.

```ts
await stream.complete(model, context, { reasoning: "high" });
```

## CLI

```bash
pnpm aikit auth --github-copilot            # device-flow login
pnpm aikit auth --github-copilot --status   # stored credential status (no tokens)
pnpm aikit auth --github-copilot --logout   # clear credentials
pnpm aikit auth --github-copilot --enable-models  # also enable `unconfigured` catalog models
```

Note: Copilot Free accounts (`free_limited_copilot` SKU) can only reach a small subset of models — typically just `gpt-4.1` — regardless of what the catalog lists. Plan-restricted models fail with `model_not_supported`.
