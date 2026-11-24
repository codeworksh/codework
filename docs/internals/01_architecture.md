# Architecture

CodeWork runs agents in one place: the host process that owns a home. Everything else is a library that process loads, a client that talks to it over RPC, or a cloud service that records which people and machines belong together. A client never substitutes its own files, credentials or database for the host's.

## Domains

| Domain | Packages                                                | Owns                                                                                                          |
| ------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Core   | `packages/aikit`, `packages/harness`, `packages/plugin` | Models, the loop, tools, sandboxes, the plugin contract and the durable store. Never knows how it is reached. |
| Host   | `packages/codework`                                     | The `codework` binary: the RPC server, the CLI, ACP, and the machine's identity, pairing and Relay link.      |
| App    | `apps/*`                                                | The Electron shell, the app server, the UI, the app's RPC contract and the widget SDK.                        |
| Cloud  | `infra/relay`, `infra/catalog`                          | Accounts, workspaces and machines; the model catalog bucket. Never runs an agent.                             |

`packages/schema` sits outside the domains. It holds the wire pieces more than one domain speaks: Relay's HTTP API, signed machine requests, pairing, and the listener's door (how a client offers its token on the WebSocket). It is private and bundled into its consumers, so it never ships on its own.

## Dependency Direction

The workspace dependencies point one way:

- `aikit` depends on no other workspace package. `plugin` depends on `aikit`. `harness` depends on `plugin` and `aikit`. `codework` depends on `harness`, `aikit` and `schema`.
- `apps/server` depends on `contract`, `schema`, `web` and `widget`. No app package depends on `harness` or `codework`.
- `infra/relay` depends only on `schema`.

The rules behind that shape:

- **`plugin` never imports `harness`.** A third-party plugin builds against `@codeworksh/plugin` alone. A capability a plugin could provide gets its contract in `plugin` first, and the harness implements against it.
- **The core never imports the host.** Nothing in `harness` reaches for the CLI, the RPC server or `schema`. That is what lets three hosts (`serve`, in-process `run`, `acp`) boot the same harness.
- **`aikit` is a plain SDK.** It has no Effect dependency and emits an `AsyncIterable` of canonical events. The harness meets it at one boundary, [llm.ts](../../packages/harness/src/runner/llm.ts), which owns interruption and durable terminal errors.
- **Apps reach the host only over RPC.** The app server never imports harness code and never reads project files. Space state it shows (skills, git changes) is mirrored from daemon events on the host's event stream.

The host's RPC contract has a trap. Its source of truth is [contract.ts](../../packages/codework/src/server/contract.ts) (with `part.ts` and `envelope.ts` beside it), but the app side does not import it: [codework.ts](../../apps/widget/src/codework.ts) in the widget SDK is a hand-kept mirror. A contract change lands on both sides. The contract's error unions include harness error classes, so a harness error's tag and fields are wire format too.

## Where State Lives

| Store                              | Writer                                   | Holds                                                                              |
| ---------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `<home>/data/codework.db` (SQLite) | The harness, in whichever host booted it | Projects, spaces, sandboxes, sessions, threads, the event log and its projections. |
| `<home>/desktop/<channel>/app.db`  | `apps/server`                            | A copy of each machine's rows, plus desktop-only state: tabs, tracking, widgets.   |
| Relay's Postgres                   | `infra/relay`                            | Accounts, workspaces and machines.                                                 |

The harness database is the truth for everything about agents. `--database` or `CODEWORK_DB` moves it: a relative value resolves under `<home>/data`, and an absolute path or `:memory:` is used as given ([db.ts](../../packages/harness/src/db/db.ts)). The home also holds small files the host owns: `service.json` (how a running server is found), `machine.json` (the machine's id, keys and workspace links), `devices.json` (paired devices) and `aikit/auth.json` (OAuth logins).

`app.db` is a mirror, not a second source. [sync.ts](../../apps/server/src/sync.ts) keeps it current per machine through the `index.sync`, `usage.sync` and `thread.sync` streams. [mirror.ts](../../apps/server/src/mirror.ts) writes core columns from those rows and sets desktop columns once, on insert. Writing a core column in `app.db` changes nothing on the host and is overwritten by the next sync. State that matters to an agent run belongs in the harness and reaches the app through an event.

## Server First and Durable

Only the RPC server recovers interrupted work. [server.ts](../../packages/codework/src/server/server.ts) builds the harness, then runs `sweep` before the listener opens, then forks `resumeUnfinished`:

- `sweep` ends every stored run the last process left open with a durable interrupt, so no client ever sees a stale run as live.
- `resumeUnfinished` wakes those threads and any prompt left past a thread's head. It needs nothing from the previous process, because the log and its projections record both.
- On shutdown the server interrupts its active threads with reason `shutdown`, then stops the sandboxes it manages. Both steps are bounded, so a slow provider cannot hold the process open.

Three rules keep that working:

- **Durable events commit with their projections.** [event.ts](../../packages/harness/src/event/event.ts) assigns the sequence, runs the projectors and stores the row in one transaction. A projector that rejects an event rolls the event back with it, so the log and its views never disagree. State a client must see after a restart is an event plus a projection, never process memory.
- **Ephemeral events are lost on purpose.** Events defined without a durable aggregate, such as text and thinking deltas, notify live subscribers and are never stored. A client that misses them catches up from committed entries, so nothing may depend on having seen a delta.
- **No run needs a client.** `thread.prompt` returns once the prompt is admitted, under a stable id so a retry is idempotent. Closing the socket does not stop the run; stopping is an explicit `thread.interrupt`, which the CLI sends on Ctrl+C.

## In-Process and `--server`

The CLI has two modes, and both stay supported.

`codework run` without `--server` boots `Harness.layer` in its own process against the same home database a server would use. [harness.ts](../../packages/codework/src/cli/harness.ts) builds the boot options for `run`, `serve` and `acp`, so a session created by one is readable by the others. An in-process run lives only as long as the CLI process. It does not sweep or resume. If it crashes, the next `codework serve` on that home finds the open run and resumes it; a Ctrl+C records a user stop, which is not resumed.

With `--server`, commands use the RPC client. [service.ts](../../packages/codework/src/cli/service.ts) only connects to the server the home's `service.json` names, because the home's token must never be offered to any other server. A URL passed to `--server` must name that same server (a loopback alias counts). To reach another home's server, point `--home` at that home. Commands that manage existing sessions and threads (`thread list`, `thread fork`, `session link`) always go through the home's server, with or without the flag.

`codework acp` serves editors over stdio and always runs the harness in-process.

## The App Is a Client

The desktop app is three processes. Electron main spawns the app server ([server.ts](../../apps/desktop/src/server.ts)) and loads the UI. The app server owns `app.db` and connects to one or more host RPC servers, local and paired.

The app server does not run a CodeWork server itself. The CLI owns a server's lifecycle: the app asks it with `codework service start|stop|restart` in that server's home, and finds the running server through the home's `service.json` ([cli.ts](../../apps/server/src/cli.ts), [codework.ts](../../apps/server/src/codework.ts)). A feature that needs new host behavior is built in the harness, exposed in the host's contract, mirrored in the widget SDK, then used by the app.
