# @codeworksh/harness

> **Beta:** This package is an early release. Expect breaking changes.

`@codeworksh/harness` is an agent harness built with [Effect v4 beta](https://github.com/Effect-TS/effect) and powered by [`@codeworksh/aikit`](https://www.npmjs.com/package/@codeworksh/aikit).
It leverages Effect's typed services, layers, scopes, streams, and structured errors to agent loops, durable sessions, tool execution, and local or remote sandboxes.

The initial public surface is the Effect SDK at `@codeworksh/harness/effect`.

## Features

- **Durable Sessions:** create, attach, resume, interrupt, and inspect agent sessions without rebuilding orchestration around every turn.
- **Streaming Agent Loop:** consume durable session events while the loop coordinates model output, tool calls, and continuations.
- **Tool Execution:** use the built-in Bash tool or register typed tools with sequential or parallel execution.
- **Model Flexibility:** select any provider and model available in Aikit's generated catalog, including its supported thinking levels.
- **Pluggable Sandboxes:** run the same workflow against the host machine, a virtual filesystem, or a remote sandbox.

## Plugins

Pass an ordered plugin list when constructing the harness. Each plugin has a required ID and contributes tools or a prompt during setup. Setup runs once per exchange, after model resolution; its tools, hooks, and prompt remain pinned through tool continuations.

```ts
import { Effect, Schema } from "effect";
import { Harness, Plugin, Tool } from "@codeworksh/harness/effect";

const echo = Plugin.define({
	id: "acme.tool.echo",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "echo",
					description: "Echo a message",
					parameters: Schema.Struct({ text: Schema.String }),
					success: Schema.String,
					handler: ({ text }) => Effect.succeed(text),
				}),
			),
			{
				beforeToolCall(call) {
					// Arguments have already been decoded. Return { block: true, reason: "..." }
					// to skip this handler and its after hook.
				},
				afterToolCall({ terminal }) {
					// Completed/error results can be patched through content, details, isError.
					// Aborted results are observation-only; keep cancellation cleanup short.
				},
			},
		);
	},
});

const runtime = Harness.layer({
	plugins: ["codework.tool.bash", echo, "codework.prompt.default"],
});
```

Hooks belong to the tool registration. Sequential or parallel scheduling, selected with `Session.create({ tools: { execution: "parallel" } })`, covers the entire hook/handler pipeline. After runs for a started, interrupted tool if it has not already started, with a one-second cooperative cleanup grace period. The kernel owns result settlement.

`ctx.plugin.tools.update(name, patch)` rewrites a registration's model-facing prose without replacing the tool or its hooks. A read sees only earlier contributions, so a plugin patching `promptSnippet` or `promptGuidelines` must run _before_ the prompt plugin that indexes them — after it, the patch still reaches the wire description but no longer the system prompt.

Prompt plugins use `ctx.plugin.prompt.get()` and `set(string)`. Each `set` replaces the entire prompt, including with an empty string. Place a prompt plugin after the tools or prompt contributors it needs. Contributions close after setup; plugins receive event publication but no subscription or background lifecycle.

Omitting `plugins` selects Bash then the default prompt. An explicit array replaces that selection. Entries may be plugin objects, IDs, `!vendor.domain.name` to disable an ID, local paths/file URLs, or package specs such as `@acme/codework-plugin@1.2.0`. Source modules must default-export one plugin object. Definitions load before selection; the last occurrence of each ID determines whether it runs and its position.

Package sources install with pnpm, with lifecycle scripts disabled, under the harness home cache. An omitted version means `latest` on the first installation; subsequent constructions reuse that completed installation. Plugin discovery from settings and daemon lifecycles are not implemented.

## Pluggable Sandboxes

Harness uses a driver-based sandbox architecture. Drivers share a common lifecycle and I/O surface, keeping provider details out of session and agent-loop code.

| Backend        | Environment                                 | Good for                                              |
| -------------- | ------------------------------------------- | ----------------------------------------------------- |
| Local host     | Real filesystem and processes               | Working directly in the current machine or repository |
| In-memory VFS  | Ephemeral virtual filesystem                | Fast tests and isolated experiments                   |
| SQLite VFS     | In-memory or file-backed virtual filesystem | Reproducible sandboxes with optional persistence      |
| Vercel Sandbox | Remote sandbox                              | Isolated cloud execution on Vercel                    |
| Daytona        | Remote sandbox                              | Managed development environments on Daytona           |

The SDK exposes sandbox creation, registration, discovery, refresh, wake, stop, and destroy operations. Built-in drivers can be selected when constructing the Harness layer:

```ts
import { Effect } from "effect";
import { Harness, Sandbox, Session } from "@codeworksh/harness/effect";

const program = Effect.gen(function* () {
	const sandbox = yield* Sandbox.create({ driver: "memory", config: { defaultCwd: "/workspace" } });
	const session = yield* Session.create({ sandbox });
	const info = yield* session.info;
	console.log(`${sandbox.driver}:${info.directory}`);
});

await program.pipe(
	Effect.provide(
		Harness.layer({
			database: ":memory:",
			home: ".codework",
		}),
	),
	Effect.scoped,
	Effect.runPromise,
);
```

`local` always exists, while `memory` and `sqldb` are registered automatically. Install third-party drivers with pnpm and load their package specifiers when constructing the layer:

```sh
pnpm install @acme/codework-sandbox-e2b
```

```ts
Harness.layer({
	sandboxes: ["@acme/codework-sandbox-e2b"],
});
```

Vercel and Daytona are the first remote drivers. More providers can be added behind the same lifecycle and I/O contracts without changing session or agent-loop code.

## Requirements

- Node.js 24.14.1 or newer
- An API key for the model provider you select
- A generated Aikit model catalog; run `codework models generate` from the project you want to use

## CLI

Run the current development release without installing it globally:

```sh
export OPENAI_API_KEY="..."

pnpm dlx @codeworksh/harness@dev models generate

pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --cwd "$PWD" --provider openai --model gpt-5.5 --thinking high \
  "Inspect this repository"
```

The streamed response remains clean on stdout for piping. Session context and the per-run model usage summary are written to stderr:

```text
session  ses_...
sandbox  local · /workspace/project

── response ─────────────────────────────────────────────────────────────
The response streams here.
── usage ────────────────────────────────────────────────────────────────
model    openai/gpt-5.5
tokens   12,400 input · 820 output · 13,220 total
cache    9,600 read · 0 write
cost     $0.014200 · 1 turn
```

`codework models generate [path]` uses Aikit's model generator and writes `./models.gen.json` by default. Set `CODEWORK_MODELS_FILE` or pass a path when you keep the catalog elsewhere.

The CLI prints the session ID to stderr. Provider, model, and thinking settings are stored with the session, so use the same home directory and session ID to continue it:

```sh
pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --session <session-id> \
  "Continue with the implementation"
```

Persisted settings are the fallback. A new CLI process can explicitly re-bind or change them while attaching; supplied values are recorded as the session's latest configuration:

```sh
pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --session <session-id> \
  --provider openai --model gpt-5.6-luna --thinking high \
  "Continue with this model"
```

Local execution is the default. To create a session in a new Daytona sandbox, set `DAYTONA_API_KEY` and select the Daytona driver:

```sh
export DAYTONA_API_KEY="..."

pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --sandbox daytona --provider openai --model gpt-5.5 \
  "Inspect this repository"
```

Pass the provider's sandbox ID to connect a new Harness session to an existing Daytona sandbox:

```sh
pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --sandbox daytona --sandbox-provider-id <daytona-sandbox-id> \
  "Continue work in this sandbox"
```

`--cwd` overrides the selected sandbox's default working directory. When continuing with `--session`, omit the sandbox flags: the durable session already references its sandbox.

The same flags work with Vercel Sandbox by using `--sandbox vercel`; `--sandbox-provider-id` then accepts the existing Vercel sandbox name.

Use `codework --help` or `pnpm dlx @codeworksh/harness@dev --help` for all options.

## Effect SDK

```sh
pnpm add @codeworksh/harness@dev effect
```

```ts
import { Effect } from "effect";
import { Harness, Session } from "@codeworksh/harness/effect";

const program = Effect.gen(function* () {
	const session = yield* Session.create({
		title: "Review Harness",
		directory: process.cwd(),
		model: { provider: "openai", id: "gpt-5.5" },
		thinkingLevel: "high",
	});
	const info = yield* session.info;

	console.log(`session ${info.id} in ${info.directory}`);
});

await program.pipe(
	Effect.provide(Harness.layer({ database: ":memory:", home: ".codework-readme" })),
	Effect.scoped,
	Effect.runPromise,
);
```

Creating a session does not contact the provider. Call `session.run(prompt)` to execute a turn, and call `session.events()` directly to obtain its Effect `Stream`.

The Effect SDK currently includes:

- `Harness.layer` for process configuration and service wiring
- `Session` handles for create, attach, prompt, run, resume, interrupt, events, and history
- `Sandbox` drivers and lifecycle operations for in-memory, SQLite, Vercel, and Daytona environments
- Local host execution for sessions without a configured sandbox
- Effect-native errors, layers, streams, and resource scopes

## Status

This release is intended for quick iteration and feedback. It is not yet a stable production API. Please report issues through the [Codework repository](https://github.com/codeworksh/codework/issues).
