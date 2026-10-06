# @codeworksh/plugin

The SDK for building [CodeWork](https://www.codework.sh) plugins.

A plugin is a module that default-exports one plugin object. It registers tools, composes the
system prompt, and reads the session's sandbox, location, model and settings off a context the
harness hands it. This package is exactly that contract — and `@codeworksh/harness` depends on it
too, so a plugin compiled against these types is the same plugin the harness loads, not a
structurally similar copy.

```bash
pnpm add @codeworksh/plugin effect
```

`effect` is a peer dependency: the harness and every plugin share one copy of it.

## A tool plugin

```ts
import { Plugin, Tool } from "@codeworksh/plugin";
import { SandboxIO } from "@codeworksh/plugin/sandbox";
import { Effect, Schema } from "effect";

export default Plugin.define({
	id: "acme.tool.wc",
	kind: "tool",
	setup: Effect.fn("WcPlugin.setup")(function* (ctx, options) {
		// The session's shell, wherever it runs — this machine, a container, a remote sandbox.
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

`setup` may be synchronous, return a promise, or be an `Effect` — only the `Effect` form can ask
for a capability such as `SandboxIO.Shell`.

## A prompt plugin

```ts
import { Plugin, Section } from "@codeworksh/plugin";

const GithubPrRules = Section.define("github_pr_rules", { format: "list" });

export default Plugin.define({
	id: "acme.prompt.house-style",
	kind: "prompt",
	setup(ctx) {
		// Merges into the one <rules> every plugin writes to.
		ctx.plugin.prompt.sections.append(Section.Rules, "No `any`.");
		// Opens <github_pr_rules> on first use; later appends, from any plugin, land in it.
		ctx.plugin.prompt.sections.append(GithubPrRules, "Link the issue in every PR description.");
	},
});
```

The harness renders the system prompt from what plugins wrote: the foundation first and untagged
(`ctx.plugin.prompt.foundation.set`), then `<tools>`, `<rules>`, `<addendum>`, `<project_context>`,
`<skills>`, `<cwd>`, and custom sections in the order they were first written. `tools` and `cwd`
belong to the harness. A `list` section renders its entries as deduplicated `- ` bullets; a `text`
section (the default) keeps them verbatim, separated by a blank line.

## `kind` decides when a plugin runs

Every `tool` plugin runs before any `prompt` plugin, whichever settings layer each came from, so a
prompt plugin always sees the complete tool set. Plugins within one domain keep the order their
entries were written in — which is where composition actually happens, a plugin patching another's
tool or appending to the prompt it rendered.

## Being installed

A user selects a plugin from a settings file. A string entry loads a module; an object entry
configures one something else already selected:

```jsonc
{
	"plugins": ["@acme/codework-plugin-wc", { "package": "@acme/codework-plugin-wc", "options": { "limit": 40 } }],
}
```

The `options` block is handed to `setup` untouched — the harness never looks inside it, so a
plugin validates its own shape and falls back rather than failing the boot.

Publish built JavaScript. Node will not strip types under `node_modules`, so a package that ships
TypeScript can only be loaded by path.

## What is in here

| Import                       | What it gives you                                     |
| ---------------------------- | ----------------------------------------------------- |
| `@codeworksh/plugin`         | `Plugin` and `Tool` — defining a plugin and its tools |
| `@codeworksh/plugin/sandbox` | the mount (`SandboxIO`) and the sandbox driver SDK    |

That is the whole authoring surface. The package publishes further subpaths — `./event`,
`./ids`, `./location`, `./settings` and others — because `@codeworksh/harness` imports them across
the package boundary; they are reachable if you genuinely need one, but they are not re-exported
from the root entry and are not covered by the stability that `Plugin` and `Tool` carry.

Sandbox driver packages use `@codeworksh/plugin/sandbox` the same way: `SandboxDriver.module`
defines the default export the harness loads.

## Versioning

`0.x` — the contract still moves. Pin the version you build against, and keep it in step with the
`@codeworksh/harness` you target.
