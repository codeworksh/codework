# App Server

The desktop app's own Node server. Electron main starts it, and the UI talks to it over WebSocket RPC. It owns `app.db` and is a client of one or more CodeWork RPC servers, local and paired.

## What It Owns

- **app.db.** Kept at `<home>/desktop/<channel>/app.db`, where `<home>` is `CODEWORK_HOME_DIR`, else `~/.codework`. Tests name the file with `CODEWORK_DATABASE`.
- **The machine list.** Every RPC server the app knows is a row: local ones found through a home, remote ones paired with a one-time code.
- **A mirror of host state.** The sync keeps app.db a copy of each machine's sessions, threads and usage, so reads answer while a machine is away. Commands go to the machine a session is on.
- **Desktop-only state.** Issue tracking, tabs, the desk, per-package kv and the event bus live here and nowhere else.
- **Widget backends.** Built-in backends from [`@codeworksh/web/backends`](../web/src/widgets/backends.ts) run inside this process.

## Boundaries

- It never touches project files. Folders, projects, clones, git diffs and skills are all RPC calls to a host. The host is where agents run and where files live, so the app works the same against a remote machine.
- It never runs `codework serve`. A local server's lifecycle goes through `codework service <action>`.
- The UI speaks [`@codeworksh/contract`](../contract). This server speaks the harness protocol through the mirror in [`@codeworksh/widget/codework`](../widget/src/codework.ts).

## Code Map

- [`src/index.ts`](./src/index.ts): process entry.
- [`src/server.ts`](./src/server.ts): the RPC listener, its token check and the layer graph.
- [`src/handlers.ts`](./src/handlers.ts): the contract's handlers.
- [`src/servers.ts`](./src/servers.ts): the machine table and local homes.
- [`src/codework.ts`](./src/codework.ts): connections to CodeWork RPC servers.
- [`src/pairing.ts`](./src/pairing.ts): pairing remote machines.
- [`src/sync.ts`](./src/sync.ts), [`src/mirror.ts`](./src/mirror.ts): mirroring host state into app.db.
- [`src/reads.ts`](./src/reads.ts): reads served from app.db.
- [`src/event.ts`](./src/event.ts), [`src/widgets.ts`](./src/widgets.ts): the event bus and widget backends.
- [`src/cli.ts`](./src/cli.ts): installing and running the `codework` CLI for local servers.

## Working Locally

It runs as part of `vp run dev:desktop` from the root. On its own, `vp run dev` here rebuilds the bundle on change and `vp test` runs the tests; the `live` project needs OrbStack machines. See [development](../../docs/operations/00_development.md), [testing](../../docs/internals/13_testing.md) and [desktop internals](../../docs/internals/11_desktop.md).
