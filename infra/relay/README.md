# Relay

Relay is the cloud API for accounts, workspaces and machines, served at `relay.codework.sh`. The desktop app calls it for the signed-in person's workspaces and machines, and `codework connect` and the RPC server's heartbeat call it to link a machine and show it online.

Relay records membership and nothing more. It never runs an agent, never carries RPC traffic, never stores how to reach a machine and never grants access to one. A machine a member can see in Relay still has to be paired before anyone can call it. Read [docs/internals/10_relay.md](../../docs/internals/10_relay.md) before changing auth, signing or link behavior.

## Responsibilities

- Creating a person's account and default workspace on their first call to `/v1/me`.
- Creating workspaces, and listing a workspace's linked machines, with whether each is online, and its pending connects.
- Running the connect flow: register a link key, hand out a code, let a member approve or decline it, activate the link on the machine's next poll.
- Accepting heartbeats and revokes, so a machine can leave and a member can remove one.

People call with a Clerk session token. Machines never hold a session: every machine request is one compact JWS signed with its link key. Keep the two kinds of caller apart.

## Code Map

- [`src/main.ts`](./src/main.ts) is the Node entry: it migrates, then serves on `HOST` and `PORT`.
- [`src/http.ts`](./src/http.ts) wires the HTTP handlers, person auth and CORS.
- [`src/accounts.ts`](./src/accounts.ts) holds accounts, workspaces and membership.
- [`src/machines.ts`](./src/machines.ts) holds connects, approvals, links, heartbeats and revokes.
- [`src/clerk.ts`](./src/clerk.ts) wraps the auth vendor behind token verification and profile lookup.
- [`src/db.ts`](./src/db.ts) and [`src/migrations.ts`](./src/migrations.ts) are the Postgres client and its migrations, shipped as code. Keep schema and migration changes together.
- [`test`](./test) runs real connects against a real Relay and Postgres.

The API contract lives in [`packages/schema/src/relay.ts`](../../packages/schema/src/relay.ts). Relay implements it, and the CLI and desktop renderer call it with typed clients. The machine side of connect lives in [`packages/codework/src/machine`](../../packages/codework/src/machine).

## Working Locally

Relay needs Postgres and a Clerk secret key. `pnpm db` starts the local Postgres from [`compose.yaml`](./compose.yaml) on port 55432:

```sh
cd infra/relay
pnpm db
DATABASE_URL=postgres://relay:relay@127.0.0.1:55432/relay CLERK_SECRET_KEY=... pnpm start
```

It listens on `127.0.0.1:8787` by default. Set `HOST=0.0.0.0` so machines on other hosts can reach it, and point a CLI at it with `CODEWORK_RELAY_URL`.

```sh
pnpm test
pnpm typecheck
```

The tests start Postgres in Docker, spawn Relay on a fresh database and create a Clerk test user. They take `CLERK_SECRET_KEY` from the environment or the repo root `.env.local`, and skip when it is missing.
