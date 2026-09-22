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

Third-party plugins build against [`@codeworksh/plugin`](../plugin/README.md), the published SDK
that owns the plugin, tool and sandbox contract this package consumes — a plugin package depends
on it rather than on the whole harness. The same types are re-exported here as `Plugin` and `Tool`
for embedders who already hold the harness.

Pass a plugin list when constructing the harness. Each plugin declares an ID and the domain it extends — `tool` or `prompt` — and contributes during setup. Setup runs once per exchange, after model resolution; its tools, hooks, and prompt remain pinned through tool continuations.

```ts
import { Effect, Schema } from "effect";
import { Harness, Plugin, Tool } from "@codeworksh/harness/effect";

const echo = Plugin.define({
	id: "acme.tool.echo",
	kind: "tool",
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

// A prompt plugin renders the system prompt, and indexes every tool registered before it.
const prompt = Plugin.define({
	id: "acme.prompt.main",
	kind: "prompt",
	setup(ctx) {
		ctx.plugin.prompt.set(
			`You have: ${ctx.plugin.tools
				.list()
				.map((tool) => tool.name)
				.join(", ")}`,
		);
	},
});

// Omit `plugins` for the built-ins plus whatever settings add; passing it owns the whole
// selection, which is why this one supplies its own prompt plugin.
const runtime = Harness.layer({ plugins: [echo, prompt] });
```

Hooks belong to the tool registration. Sequential or parallel scheduling, selected with `Session.create({ tools: { execution: "parallel" } })`, covers the entire hook/handler pipeline. After runs for a started, interrupted tool if it has not already started, with a one-second cooperative cleanup grace period. The kernel owns result settlement.

`ctx.plugin.tools.update(name, patch)` rewrites a registration's model-facing prose without replacing the tool or its hooks. A read sees only earlier contributions, so a plugin patching `promptSnippet` or `promptGuidelines` must run _before_ the tool it patches is indexed. Declaring `kind: "tool"` puts it ahead of every prompt plugin already; what it still has to get right is its position among the other tool plugins, which is the order their entries are written in.

Prompt plugins use `ctx.plugin.prompt.get()` and `set(string)`. Each `set` replaces the entire prompt, including with an empty string. Place a prompt plugin after the tools or prompt contributors it needs. Contributions close after setup; plugins receive event publication but no subscription or background lifecycle.

Omitting `plugins` selects Bash then the default prompt, followed by the host settings' `plugins` block. An explicit array replaces all of that, and an empty one runs nothing — which is not a usable harness: `freeze` requires a system prompt, so a selection without a prompt plugin fails every exchange with `SnapshotError("no prompt plugin set a system prompt")`. Every working selection ends with a prompt plugin, whether `codework.prompt.default` or your own.

An entry is a **module** or a **configuration object**.

A module is a definition object, a local path, a `file:` URL, or a package spec. It is loaded if it is not already, and it takes the position it is written at — naming a module again moves it:

```ts
plugins: [echo, "./plugins/local.ts", "file:///opt/plugin.mjs", "@acme/codework-tool-proc@1.2.0"];
```

A configuration object addresses a plugin **something else already selected**, and names it one of two ways:

```jsonc
{ "plugin": "acme.tool.proc", "options": { "limit": 40 } }             // by ID, when you know it
{ "package": "@acme/codework-tool-proc", "options": { "limit": 40 } }  // by the package it came from
{ "plugin": "codework.tool.bash", "enabled": false }                   // drop a built-in
```

Exactly one of `plugin` and `package` per entry. `plugin` is a plugin's ID; `package` is any name the module answers to — the package name, the exact spec, the path it was loaded from, or the name a local package's own manifest declares.

An **ID is a key**. The last module to claim one owns it, and the configuration written against it stays with the key rather than with whichever module is currently behind it. Two modules exporting one ID is the author's conflict to resolve — the replacement is logged at debug, not arbitrated here.

A configuration object **never loads, installs or reorders anything**. If its name matches nothing in the selection — a typo, a package you have not added, a plugin this build does not ship — the entry is **ignored**: one debug line, no failure, and nothing fetched. So adding a package and configuring it is two entries, in that order:

```jsonc
{ "plugins": ["@acme/codework-tool-proc@1.2.0", { "package": "@acme/codework-tool-proc", "options": { "limit": 40 } }] }
```

Repeated configuration replaces rather than merges — the block is opaque, so the last entry owns it whole. `options` reaches that plugin as the second argument to `setup`, `{}` when nothing configured it. The harness never looks inside it, including the `null`s it strips everywhere else in a settings file, since inside an opaque block a `null` is a value its plugin may need:

```ts
Plugin.define({
	id: "acme.tool.proc",
	setup(ctx, options) {
		const limit = typeof options.limit === "number" ? options.limit : 10;
	},
});
```

Source modules must default-export one plugin object.

Settings entries take the same two forms, and they extend the built-in selection instead of standing in for it, so naming one plugin cannot silently drop Bash or the prompt:

```jsonc
// <project>/.codework/settings.jsonc, ~/.codework/settings.jsonc, or a --user-config-dir
{
	"plugins": [
		"@acme/codework-prompt-life",
		"@acme/codework-tool-proc@1.2.0",
		"./plugins/local.ts",
		{ "package": "@acme/codework-tool-proc", "options": { "limit": 20 } },
		{ "plugin": "codework.tool.bash", "enabled": false },
	],
}
```

Settings files are JSONC: comments and a trailing comma are part of the format, and a syntax error names what the parser expected and where (`PropertyNameExpected at 2:38`). Entries accumulate across settings layers, lowest priority first: a project's list extends the user's rather than standing in for it, the way every other key in the document merges. A project drops an inherited plugin the same way it drops a built-in, with `{ "plugin": "<id>", "enabled": false }`. A leading `~` expands to the home directory. A `./` or `../` path resolves against the directory of the file that declared it — inside `<project>/.codework/`, or beside `~/.codework/settings.jsonc` — so one entry means one file in every project; a `package` naming a relative path is anchored the same way. `file:` URLs, absolute paths and package specs are taken as written.

Setup order comes from the **domain a plugin declares**, not from where its entry sits. Every `kind: "tool"` plugin is set up before any `kind: "prompt"` plugin, so a prompt plugin always sees the complete tool set — including tools added from a settings file, which land after the built-ins in the array. Within one domain, entries keep the order they were written in, which is where composition actually happens: a plugin patching another's tool, or appending to the prompt a previous one rendered, is written after it on purpose.

That is the reason `kind` is part of the definition rather than something the harness guesses. A user's settings file and a project's are edited by different people at different times, and neither can see the other's ordering; what each plugin _is_ remains knowable in both.

A plugin package declares `@codeworksh/harness` and `effect` as **exact peer dependencies**, never as dependencies:

```jsonc
"peerDependencies": { "@codeworksh/harness": "0.0.1", "effect": "4.0.0-rc.115" },
"devDependencies":  { "effect": "4.0.0-rc.115" }
```

A plugin is installed into its own directory, so its Effect is a separate module instance from the harness's. Two instances of the _same_ version interoperate completely — service tags resolve by their string id, and schemas, generators and handlers all cross the boundary. Two different _versions_ do not: a tool's schema then encodes a result the harness cannot commit. Declaring the peer moves that from a runtime failure to a line during `npm install`, and `test/plugin.foreign.test.ts` holds the interop itself in place.

Package sources install with pnpm, with lifecycle scripts disabled, under the harness home cache. The installer inherits stderr, so a first install prints pnpm's own progress and errors to the terminal — and a `plugins` entry in a settings file means that can happen during `Harness.layer` construction, before any session exists. An omitted version means `latest` on the first installation; subsequent constructions reuse that completed installation. The selection is read once per `Harness.layer`, so an edited `plugins` block applies at the next construction; hot reload and daemon lifecycles are not implemented.

Failures are attributed: a bad reference, unreadable module, or malformed plugin fails `Harness.layer` construction with `PluginPreparationError`, which carries the failing phase (`source`, `install`, `import`, or `definition`) and the index of the offending reference. A failing package install reports `PluginInstallError`; a plugin's `setup` failure becomes `Plugin.SetupError` with the plugin id, surfacing as a `SnapshotError` for that exchange. Plugins are trusted in-process code — local paths and `file:` references import whatever they point at, so only load sources you trust.

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
- An API key for the model provider you select, or OAuth credentials created with
  `codework auth login --openai-codex` / `codework auth login --github-copilot`
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
  run --sandbox-driver daytona --provider openai --model gpt-5.5 \
  "Inspect this repository"
```

Pass the provider's sandbox ID to connect a new Harness session to an existing Daytona sandbox:

```sh
pnpm dlx @codeworksh/harness@dev \
  --home .codework-beta \
  run --sandbox-driver daytona --sandbox-provider-id <daytona-sandbox-id> \
  "Continue work in this sandbox"
```

`--cwd` overrides the selected sandbox's default working directory. When continuing with `--session`, omit the sandbox flags: the durable session already references its sandbox.

The same flags work with Vercel Sandbox by using `--sandbox-driver vercel`; `--sandbox-provider-id` then accepts the existing Vercel sandbox name.

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
