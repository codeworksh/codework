# Desktop

The desktop app is three processes and a widget SDK. Electron main ([apps/desktop](../../apps/desktop/src/main.ts)) hosts the window. The app server ([apps/server](../../apps/server/src/server.ts)) owns the app's database and talks to CodeWork RPC servers. The UI ([apps/web](../../apps/web/src/main.tsx)) renders. Widgets ([apps/widget](../../apps/widget/package.json)) have a view half in the UI and a backend half in the app server.

The app is a client. Agents run on a host, and the app only mirrors and commands them.

## Processes

Electron main serves the UI from a custom scheme, `codework://app` when packaged and `codeworkdev://app` from the repo. It serves the built `apps/web`, or proxies to a web dev server when `CODEWORK_WEB_URL` is set. The Clerk bridge registers that scheme as privileged, so it must run before Electron is ready.

Main starts the app server with Electron's own binary and `ELECTRON_RUN_AS_NODE` ([server.ts](../../apps/desktop/src/server.ts)). No system Node is needed, and the child is not a second GUI instance. The server listens on `127.0.0.1` with an OS-chosen port and a fresh token, and prints both on one ready line. Main never echoes that line. The window opens only after it, so the preload can read the endpoint synchronously.

Lifetimes are tied together:

- There is no restart. If the app server exits, the app quits.
- Quitting waits for the app server to stop, and kills it if it outlasts a grace period.
- The app server watches its parent and stops itself once orphaned. Windows never reparents an orphan, so it asks whether the parent pid still runs.
- A single-instance lock stops a second launch, which would start a second app server on the same database.

The renderer is sandboxed and sees only the narrow `desktopBridge` from [preload.ts](../../apps/desktop/src/preload.ts), plus Clerk's own bridge for its session. The app server's socket takes only its token, and refuses any `Origin` but the app's two schemes. A plain browser has no bridge, so its calls fail and widgets say so.

The UI reaches CodeWork state only through the app server. Account and workspace calls are the exception: they go straight to Relay over HTTP with the Clerk session token ([relay.ts](../../apps/web/src/kernel/relay.ts)).

## Channels and Data

Each channel installs side by side with its own identity ([electron.config.ts](../../apps/desktop/electron.config.ts)). A run from the repo is the `local` channel.

| Channel      | Electron data       | App database                      |
| ------------ | ------------------- | --------------------------------- |
| latest       | `codework`          | `<home>/desktop/latest/app.db`    |
| dev, canary  | `codework<channel>` | `<home>/desktop/<channel>/app.db` |
| local (repo) | `codeworklocal`     | `<home>/desktop/local/app.db`     |

`<home>` is `CODEWORK_HOME_DIR`, else `~/.codework`: the same home the built-in local server uses. Running the app from the repo without a throwaway `CODEWORK_HOME_DIR` writes into the real home. Tests name the file directly with `CODEWORK_DATABASE`.

## The App Server Is a Client

The app server never touches project files. Browsing folders, creating and cloning projects, git diffs and skills are all RPC calls to a host ([handlers.ts](../../apps/server/src/handlers.ts)). A host call that names its machine runs over the connection Sync holds for it. One that names none goes to the default machine, over the app's main connection. The native folder picker only returns a path on this computer, so it is offered only for the default machine.

The UI speaks [apps/contract](../../apps/contract/src/contract.ts), never the harness protocol. The app server speaks the harness protocol through a copy in [apps/widget/src/codework.ts](../../apps/widget/src/codework.ts). Its source of truth is `packages/codework/src/server`, and the two must change together. A reply the copy cannot decode surfaces as `CodeworkUnavailable`. A default server that answers `server.info` but fails `thread.list` shows as Incompatible.

The CLI owns a local server's lifecycle ([cli.ts](../../apps/server/src/cli.ts)). The app runs `codework service <action>` with the server's `CODEWORK_HOME_DIR`, and never runs `serve` itself. It finds `codework` in the install script's folder, then through a login shell, because an app opened from the Dock lacks the terminal's PATH.

## Machines

Every server the app knows is a row of the `machine` table ([servers.ts](../../apps/server/src/servers.ts)). A row's id is the app's own, not the id in the host's `machine.json`. A remote row stores that one separately, as last reported.

- **Local** rows are found through a home. Each needs its own home, because a home's `service.json` names one server. The built-in `local` row uses the CLI home and cannot be removed.
- **Default** is always a local row. The app's main connection reads `service.json` again on every connect, so a restart on a new port is picked up. A change of the default's home ends the connection, and the reconnect reads the new one ([codework.ts](../../apps/server/src/codework.ts)).
- **Reachable** means the WebSocket opens. The registered pid proves nothing, since the server may run on another OS, as one in WSL does for the Windows app.
- **Remote** rows are paired with a one-time code ([pairing.ts](../../apps/server/src/pairing.ts)). The app has one device key per install, kept in app.db. Every socket takes a fresh ticket, and the reply must be signed with the machine key it paired with.

A refused ticket drops the pairing and the connection waits until the user pairs again. A reply signed by another key, or a clock outside the proof window, is recorded as a mismatch and retried. Mismatches live in memory only.

The app does no WSL discovery. On Windows the preload omits the folder picker and reveal, since their Windows paths mean nothing to a server in WSL, and the user sets up the connection by hand.

## Mirroring Harness State

[sync.ts](../../apps/server/src/sync.ts) keeps app.db a copy of every machine's state, one connection per row. Three cursors move independently: the index (`index.sync`), the usage rollup (`usage.sync`), and the detail of opened threads (`thread.sync`).

- **Resume or start over.** A store is known by its id and boot. The sync resumes only on the same store with a head at or past the cursor. Otherwise it reads from zero, and that first batch soft-deletes every session and thread it did not send.
- **One store, one row.** The same server added twice has one row sync and the other wait, with a warning.
- **One transaction per batch.** Each batch commits with its bus notice through `Event.transact`, so a row and its event land together. Foreign keys are deferred to commit, because rows arrive in revision order.
- **Keys.** Projects and spaces are keyed by machine and id, since core ids are repo hashes and collide across machines.
- **Two owners per row.** Core columns come from the host and are overwritten on every batch. Desktop columns are set on insert and never copied from the host ([mirror.ts](../../apps/server/src/mirror.ts)).
- **Thread detail.** It syncs only while some window has the thread open. A first open replaces the thread's entries, and older entries are paged in below a floor. A live delta is kept only if it continues the held draft exactly, and is never stored.
- **Daemon state.** Git status and skills are mirrored from the host's event stream, so a stopped sandbox shows its last state without being woken ([changes.ts](../../apps/server/src/changes.ts)).

Reads ([reads.ts](../../apps/server/src/reads.ts), [metrics.ts](../../apps/server/src/metrics.ts)) never call CodeWork, so they answer while a machine is away. Commands go to the machine a session is on. A session the index has not brought yet is on the machine that created it, which Sync holds in memory until the index brings it; `settle` waits for that machine's index to catch up so a fresh session is readable. Removing a server cascades its rows, except usage, which has no foreign keys and stays as history; a `sync/changed` notice in the same transaction names its sessions, threads, spaces and projects, so the views showing them read again.

## Desktop-Only State

Issue tracking lives only in app.db, never in the harness or its RPC. Status, priority, group, order and color are desktop columns, and only the app server writes them. The sync moves status to `enqueued` or `working` as runs start. A run ending changes nothing: the user moves the thread to review, settled or cancelled through [tracking.ts](../../apps/server/src/tracking.ts), which writes each edit with its bus event in one transaction. Order is fractional, so a move writes one row ([ordering.ts](../../apps/server/src/ordering.ts)).

Tabs, the desk of widget instances, per-package kv and the event log are app.db tables too ([tabs.ts](../../apps/server/src/tabs.ts), [desk.ts](../../apps/server/src/desk.ts)). The desk is read and replaced whole.

## Widgets and the Bus

A widget backend is an Effect program that runs inside the app server. Built-in backends are exported from [@codeworksh/web/backends](../../apps/web/src/widgets/backends.ts) and started by [widgets.ts](../../apps/server/src/widgets.ts).

The bus is the event log in app.db ([event.ts](../../apps/server/src/event.ts)). Topics are `<package>/<name>`, and a widget publishes only under its own package. A backend that tries another package dies, because that is a bug, not a runtime condition. A subscription replays after a seq, sends `Synced`, then goes live. Ephemeral events are never stored. `watchers` counts subscribers per topic, so a backend keeps work going only while someone looks.

The window manager ([wm](../../apps/web/src/wm/desktop.tsx)) is built on webwm. An instance's tag mask is the set of tabs it shows on. [resolver.ts](../../apps/web/src/wm/resolver.ts) picks the widget for an address. Desk saves wait until edits settle, run one at a time, and never resend the desk as loaded.

## UI Performance

- **Notices, not rows.** Bus notices carry ids. A view re-reads when a topic in `readTopics` fires.
- **Bounded payloads.** Line pages are cut to a byte budget, large read replies are ephemeral, and deltas are live only.
- **Stable objects.** [keep.ts](../../apps/web/src/kernel/keep.ts) reuses unchanged items from the previous read, so memoized rows skip rendering.
- **Little off screen.** The transcript loads in pages, newest first. Long lists such as thread rows use `content-visibility`, so off-screen rows skip layout and paint.
- **No endless repaint.** Looping loaders pause off screen and in hidden tabs ([visible.ts](../../apps/web/src/lib/visible.ts)) and respect reduced motion. The text shimmer steps instead of animating every frame, because `background-position` repaints.

## UI Copy

Errors are sentences in the app's own words and say what to do next. The app server translates host failures before they reach the UI. Internal vocabulary is translated: a linked space shows as "Worktree", and the built-in server as "This Machine". Titles and buttons use title case; descriptions use sentence case.
