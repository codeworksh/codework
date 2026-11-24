# Single-File Example Plugins

Two plugins that are not packages: one file each, loaded by path. This is the shortest way to write a project-local plugin, with no build, no publish and no version.

| File                                 | Kind   | Contributes                                                            |
| ------------------------------------ | ------ | ---------------------------------------------------------------------- |
| [`local.ts`](./local.ts)             | tool   | `project_fact`, which answers from conventions recorded in its options |
| [`house-style.ts`](./house-style.ts) | prompt | Each configured rule, appended to the built-in `<rules>` section       |

Both are inert without configuration. With no `options`, `local.ts` registers no tool and `house-style.ts` appends no rules.

## How It Works

Each file default-exports one `Plugin.define(...)` object from [`@codeworksh/plugin`](../../packages/plugin/src/index.ts). The harness resolves `effect` and `@codeworksh/plugin` to its own copies when it imports a plugin, so a single file needs no `node_modules` of its own.

Plugins run by kind (`mcp`, then `tool`, then `prompt`), then in the order entries were written. So `project_fact` is in the system prompt's tool list, and `house-style.ts` writes into `<rules>` alongside the defaults instead of opening a second block.

## Loading Them

Copy the files into your project's `.codework/plugins/`, then name and configure them:

```jsonc
// <project>/.codework/settings.jsonc
{
	"plugins": [
		"./plugins/local.ts",
		{ "package": "./plugins/local.ts", "options": { "facts": { "deploy": "vercel", "tests": "vp test" } } },
		"./plugins/house-style.ts",
		{ "package": "./plugins/house-style.ts", "options": { "rules": ["No `any` in TypeScript."] } },
	],
}
```

Two entries per plugin. The string loads the module. The object configures it, naming the module by the same path (`package`) or the plugin by its ID (`plugin`, here `local.tool.facts` and `local.prompt.house-style`). An object never loads anything, so a wrong path is ignored rather than failing the boot.

A relative path resolves against the directory of the settings file that declares it, so the same entry in `~/.codework/settings.jsonc` names `~/.codework/plugins/local.ts`. Absolute paths, `file:///` URLs and `~/` paths are taken as written. `codework plugin add <path>` writes the entry for you, rewritten so it still names the same file from the settings file.

A local file has no installed version, so a running server picks up an edit only after `codework plugin reload`.

See [Plugins](../../docs/internals/08_plugins.md) for kinds, entries and the store.
