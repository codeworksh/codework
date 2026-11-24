# @codeworksh/aikit

aikit is the model layer of [CodeWork](https://www.codework.sh): one message and event shape over many LLM providers, a model catalog with pricing, and cost tracking per message. The CodeWork harness makes every model call through it, and you can use it on its own when you want streaming primitives and to run the loop yourself.

```bash
pnpm add @codeworksh/aikit
```

Node 22 or later is required.

## Quick Start

```ts
import { llm, Message, stream } from "@codeworksh/aikit";

const model = await llm("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("Model not in the catalog");

const context: Message.Context = {
	systemPrompt: "You are a helpful coding assistant.",
	messages: [
		Message.createUserMessage({
			role: "user",
			time: { created: Date.now() },
			parts: [{ type: "text", text: "Write a loop in TypeScript." }],
		}),
	],
};

// The key is read from ANTHROPIC_API_KEY unless you pass { apiKey }.
const s = stream(model, context);
for await (const event of s) {
	if (event.type === "text.delta") process.stdout.write(event.delta);
}

const message = await s.result();
console.log(message.stopReason, message.usage.cost.total);
```

A failed request does not throw. The stream ends with an `error` event, and the final message has `stopReason: "error"` and an `errorMessage`. `stream.complete(model, context)` skips the events and resolves the final message.

## What It Owns

aikit owns the wire shape (`Message`, `Event`), the provider adapters, the catalog format, error normalization and cost. Protocols: `anthropic`, `openai`, `openai-codex`, `github-copilot`, `openrouter`, `google`, `google-vertex`, `google-vertex-anthropic`, `xai` and `openai-compatible`. The transport underneath is the AI SDK.

It depends on no other CodeWork package and does not use Effect. The harness depends on it, never the reverse, so aikit stays a plain library anyone can embed. Where credentials live, how fresh the catalog is, and retries belong to the embedder.

A session can switch models between turns. aikit replays signatures and reasoning only to the provider that produced them, so one vendor's opaque state never reaches another.

## The Model Catalog

`llm(provider, model)` looks a model up in `./models.gen.json`, or the file `CODEWORK_MODELS_FILE` names. A bundled baseline covers `anthropic`, `openai` and `openrouter`, so a first run works with no file at all. `llm.providers()` and `llm.models(provider)` list what the catalog has.

The package ships an `aikit` binary:

```bash
aikit modelgen [path]               # build the catalog from models.dev and OpenRouter's listing
aikit auth --openai-codex           # OAuth login; --device for a device code, --status, --refresh, --logout
aikit auth --github-copilot         # device flow; --enterprise <domain> for GitHub Enterprise
```

## Code Map

- [`src/index.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/index.ts): the public exports.
- [`src/stream.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/stream.ts): `stream` and `stream.complete`.
- [`src/llm.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/llm.ts): model lookup over the catalog.
- [`src/message/message.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/message/message.ts): `Context`, messages, tools and usage.
- [`src/event/event.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/event/event.ts): the stream's events.
- [`src/llm/`](https://github.com/codeworksh/codework/tree/main/packages/aikit/src/llm): protocol registry, provider options, cross-model replay ([`transform.ts`](https://github.com/codeworksh/codework/blob/main/packages/aikit/src/llm/transform.ts)) and failures.
- [`src/model/`](https://github.com/codeworksh/codework/tree/main/packages/aikit/src/model): catalog loading and the bundled baseline.
- [`src/providers/`](https://github.com/codeworksh/codework/tree/main/packages/aikit/src/providers): the `openai-codex` and `github-copilot` providers.
- [`src/oauth/`](https://github.com/codeworksh/codework/tree/main/packages/aikit/src/oauth) and [`src/cli/`](https://github.com/codeworksh/codework/tree/main/packages/aikit/src/cli): logins and the `aikit` binary.

## Working Locally

From `packages/aikit`:

```bash
pnpm test        # unit tests
pnpm test:e2e    # also runs test/e2e, which calls live providers
pnpm typecheck
pnpm build       # vp pack
pnpm cli modelgen
```

For the rules on credentials, catalog publishing and adding a protocol, see [docs/internals/03_models.md](https://github.com/codeworksh/codework/blob/main/docs/internals/03_models.md).
