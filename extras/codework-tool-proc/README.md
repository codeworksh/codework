# @acme/codework-tool-proc

An example third-party **tool plugin**. It registers `list_processes`, which runs `ps` in the session's sandbox and returns the busiest processes. Read it to see a complete tool plugin built only on the public SDK; the `@acme` scope stands in for your own.

## How It Works

The package default-exports one `Plugin.define({ id: "acme.tool.proc", kind: "tool", setup })` object, which is all the loader reads. It imports `Plugin` and `Tool` from [`@codeworksh/plugin`](../../packages/plugin/src/index.ts) and `SandboxIO` from `@codeworksh/plugin/sandbox`, nothing from the harness.

- **It runs in the sandbox.** The handler uses `SandboxIO.Shell`, not `node:child_process`, so it lists processes wherever the session runs: this machine, a container or a remote sandbox.
- **Failures are typed.** A non-zero `ps` becomes a model-visible `ProcFailed` carrying stderr, so the model can try another filter. A shell that cannot run at all becomes a defect, because the model cannot act on it.
- **It shows up in the tool list.** Tool plugins run before prompt plugins, so `list_processes` and its `promptSnippet` reach the system prompt's `<tools>` section.
- **It checks its own options.** The harness hands the `options` block over untouched. A bad `limit` falls back to `20` instead of failing the boot.

| Option  | Default | Meaning                                                   |
| ------- | ------- | --------------------------------------------------------- |
| `limit` | `20`    | How many rows to return, busiest first (positive integer) |

## Loading It

A string entry loads the module, and an object entry configures a module already loaded. An object never installs anything, so a name that matches nothing is ignored. In this repository, add it from the repo root:

```sh
codework plugin add ./extras/codework-tool-proc
```

That writes the path into `.codework/settings.jsonc`, anchored to the settings file. Then configure it:

```jsonc
// .codework/settings.jsonc
{
	"plugins": ["../extras/codework-tool-proc", { "package": "@acme/codework-tool-proc", "options": { "limit": 40 } }],
}
```

The object can name the package (a local package is also known by its `package.json` name) or the plugin, as `{ "plugin": "acme.tool.proc" }`. A real published plugin would be added by spec instead, for example `codework plugin add @acme/codework-tool-proc@1.2.0`.

> [!NOTE]
> This example is not installable from a registry as written. It exports TypeScript from `src/`, and Node refuses to strip types under `node_modules`. A published plugin ships built JavaScript and points `exports` at it.

## Code Map

- [`src/index.ts`](./src/index.ts): the whole plugin: options, schemas, the `ps` parser and the tool.

See [Plugins](../../docs/internals/08_plugins.md) for kinds, entries and the store.
