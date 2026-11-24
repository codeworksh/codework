# Settings

Settings are read from host files in two layers, user and project. Which project a session reads depends on one rule: configuration is discovered from a directory the caller declared on the host, never from where the process started and never from where the work runs. The header of [settings.ts](../../packages/harness/src/settings/settings.ts) is the authoritative statement of these rules.

## Three Directories

| Name    | What it is                     | What resolves from it                                           |
| ------- | ------------------------------ | --------------------------------------------------------------- |
| hostCwd | The app process's directory    | Relative `--home` and `--user-config-dir`, driver packages      |
| hostDir | A session's declared host path | The project layer, its `mcp.json` and the session's plugin view |
| cwd     | The sandbox working directory  | Nothing; tools run here                                         |

`hostCwd` is read from `process.cwd()` exactly once, as a default in [harness.ts](../../packages/harness/src/effect/harness.ts). Everything downstream takes it as a parameter, so no module can fall back to the process's directory when it meant a session's.

`hostDir` is per session and optional, with no fallback. A session without one reads the user layer only. Falling back to `hostCwd` would answer with the wrong project, silently. No project is a visible gap that a person can diagnose. A declared `hostDir` must be absolute, because the settings file it selects names plugins the server imports into its own process. The CLI declares the shell's directory when it creates a session; `session link` sets or clears it later.

`cwd` names a place inside a mount that may not exist on this machine. A path that happens to exist here too would select a stranger's project, so settings never come from it.

## Two Layers

- **User**: `<home>/settings.jsonc`, or the one in `--user-config-dir`. That flag moves only the user settings file and the `mcp.json` beside it. Credentials, the plugin cache and data stay in the home.
- **Project**: the nearest ancestor of `hostDir` that holds a `.codework` directory. The nearest root wins outright and is never merged with an outer one.

The marker is the directory, not a file in it. An empty `.codework/` is a project root, and it shadows any outer project from then on. `<home>` is skipped during the walk. Without that, running anywhere under `$HOME` would read the user layer twice, and every user plugin would load twice.

In each directory `settings.jsonc` is tried before `settings.json`. A layer contributes at most one file.

Layers merge onto the built-in defaults: objects merge, arrays replace, and `null` means absent. Three keys break that rule on purpose:

- **`plugins` accumulate across layers.** A user's plugins are the base a project builds on. A project removes one with `{ "plugin": "<id>", "enabled": false }`, the same entry that turns off a built-in. The array is also decoded exactly as written, because `null` inside a plugin's `options` may be a value it needs.
- **`models` entries accumulate**, and for one model the highest layer's entry wins.
- **`server` is read from the user layer only.** A project must not decide which proxies the machine trusts.

A relative plugin path is anchored to the file that declared it, not to `hostCwd`.

A missing file is ordinary. A file that exists and cannot be read, parsed or decoded fails the load with its path and key. Skipping it would drop everything else it configured, and a single typo could move a session onto another model with only a log line to show for it. Decode errors never quote the rejected value, which may be a secret.

Settings have no cache and no reload API of their own. Every turn reads the files again, so an edit lands at the next turn.

## Boot View and Project Views

At boot the harness reads the user layer and the override only, with no `hostDir`. A server can start anywhere, and walking up from its launch directory would hand it a stranger's project settings.

Plugins load into pools ([state.ts](../../packages/harness/src/state/state.ts)). The process view is what boot loaded. A project view is copied from the process view the first time a session's `hostDir` leads to that project root, and only that project's sessions move it afterwards. Sessions without a `hostDir` run from the process view. Views are separate because the same plugin spec can be owned by different files, and so resolve through different registries, in two projects. One shared pool would keep evicting the other project's build.

Loading (a store lookup and an import) happens at boot and on reload. Configuring (`enabled`, `options`, order) is pure data and runs every turn, so an `options` edit applies at the next turn without re-importing anything. The turn boundary loads an entry whose bytes are already in the store and never fetches. Only the `codework plugin` commands that install (`add`, `install`, `update`) download.

Settings entries extend the built-ins. An embedder that passes `plugins` to the harness replaces the whole selection, built-ins included.

## MCP Configuration

`mcp.json` sits beside each settings file: in the user directory (the home, or `--user-config-dir`) and in the project's `.codework/`. See [config.ts](../../packages/harness/src/mcp/config.ts).

A project entry replaces the user entry with the same name. A project entry with no `command`, `url` or `type` overrides only `enabled`, `exposure` and `toolExposure`, and keeps the rest of the user entry, including credentials the project could not set itself. Only the `.json` spelling is read. Unlike settings, a broken file or entry is reported and skipped, so one bad server never stops the others.

## Writing Settings

All writers share [file.ts](../../packages/harness/src/settings/file.ts):

- Edits go through `jsonc-parser`, so comments, key order and formatting survive.
- A write is a temp file renamed over the original, under a cross-process lock on `<path>.lock`. The CLI and the RPC server take the same lock.
- The file's mode is kept, and a new file is private to its owner.
- `set` and `replace` decode the result before writing, because an invalid file fails every turn in its project. `replace` also refuses when the file changed since the caller read it.

`Settings.locate` picks the file an edit lands in: the one a session at `hostDir` would read, or the user file without one. A directory in no project becomes a project root when the file is written there. An existing `settings.json` is kept rather than creating a `.jsonc` beside it. The RPC server's `settings.read`, `settings.write` and `settings.set` reach a project's file through its main checkout on the host, so a project checked out only in sandboxes has none.

The CLI's [jsonc.ts](../../packages/codework/src/cli/jsonc.ts) reuses the edit, the save and the lock but not the decode check, so each CLI command validates what it writes. `plugin add` writes to the project file by default and creates `.codework/` in the current directory when no project is found, saying so. `--global` writes the user file. A local plugin path is written relative to the settings file when both are inside the project, and absolute otherwise.
