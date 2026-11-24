# @codeworksh/harness

The CodeWork agent harness: durable sessions and threads, the agent loop, tools, plugins, MCP and sandboxes, built on [Effect](https://effect.website). The `codework` CLI and RPC server boot it to run agents, and you can embed it to run them in your own Node process.

> [!NOTE]
> This is an early release. Expect breaking changes between minor versions.

## Install

```sh
pnpm add @codeworksh/harness effect@4.0.5
```

`effect` is a peer dependency pinned to an exact version. Node 24.14.1 or newer is required.

## Usage

The public surface is the Effect SDK at `@codeworksh/harness/effect`. The root export is empty for now.

```ts
import { Effect } from "effect";
import { Harness, Session } from "@codeworksh/harness/effect";

const program = Effect.gen(function* () {
	const session = yield* Session.create({
		directory: process.cwd(),
		model: { provider: "openai", id: "gpt-5.5" },
		thinkingLevel: "high",
	});
	// Stores the prompt, runs the main thread and waits until it is idle.
	yield* session.main.run("Summarize this repository in one paragraph.");
	const { usage } = yield* session.main.info;
	console.log(`${session.id}: ${usage.input} in, ${usage.output} out, $${usage.cost}`);
});

await program.pipe(
	// `home` holds settings, the model catalog and the database. It defaults to ~/.codework.
	Effect.provide(Harness.layer({ home: ".codework" })),
	Effect.scoped,
	Effect.runPromise,
);
```

API keys come from the process environment (here `OPENAI_API_KEY`), and the model catalog is kept in `<home>/models.gen.json`. See [models](https://github.com/codeworksh/codework/blob/main/docs/internals/03_models.md).

A session is one durable event log, and its threads live inside it. `session.main` is the main thread. A thread handle can `prompt` (store and return), `run` (store and wait), `interrupt`, `resume`, `fork` and `configure`, and exposes `events()` and `history()`. Every run, prompt and durable event is stored, so `Session.attach({ sessionId })` reaches a thread again after a restart, and `Control.Service`'s `resumeUnfinished` picks up runs a crash cut off, as the RPC server does at start.

## What It Owns

The harness is the agent itself. It owns the loop, prompt assembly, tool execution, the plugin catalog and installer, MCP clients, sandbox drivers and mounts, settings, and the SQLite store every run and durable event lands in.

It depends on [`@codeworksh/aikit`](https://github.com/codeworksh/codework/tree/main/packages/aikit) for every model call and on [`@codeworksh/plugin`](https://github.com/codeworksh/codework/tree/main/packages/plugin) for the plugin, tool and sandbox contracts. It never imports the CLI, the RPC server, `packages/schema` or anything under `apps/`. That keeps it a library that never knows how it is reached, so the RPC server, in-process `codework run` and ACP all boot the same harness.

Third parties extend it with plugins built against `@codeworksh/plugin`, not against this package. Pass them to `Harness.layer({ plugins })`, or list them in a settings file's `plugins` block. Remote sandboxes load from the `@codeworksh/harness/sandboxes/vercel` and `@codeworksh/harness/sandboxes/daytona` subpaths through `Harness.layer({ sandboxes })`, with their provider SDK installed beside it.

## Code Map

- [`src/effect.ts`](https://github.com/codeworksh/codework/blob/main/packages/harness/src/effect.ts) is the public SDK barrel.
- [`src/effect/harness.ts`](https://github.com/codeworksh/codework/blob/main/packages/harness/src/effect/harness.ts) builds `Harness.layer`: its options and the service wiring.
- [`src/effect/session.ts`](https://github.com/codeworksh/codework/blob/main/packages/harness/src/effect/session.ts) creates, attaches and relinks sessions and returns session and thread handles.
- [`src/control.ts`](https://github.com/codeworksh/codework/blob/main/packages/harness/src/control.ts) starts, joins and stops work: prompt, run, interrupt and resume.
- [`src/runner`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/runner) holds execution, the per-thread coordinator, the loop, retries and the one boundary to aikit.
- [`src/event`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/event) is the durable event log and its projectors.
- [`src/plugin`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/plugin) loads, installs and runs plugins, including the built-in tools and prompt.
- [`src/sandbox`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/sandbox) and [`src/sandboxes`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/sandboxes) hold the driver registry, mounts and the bundled drivers.
- [`src/mcp`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/mcp) runs MCP servers and exposes their tools.
- [`src/settings`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/settings) reads and merges settings files.
- [`src/db`](https://github.com/codeworksh/codework/tree/main/packages/harness/src/db) is the SQLite store and its migrations.

## Working Locally

```sh
pnpm check   # vp check
pnpm test    # vp test
pnpm build   # vp pack
```

`pnpm test:sandbox:e2e` runs the remote sandbox suites and needs provider credentials. See [testing](https://github.com/codeworksh/codework/blob/main/docs/internals/13_testing.md).

## Learn More

- [Runtime](https://github.com/codeworksh/codework/blob/main/docs/internals/04_runtime.md): sessions, threads, runs and durability.
- [Services](https://github.com/codeworksh/codework/blob/main/docs/internals/02_services.md): Effect services, layers and errors.
- [Sandboxes](https://github.com/codeworksh/codework/blob/main/docs/internals/06_sandboxes.md), [settings](https://github.com/codeworksh/codework/blob/main/docs/internals/07_settings.md) and [plugins](https://github.com/codeworksh/codework/blob/main/docs/internals/08_plugins.md).

Report issues in the [CodeWork repository](https://github.com/codeworksh/codework/issues).
