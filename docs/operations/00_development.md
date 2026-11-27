# Development

## First Checkout

Install [Vite+](https://viteplus.dev/guide/) (`vp`) and pnpm, then from the repository root:

```sh
pnpm install
```

The CLI needs Node 24.14.1 or later. Use `vp` and `pnpm` for everything; never `npm`, `yarn` or `bun`.

## A Dev Home

Every process below reads one CodeWork home: settings, `service.json`, the harness database and the desktop app's `app.db`. `~/.codework` is the developer's real install, so a dev run always gets its own home. Export it once in each shell you start a process from:

```sh
export CODEWORK_HOME_DIR="$PWD/.scratch/home"
```

`.scratch` is gitignored, so each worktree keeps its own home.

Start from an empty home. Copy the real database in only when the flow under test needs existing sessions, and only while no run is active in it: the dev server resumes every run the copy holds open, against the real project files. Copy with `sqlite3 ~/.codework/data/codework.db ".backup '$CODEWORK_HOME_DIR/data/codework.db'"`, never `cp` or a symlink.

## Running Dev Servers

Start them in this order, each in its own shell with the dev home exported.

### 1. Relay

The desktop app signs everyone in and asks Relay for their workspaces, so it needs a Relay it can reach. Please run one locally, as [Relay's README](../../infra/relay/README.md#working-locally) describes; it listens on `127.0.0.1:8787`. Then export its address next to the dev home in the shells for the RPC server and the desktop app, so both talk to it:

```sh
export CODEWORK_RELAY_URL=http://127.0.0.1:8787
```

Every checkout shares Relay's one local database, and its README has the fix for when a changed migration leaves that database behind.

### 2. CodeWork RPC Server

```sh
vp run dev:cli serve --port 0
```

This runs `packages/codework/src/index.ts` from source with the `development` condition, so the harness, aikit and plugin sources are used directly. `--port 0` picks a free port, because the installed server usually holds the default 7433. The server writes its address to `<home>/service.json`, which is how every client finds it. `vp run dev:cli service status` shows it.

Flags after the task name go to the CLI. Any other command runs against the same home, for example `vp run dev:cli run "hello"` or `vp run dev:cli thread list`. Restart the server after changing harness or codework code; nothing reloads it.

### 3. Desktop App and App Server

```sh
vp run dev:desktop
```

[dev.mjs](../../apps/desktop/scripts/dev.mjs) starts the UI on Vite at `127.0.0.1:5173`, watches the Electron and app server bundles, then opens Electron as **CodeWork Local**. Electron main starts the app server, which keeps `app.db` in `<home>/desktop/local/` and connects to the server the home's `service.json` names.

- A rebuilt Electron or app server bundle restarts Electron, and the app server with it. UI changes hot-reload.
- Quitting the app window ends the dev session. Ctrl+C in the shell stops every child.
- Port 5173 is fixed, so only one checkout can run the desktop app at a time.
- The app never starts a server on its own. Do not press Install or Start in the dev app. Install downloads the latest release into `~/.codework/bin` and starts it. Start runs that installed `codework`, else the one on your login shell's `PATH`, against the dev home. To let the app manage the dev server, set its executable in Settings → Machines to `node --conditions=development <repo>/packages/codework/src/index.ts`.

## Checks

- `vp run verify` is CI's gate: `vp check` (format and type-aware lint) over packages, scripts, `.github` and infra, package typechecks, then knip. `vp fmt` formats.
- For focused iteration: `vp check <paths>`, `vp run --filter <pkg> typecheck`, `vp run knip:check`.
- `vp test` runs the tests in the current directory. See [testing](../internals/13_testing.md) for what each suite runs.
