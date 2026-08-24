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
	const sandbox = yield* Sandbox.create({ driver: "memory", cwd: "/workspace" });
	const session = yield* Session.create({ sandbox });
	const info = yield* session.info;
	console.log(`${sandbox.driver}:${info.directory}`);
});

await program.pipe(
	Effect.provide(
		Harness.layer({
			database: ":memory:",
			home: ".codework-readme",
			sandboxes: [Sandbox.Drivers.memory],
		}),
	),
	Effect.scoped,
	Effect.runPromise,
);
```

Vercel and Daytona are the first remote drivers. More providers can be added behind the same lifecycle and I/O contracts without changing session or agent-loop code.

## Requirements

- Node.js 24.14.1 or newer
- An API key for the model provider you select
- A generated Aikit model catalog; run `codework modelgen` from the project you want to use

## CLI

Run the current development release without installing it globally:

```sh
export OPENAI_API_KEY="..."

pnpm dlx @codeworksh/harness@dev modelgen

pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --cwd "$PWD" --provider openai --model gpt-5.5 --thinking high \
  "Inspect this repository"
```

`modelgen [path]` uses Aikit's model generator and writes `./models.gen.json` by default. Set `CODEWORK_MODELS_FILE` or pass a path when you keep the catalog elsewhere.

The CLI prints the session ID to stderr. Provider, model, and thinking settings are stored with a new session, so use the same home directory and session ID to continue it:

```sh
pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --session <session-id> \
  "Continue with the implementation"
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
