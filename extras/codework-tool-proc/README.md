# @acme/codework-tool-proc

An example third-party **tool plugin**: it registers `list_processes`, which runs `ps` in the
session's sandbox and returns the busiest processes.

It exists to be read. It uses only the public surfaces — `@codeworksh/plugin` for
`Plugin`/`Tool` and `@codeworksh/plugin/sandbox` for the shell — and default-exports one plugin
object, which is what the loader imports.

## Using it

```jsonc
// <project>/.codework/settings.json, ~/.codework/settings.json, or a --user-config-dir
{
	"plugins": ["@acme/codework-tool-proc@1.2.0", { "package": "@acme/codework-tool-proc", "options": { "limit": 40 } }],
}
```

Two entries, and they do different jobs. The **string** is the module: it installs the package
and puts the plugin in the selection. The **object** configures it — `package` names the module
it came from, and `{ "plugin": "acme.tool.proc" }` names the same plugin by its ID if you happen
to know it. An object never installs anything, so a name that matches nothing is ignored rather
than fetched.

> **This example is not installable as written.** It exports TypeScript from `src/`, and Node
> refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). It
> lives in this repository as a dev-only workspace example, loaded by path:
> `"plugins": ["../extras/codework-tool-proc", { "package": "@acme/codework-tool-proc", … }]` —
> the `package` entry still works, because a local package is aliased by the name its manifest
> declares. A plugin package published for real ships built JavaScript and points `exports` at it.

| option  | type             | default | meaning                                |
| ------- | ---------------- | ------- | -------------------------------------- |
| `limit` | positive integer | `20`    | how many rows to return, busiest first |

The block is opaque to the harness: it arrives as the second argument to `setup`, and this
plugin checks it and falls back rather than failing the boot on a bad value.

## Worth noting

- **It runs in the sandbox.** The tool executes through `SandboxIO.Shell`, not
  `node:child_process`, so it lists processes wherever the session actually runs — this machine,
  a container, or a remote sandbox.
- **Failures are typed.** A non-zero `ps` becomes a model-visible `ProcFailed` carrying stderr; a
  shell that cannot run at all is a defect, because the model cannot act on it.
- **Order matters.** A tool plugin must run before the prompt plugin that indexes tools, or its
  tool reaches the provider but is missing from the system prompt's list.
