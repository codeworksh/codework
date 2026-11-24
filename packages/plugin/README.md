# @codeworksh/plugin

The SDK for building [CodeWork](https://www.codework.sh) plugins. A plugin is a module that default-exports one `Plugin.define(...)` object. During `setup` it adds MCP servers, registers tools or writes into the system prompt. `@codeworksh/harness` imports these same types, so a plugin compiled against them is exactly the plugin the harness loads.

```bash
pnpm add @codeworksh/plugin @codeworksh/aikit effect@4.0.5
```

`@codeworksh/aikit` and `effect` are peer dependencies, so the harness and every plugin share one copy of each.

## A Tool Plugin

```ts
import { Plugin, Tool } from "@codeworksh/plugin";
import { SandboxIO } from "@codeworksh/plugin/sandbox";
import { Effect, Schema } from "effect";

export default Plugin.define({
	id: "acme.tool.wc",
	kind: "tool",
	setup: Effect.fn("WcPlugin.setup")(function* (ctx) {
		// The session's shell, wherever the sandbox runs.
		const shell = yield* SandboxIO.Shell;
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "count_lines",
					description: "Count the lines in a file.",
					parameters: Schema.Struct({ path: Schema.String }),
					success: Schema.Struct({ lines: Schema.Finite }),
					encodeContent: (success) => [{ type: "text", text: String(success.lines) }],
					handler: ({ path }) =>
						shell
							.exec(`wc -l < ${JSON.stringify(path)}`)
							.pipe(Effect.map((result) => ({ lines: Number(result.stdout.trim()) }))),
				}),
			),
		);
	}),
});
```

`setup` may be synchronous, return a promise, or be an `Effect`. Only the `Effect` form can ask for a capability such as `SandboxIO.Shell`. Its second argument is the plugin's `options` block from settings, passed through unvalidated, so check its shape yourself and fall back rather than fail.

## Kinds

`kind` decides what a plugin writes into and when it runs. Within one kind, plugins run in the order their settings entries were written.

| Kind     | Writes into                                      | Runs   |
| -------- | ------------------------------------------------ | ------ |
| `mcp`    | `ctx.plugin.mcp`, the session's MCP servers      | first  |
| `tool`   | `ctx.plugin.tools`                               | second |
| `prompt` | `ctx.plugin.prompt`, the foundation and sections | third  |

So MCP tools exist before any tool plugin runs, and a prompt plugin always sees the full tool set. A prompt plugin appends to a shared section such as `Section.Rules`, or opens its own with `Section.define("name")`.

## Being Installed

`codework plugin add <spec>` installs a plugin and adds it to a settings file. A string entry loads a module; an object entry configures one that is already selected:

```jsonc
{
	"plugins": ["@acme/codework-tool-wc", { "package": "@acme/codework-tool-wc", "options": { "limit": 40 } }],
}
```

Publish built JavaScript. Node will not strip types under `node_modules`, so a package that ships TypeScript can only be loaded by path.

## What It Owns

This package is the contract: what a plugin is and what it may write. It knows nothing about how the harness finds, installs or runs a plugin; that lives in `@codeworksh/harness`. The dependency points one way: the harness depends on this package, never the reverse, and a new extension point gets its contract here first.

Sandbox driver contracts live here too (`@codeworksh/plugin/sandbox`), but drivers are not plugins. The embedder hands them to the harness in code, and settings never select one.

The authoring surface is the root entry (`Plugin`, `Section`, `Tool`) and `@codeworksh/plugin/sandbox`. Other subpaths such as `./event` or `./settings` exist because the harness imports them across the package boundary. They are not re-exported from the root and carry no stability promise.

## Code Map

- [`src/index.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/index.ts): the root entry.
- [`src/plugin/plugin.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/plugin.ts): `Plugin.define`, the kinds and their run order.
- [`src/plugin/context.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/context.ts): the context `setup` receives.
- [`src/plugin/mcp.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/mcp.ts), [`tool.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/tool.ts), [`prompt.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/prompt.ts): the registry each kind writes into.
- [`src/plugin/section.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/section.ts): built-in and custom prompt sections.
- [`src/plugin/ref.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/plugin/ref.ts): the shapes of a `plugins` entry.
- [`src/tool.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/tool.ts): `Tool.make`, `Tool.register` and exposure.
- [`src/sandbox.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/sandbox.ts): `SandboxIO` and the driver contract ([`src/sandbox/driver.ts`](https://github.com/codeworksh/codework/blob/main/packages/plugin/src/sandbox/driver.ts)).

## Working Locally

From `packages/plugin`:

```bash
pnpm check   # vp check
pnpm build   # vp pack
```

The package is `0.x` and the contract still moves: pin the version you build against and keep it in step with the `@codeworksh/harness` you target. For ids, the store, `.npmrc` handling and MCP, see [docs/internals/08_plugins.md](https://github.com/codeworksh/codework/blob/main/docs/internals/08_plugins.md).
