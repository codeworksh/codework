# Plugins

Plugins extend the harness with tools, prompt sections and MCP servers. Sandbox drivers and space daemons share the same contract package but load another way. This page holds the rules that span the contract, the loader, the store and MCP.

## The Contract Lives in `packages/plugin`

[`@codeworksh/plugin`](../../packages/plugin/src/index.ts) is the published SDK. The harness imports the same types, so a plugin compiled against them is exactly what the harness loads. The dependency points one way: `packages/harness` depends on `packages/plugin`, never the reverse. A new extension point gets its contract in `packages/plugin` first.

The contract describes what a plugin writes and nothing about how the harness finds, installs or runs it. Loading, the store and `.npmrc` handling stay in [`packages/harness/src/plugin`](../../packages/harness/src/plugin). Subpaths such as `./event` or `./settings` exist because the harness imports them across the package boundary. They are not an authoring surface, and the root entry deliberately does not re-export them.

## Kinds

A settings-loaded plugin declares one `kind`, and the kind decides when it runs ([plugin.ts](../../packages/plugin/src/plugin/plugin.ts)):

| Kind     | Writes into                       | Runs   |
| -------- | --------------------------------- | ------ |
| `mcp`    | the session's MCP servers         | first  |
| `tool`   | the tool registry                 | second |
| `prompt` | the foundation and named sections | third  |

Order is by domain, then by the order entries were written. Position in the `plugins` array used to decide everything, but a user file and a project file are edited by different people who cannot see each other's order. A prompt plugin indexes the tools registered before it, so a tool added from settings went missing from the system prompt. Running domains in a fixed order means a prompt plugin always sees the full tool set. Inside one domain, written order still matters, because that is where one plugin patches another's tool or appends to a section another rendered.

`mcp` runs first so MCP tools join the registry before any `tool` plugin starts. A tool plugin can therefore patch or hook an MCP tool like any other.

Two other contracts ship in the same package but are not `plugins` entries:

- **Sandbox drivers** ([driver.ts](../../packages/plugin/src/sandbox/driver.ts)) are handed to `Harness.layer({ sandboxes })` by the embedder and resolved with Node module resolution from `hostCwd` ([loader.ts](../../packages/harness/src/sandbox/loader.ts)). The CLI passes its drivers in code. They never go through the plugin store. See [sandboxes](./06_sandboxes.md).
- **Daemon plugins** ([daemon.ts](../../packages/plugin/src/plugin/daemon.ts)) are long-lived workers per space. Only the built-in ones run today, and no setting selects them ([builtin.ts](../../packages/harness/src/daemon/builtin.ts)).

"Settings" in the contract means the typed settings a plugin reads off its context, plus its own `options` block. The harness never looks inside `options`. A plugin validates whatever shape it documents and should fall back rather than fail the boot.

## One Package Is One Plugin

A module default-exports exactly one `Plugin.define(...)` object, and the loader reads only `default` ([loader.ts](../../packages/harness/src/plugin/loader.ts)). There is no multi-plugin manifest. A package that wants a tool and a prompt section ships two packages, or one tool plugin that also writes guidelines through its tools' `promptGuidelines`.

Plugin ids are `vendor.domain.context`, exactly three segments. The `codework.` namespace is reserved for built-ins and a third-party plugin using it fails to load. Events a plugin declares must be namespaced `plugin.<id>.*`. They are checked at boot, so a collision fails the start instead of the first publish.

Plugins run `setup` every turn against one context shared by all of them. The registries are open during that pass and closed after it, so a plugin that keeps `ctx.plugin` and writes to it later gets a "registry is closed" error. The MCP registry closes earlier, when the `mcp` domain ends, because its servers' tools must exist before the `tool` domain starts.

## Specs, Selection and Configuration

A `plugins` entry is either a module or a patch ([ref.ts](../../packages/plugin/src/plugin/ref.ts), [catalog.ts](../../packages/harness/src/plugin/catalog.ts)):

- A **string** selects a module: a path, an absolute `file:` URL, an npm spec or a git spec. It takes the position it is written at.
- An **object** with `plugin` (id) or `package` (the module string) configures something already selected. It never loads, installs or reorders. A name that matches nothing is ignored, so a typo costs a debug line and never a fetch.

Settings entries extend the built-in selection. Naming a plugin cannot drop Bash or the default prompt; a built-in is turned off by name with `{ "plugin": "codework.tool.bash", "enabled": false }`. An embedder that passes its own `plugins` list gets exactly that list. Settings layers are covered in [settings](./07_settings.md).

Relative paths anchor to the directory of the file that declared them, not to the project or `hostCwd` ([settings.ts](../../packages/harness/src/settings/settings.ts) `anchored`). In a user file, `./plugins/x.ts` would otherwise name a different file in every project. Remote tarballs are refused because they have no version, no auth and no update story.

There is no plugin lockfile, and that is deliberate. An exact version or a full commit SHA is the pin. Ranges, tags and branches are allowed and marked `mutable`; only `plugin check` and `plugin update` re-resolve them. Do not add a lockfile.

## Installation and the Store

**Boot never touches the network.** Every load path is resolve-only against the store ([harness.ts](../../packages/harness/src/effect/harness.ts)). A spec with no bytes on disk fails as `plugin-not-installed`, and the remedy is `codework plugin install`. Bytes reach the disk only through `plugin add`, `install` and `update`. Keep it that way: an installing boot makes every start a possible network wait and lets network timing decide which code runs.

The store lives under `<home>/cache/plugins/` ([store.ts](../../packages/harness/src/plugin/store.ts)). The traps:

- **Nothing is written into a project.** One store, keyed by the canonical spec, serves every project.
- **Generations are immutable.** An install stages next to the live one and renames into place. A running turn keeps its file URLs, and Node's ESM cache, which is keyed by URL and never evicts, sees a new path. A package is imported and validated while still staged, so a non-plugin never becomes the newest marked generation.
- **Registry identity includes the registry.** The digest of a registry package covers the effective registry URL, so a private and a public package of one name never share bytes.
- **Updates land at the next turn.** Each turn checks whether the store moved under a loaded module and imports the new generation. Nothing polls. Local path plugins have no generation, so only `plugin reload` picks up an edit to one.

Installs run npm's own libraries in process; no package manager binary is spawned ([npm.ts](../../packages/harness/src/plugin/npm.ts)). The CLI ships as a single binary, and the user may not have npm. Lifecycle scripts never run. Git sources are allowed for the spec a person named, never for a git dependency some other package pulls in.

Published plugins must ship built JavaScript. Node refuses to strip types under `node_modules`, and no `prepare` script runs. A local `.ts` file loaded by path works, which keeps the single-file workflow in [extras/plugins](../../extras/plugins) usable.

## Who Owns `.npmrc`

The `.npmrc` chain is read from the project that declared the entry, never from the cache or a staging directory ([loader.ts](../../packages/harness/src/plugin/loader.ts) `anchor`). A company repo keeps its private registry and scoped token there. Reading the chain anywhere else resolves against the public registry and fails, or installs a public package of the same name. `plugin add --session` reads it from the session's project for the same reason, not from the server's directory.

The npm cache path is passed on `argv` so it outranks every `.npmrc`, which keeps `--home` runs self-contained. The install never sets `env`. Leaving it out is what lets git reach private remotes through the user's SSH agent and credential helper.

## Tools

Built-in tools are built-in plugins ([builtin.ts](../../packages/harness/src/plugin/builtin.ts)), so they go through the same selection and configuration as third-party ones. There is no `+tool` / `-tool` list. A tool plugin that should ship off sets `optIn: true`, and a settings entry `{ "plugin": "<id>", "enabled": true }` turns it on. The search tools ship this way. `toolsearch` is opt-in too, but turns on by itself in a turn that has deferred tools.

A later `tools.add` with the same name replaces the earlier tool. `tools.update` patches only descriptive fields.

`ToolExposure` ([tool.ts](../../packages/plugin/src/tool.ts)) decides where a tool is reachable:

| Value      | Meaning                                                   |
| ---------- | --------------------------------------------------------- |
| `direct`   | Declared to the model every turn. The default.            |
| `model`    | Declared every turn, never callable from other tools.     |
| `deferred` | Off the wire until `toolsearch` loads it.                 |
| `codemode` | For codemode scripts. Not callable until codemode exists. |
| `hidden`   | Never reaches the model.                                  |

`toolsearch` itself is `model`, because searching changes what the model is offered. A loaded deferred tool reaches the model as a transcript message, not in the request's `tools`, so loading one keeps the cached request prefix.

### Explicit Failures

A failed tool result says plainly what happened. When Bash fails under `sh` because `bash` is not on `PATH`, the result says it ran under `sh`. When `rg` or `fd` is missing and cannot be installed, the tool tells the model instead of switching engines ([binary.ts](../../packages/harness/src/tool/binary.ts)). Sandboxes are environments we do not control, and silent fallbacks hide that from the model and the user.

## Prompt Sections

The system prompt is an untagged foundation followed by tagged sections ([section.ts](../../packages/plugin/src/plugin/section.ts), [render.ts](../../packages/harness/src/plugin/prompt/render.ts)). Every section except the foundation is a tag. Section names start with a lowercase letter, then use lowercase letters, digits, `_` or `-`. Some names are reserved because the harness renders them itself. Sections are passed by value, so a typo fails to compile instead of opening a new section. Each section's text is compared whole between requests, so an unchanged one is not sent again.

## MCP

MCP servers always run on the host, never in a sandbox ([mcp.ts](../../packages/harness/src/mcp/mcp.ts)). Process spawning and the files for truncated or binary output use the host OS and host temp, never `SandboxIO` ([output.ts](../../packages/harness/src/mcp/output.ts)).

A stdio server starts in a directory chosen by its `scope`. A `session` server starts in the thread's directory when the sandbox is local. Otherwise that directory does not exist on the host, so it starts in `hostDir`, else `hostCwd`, and gets no roots. A `space` server follows the same rule with the space root. An `app` server starts in `hostCwd`. The server's own relative `cwd` resolves against that start directory.

Servers are configured in `mcp.json` beside each settings file, in the `mcpServers` shape other clients use ([config.ts](../../packages/harness/src/mcp/config.ts)). A project entry with no `command`, `url` or `type` only overrides `enabled` and exposure of the user server of that name, keeping credentials a project could not set. Unlike settings, a broken `mcp.json` entry is reported and skipped. `mcp` plugins can edit the servers before tools exist.

Connections never open a browser. They use stored tokens, refresh them, or move to `authenticate`, and the user signs in with `codework mcp login`. Server states are single words. Credentials live in `<home>/mcpauth.json`, and a refresh holds a cross-process lock because servers rotate refresh tokens and a token used twice loses the grant ([oauth.ts](../../packages/harness/src/mcp/oauth.ts)). A tool call is never retried once the server may have run it.

## Examples

[`extras/`](../../extras) holds example third-party plugins: a tool plugin, a prompt plugin, single-file local plugins and a sandbox driver. The tool and prompt examples export TypeScript and are loaded by path in this repo, so they are not installable from a registry as written.
