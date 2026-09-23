# @codeworksh/cli

Run coding-agent sessions in your repo or a sandbox.

## Installation

```bash
pnpm add -g @codeworksh/cli
# or run directly
pnpm dlx @codeworksh/cli <command>
```

After install, every command is `codework <command>`.

## Development

From `packages/codework`, or `pnpm cli` at the repo root:

```bash
pnpm start -- --help
pnpm start -- models
pnpm start -- run "Inspect the failing tests"
```

`start` runs `src/index.ts` with `--conditions=development` so workspace packages resolve to source. The published `codework` binary is the packed `dist` build.

---

## Commands

### `codework run`

Run an agent session with a prompt.

```bash
# Start a new session
codework run "Inspect and fix the failing tests"

# Create a session with explicit provider and model
codework run --provider openai --model gpt-5.5 --thinking high "Plan database migration"

# Continue an existing session
codework run --session ses_01a070f0 "Now implement the migration script"

# Run in an isolated sandbox (local, daytona, vercel, memory, sqldb)
codework run --sandbox-driver daytona "Inspect repository"
codework run --sandbox-driver daytona --sandbox-provider-id <remote-id> "Continue in sandbox"
```

#### Flags:

- `--server <url>` — Connect to a running RPC server, e.g. `ws://127.0.0.1:7433/rpc`.
- `-s, --session <id>` — Continue an existing session.
- `-C, --cwd <path>` — Working directory for a new session.
- `--sandbox-driver <driver>` — Sandbox driver (`local`, `daytona`, `vercel`, `memory`, `sqldb`). Default: `local`.
- `--sandbox-id <id>` — Reuse an existing sandbox instance; mutually exclusive with driver/provider coordinates.
- `--sandbox-provider-id <id>` — Provider ID of an existing remote sandbox.
- `--provider <id>` — Model catalog provider ID.
- `--model <id>` — Model ID.
- `--thinking <level>` — Reasoning effort the model uses before answering (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

Global flags: `--user-config-dir`, `--home`, `--database`.

---

### `codework serve`

Start a persistent server that owns sessions and sandboxes:

```bash
codework serve --host 127.0.0.1 --port 7433
codework run --server ws://127.0.0.1:7433/rpc "Inspect the failing tests"
codework run --server ws://127.0.0.1:7433/rpc --session <id> "Now fix them"
codework run --server ws://127.0.0.1:7433/rpc --sandbox-id <sandbox-id> "Start another session in this sandbox"
```

The default address is `127.0.0.1:7433`; `--port 0` picks an available port and prints the actual URL. Set `--home`, `--database`, and `--user-config-dir` on the server. Model credentials, plugins, and working directories are resolved by the server. A remote run does not boot a local harness.

Events are live and not replayed. The client subscribes before admitting its prompt and waits for execution completion after rendering. Lost connections and overflow fail the command; disconnecting leaves server work running. Ctrl-C sends `session.interrupt`, which interrupts the shared session. Remote runs print the sandbox ID for reuse. `session.interrupt` returns `{ interrupted }` as soon as the stop is accepted; `session.wait` is the separate cleanup barrier. A busy period reports itself as `session.execution.started` followed by exactly one of `succeeded`, `failed`, or `interrupted` -- a failure carries a category (`provider-authentication-error`, `model-not-found-error`, `sandbox-mount-error`, ...) that the client renders, and an interruption carries whether it was the user or a server shutdown. Managed sandboxes remain available until explicitly stopped or server shutdown; external sandboxes are not stopped.

The v0 endpoint has no authentication; its default binding is loopback. Plugins publish their own event types by declaring them (`Plugin.define({ events: [...] })`, namespaced `plugin.<plugin-id>.*`); the feed carries those and skips types nothing declared. Invalid payloads for declared types fail with a typed encoding error.

---

### `codework auth login|status|refresh|logout`

Sign in to OpenAI Codex with your ChatGPT account, or to GitHub Copilot with your GitHub account. Credentials are
stored under the selected Codework home and are loaded automatically when a run uses an `openai-codex` or
`github-copilot` model.

```bash
# Sign in
codework auth login --openai-codex
codework auth login --github-copilot

# Codex without a local callback port (SSH, containers, port 1455 in use)
codework auth login --openai-codex --device

# Inspect credential metadata without printing tokens
codework auth status --openai-codex
codework auth status --github-copilot

# Renew an expired login, or clear one
codework auth refresh --openai-codex
codework auth logout --github-copilot

# Authenticate the home owned by a running RPC server
codework auth login --openai-codex --server ws://127.0.0.1:7433/rpc
```

`--home` keeps authentication alongside the rest of that Codework installation; `--auth-file` overrides the credential
file directly. Both providers share one `auth.json`, keyed by provider, so signing out of one leaves the other alone.
With `--server`, the CLI runs the interactive login locally -- a browser callback and a device prompt both need this
terminal -- and sends only the resulting credentials to the RPC server for storage.

**OpenAI Codex** has two flows. The default keeps Aikit's registered `http://localhost:1455/auth/callback` redirect,
and falls back to asking for the redirect URL if the callback never arrives. `--device` instead prints a code to enter
at `auth.openai.com/codex/device` and needs no local port at all — use it over SSH, inside a container, or when another
sign-in already holds 1455. That port is fixed by the redirect registered against the OAuth client, so it cannot move.

**GitHub Copilot** uses the GitHub device flow: the CLI prints a user code, opens `github.com/login/device`, and waits.
The token does not expire, so there is no `--refresh` -- sign in again on persistent 401s. `--enterprise <domain>`
logs into a GitHub Enterprise host, and `--enable-models` turns on catalog models the account has left unconfigured.
Login records the plan-specific Copilot API host, which later runs use in place of the catalog default.

---

### `codework models`

List catalog models as `provider/model`, one per line.

```bash
# List all models across all providers
codework models

# List models for a specific provider
codework models --provider openai

# List all supported provider IDs
codework models providers
```

---

### `codework models refresh`

The model catalog lives at `<home>/models.gen.json` (`~/.codework` unless `--home` says otherwise). Every local command checks it before use and downloads a new one once it is older than 15 minutes (`CODEWORK_MODELS_TTL`, e.g. `"1 hour"`); `codework serve` also re-checks every minute and reloads the file whenever it changes. A failed download keeps the previous catalog.

```bash
# Download the catalog if it is missing or stale; no network call otherwise
codework models refresh

# Download it now
codework models refresh --force
```

---

### `codework plugin add` / `codework plugin remove`

Install a plugin and record it in a settings file, or take it back out. Scoping follows npm: the
project is the default, `-g` is user-wide.

```bash
# This project: edits .codework/settings.jsonc, creating .codework/ here if no ancestor has one
codework plugin add @acme/codework-tool-proc@1.2.0

# Every project this user runs: writes ~/.codework/settings.jsonc
codework plugin add @acme/codework-tool-proc@1.2.0 -g

# Remove it, along with any configuration written against it
codework plugin remove @acme/codework-tool-proc
```

The project is found the way the harness finds it, and the way git finds a repository: the
nearest ancestor holding a `.codework` directory. Run from `packages/app`, the command edits the
repository's own `.codework/settings.jsonc` rather than starting a second project beside it. An
empty `.codework/` is enough — the marker is the directory, so creating it is how you say a
project begins here. When no ancestor has one, `add` creates `.codework/` in the directory you are
in and prints the path, because that decides where every later plugin entry lands.

`add` installs and imports the module before writing anything, so a spec that is not a plugin
fails with its own error and leaves the file untouched; the line it prints names the plugin ID the
module actually declared. Adding a plugin that is already configured under another spelling — a
different version, or the path instead of the package — rewrites that entry in place rather than
leaving a second loader behind, the way `npm install pkg@2` updates the spec already recorded.
Configuration written against the plugin is left where it is. Edits preserve comments, key order and formatting, and are written
through a temp file so an interrupted run cannot truncate your settings.

`remove` drops the module entry and any configuration object naming the same plugin, whichever
spelling each was written with: the version it was added with is not part of its identity, and the
ID a module declares removes the entry that loads it. Resolving an ID reads what is installed and
never fetches anything. A plugin can also be kept but switched off without removing it, with
`{ "plugin": "acme.tool.proc", "enabled": false }`.

#### Flags:

| Flag                | Description                                                                        |
| :------------------ | :--------------------------------------------------------------------------------- |
| `-g`, `--global`    | Edit the user-wide settings file instead of this project's                         |
| `--home`            | Where that user-wide file lives (default: `CODEWORK_HOME_DIR`, else `~/.codework`) |
| `--user-config-dir` | Edit `<dir>/settings.jsonc`; outranks both of the above                            |

Plugin entries accumulate across settings layers, so a user-wide plugin still applies inside a
project that declares its own. A project that wants an inherited plugin gone says so in its own
file, with `{ "plugin": "<id>", "enabled": false }`.

---

## Environment Variables

| Variable                       | Description                                                         |
| :----------------------------- | :------------------------------------------------------------------ |
| `CODEWORK_MODELS_FILE`         | Pin the catalog to a file you manage; never refreshed automatically |
| `CODEWORK_MODELS_TTL`          | How old the catalog may get before a refresh (default `15 minutes`) |
| `OPENAI_API_KEY`               | API key for OpenAI models                                           |
| `ANTHROPIC_API_KEY`            | API key for Anthropic models                                        |
| `OPENROUTER_API_KEY`           | API key for OpenRouter models                                       |
| `GOOGLE_GENERATIVE_AI_API_KEY` | API key for Google models                                           |
| `XAI_API_KEY`                  | API key for xAI models                                              |

---

## License

MIT
