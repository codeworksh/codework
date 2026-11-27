# Relay

Relay ([infra/relay](../../infra/relay)) is the cloud API for accounts, workspaces and machines. It records who belongs to a workspace and which machines are linked to it, and shows whether each machine is online. It never runs an agent, never carries RPC traffic, never stores how to reach a machine, and never grants access to a machine. This page holds the trust model behind it and the rules that span Relay, the CLI and the desktop app.

## Linked Is Not Paired

These are two separate relationships, and neither implies the other.

| Relationship | Made with                                 | Grants                                   |
| ------------ | ----------------------------------------- | ---------------------------------------- |
| Paired       | a one-time code from the machine's server | full authority over that server          |
| Linked       | `codework connect`, approved by a member  | a listing in the workspace, nothing more |

The server's door admits only the home's token from loopback or a paired device's ticket ([door.ts](../../packages/codework/src/server/door.ts)). Nothing from Relay is checked there. A workspace member who can see a machine in Relay still cannot call it without pairing. Pairing is covered in [server](./09_server.md).

The desktop app links a machine it has already paired: it calls `machine.connect` on that machine over RPC, then approves the code itself as the signed-in member ([connect.tsx](../../apps/web/src/shell/connect.tsx)). Relay alone decides whether a machine is in a workspace. The machine's own record only says whether it still holds the key Relay lists, and whether it is leaving ([shared.tsx](../../apps/web/src/settings/machines/shared.tsx)).

## One Contract, Two Kinds of Caller

The API is declared once in [packages/schema/src/relay.ts](../../packages/schema/src/relay.ts). Relay implements it, and the CLI and the desktop renderer call it with typed clients. `packages/schema` is bundled into its consumers, never published.

People call with a Clerk session token as a bearer ([clerk.ts](../../infra/relay/src/clerk.ts)). Relay takes only the verified subject from it, and reads the person's email and name from Clerk once, on their first call. The `account` row is keyed by that subject, so a change of auth vendor migrates users and nothing else. Clerk being unreachable is `Unavailable` (try again), never `Unauthorized`. The desktop app shows the two differently. CORS admits only the desktop renderer's origins ([http.ts](../../infra/relay/src/http.ts)), so the renderer talks to Relay directly, not through the app server.

A person's first call to `/v1/me` creates their account and a default workspace in which they are the owner. Two concurrent first calls create exactly one account and workspace, because the unique subject makes the loser insert nothing ([accounts.ts](../../infra/relay/src/accounts.ts)).

Machines never hold a session. Every machine request body is one compact JWS ([jws.ts](../../packages/schema/src/jws.ts), Ed25519 over WebCrypto so the same code signs in Node and verifies in any runtime). Its claims name the operation in `op`, so a signature made for one endpoint is refused by every other. Each request carries `iat` and is refused outside a short freshness window. A machine with a skewed clock therefore sees its heartbeats refused, and its server logs a warning rather than treating that as a revoke. `revoke` also carries a `jti`, kept in the database so a replay is refused across every Relay instance. Heartbeats are idempotent and carry none.

## Identity Key and Link Keys

A home has two kinds of key, both in `<home>/machine.json` ([file.ts](../../packages/codework/src/machine/file.ts)). That file holds private keys, so it is written 0600, atomically, under a lock shared by `serve` and `codework connect`. `serve` creates it, with the machine's id and identity key, as it starts, so the local machine has an id before it links or pairs. `codework connect --machine-id` can still replace a generated id that no workspace has seen, which is how a rebuilt machine takes its old id back. Once linked, the id is fixed.

- The **identity key**: one per home. It vouches for link keys, and it signs pairing tickets on the server.
- A **link key**: one per workspace link. Every request for that link is signed with it and names it by thumbprint.

A thumbprint finds exactly one link row, so one home linked to three workspaces is three rows. Leaving one workspace revokes one key and leaves the others working.

At connect, the identity key signs an `identity.bind` claim naming the new link key's thumbprint, embedded in the pairing request ([relay.ts in schema](../../packages/schema/src/relay.ts)). A copied public key proves nothing, and a binding made for one link cannot serve another. Relay stores the identity key's thumbprint on each link. Rows that share it, in any workspace, are one machine. A key registers once. Relay refuses a key that already backs a link or a connect.

## Connect and Approval

[machine/relay.ts](../../packages/codework/src/machine/relay.ts) runs the machine's side and [machines.ts](../../infra/relay/src/machines.ts) runs Relay's.

1. The machine makes a fresh link key and registers it with a pairing request. Relay answers with a short code for a person to type.
2. The machine polls, each poll signed with the new key. Only the process that holds the key learns the outcome.
3. A member approves the code in the app. Approval only marks the pairing.
4. The machine's next signed poll activates the link. A key nobody holds anymore therefore never replaces a working link.
5. The machine saves the link under the lock. If another connect saved a different key for that workspace in the meantime, it polls once more before replacing it.

A pending connect stays listed and approvable only while its machine keeps polling. A connect that stops is never linked. A connect started without a workspace is never listed to any workspace. Whoever types its code picks the workspace. A code started for one workspace cannot be approved in another.

A machine's id is generated once per home, or set with `--machine-id` so a rebuilt machine replaces its old link. A home's id never changes. When a connect for an id already in the workspace activates, it replaces that link, and every other connect for the same machine and workspace is superseded. The replaced link keeps its owner. A new link, or one that was revoked, belongs to the approver.

Links remember the Relay they were made with. `CODEWORK_RELAY_URL` changes where new connects go. Heartbeats and revokes for an existing link still go to its own Relay.

## Roles

People are owners, admins or members of a workspace. Today the code draws one line: a member may manage only machines they own, while an owner or admin may manage any. Approving a brand new machine needs only membership. Replacing or removing another person's machine needs owner or admin.

A link whose owner is no longer a member of the workspace is refused as revoked, like a removed one.

## Heartbeats and Leaving

The heartbeat runs in the RPC server, not in the CLI ([heartbeat.ts](../../packages/codework/src/machine/heartbeat.ts)). A machine shows online only while its server runs, and `codework connect` says so when none is running. The server re-reads `machine.json` on every beat, so a connect made while it runs is picked up without a restart. A heartbeat failure is never fatal. Local work never waits on Relay.

Every way in has a way out:

- **`codework disconnect`** (or `machine.disconnect` over RPC) asks Relay to revoke the link, signed with the link key. If Relay cannot be reached, the link is kept, marked leaving, with its key. Each heartbeat asks again until Relay confirms. Relay lists the link until then, and the machine reports it as leaving.
- **Removal by a person** in the app revokes the link in Relay. The machine learns on its next heartbeat and drops the link.

Either way, the machine removes a link only while it still holds the refused or revoked key. A reconnect that saved a new key in the meantime keeps its link.

## Running Relay

Relay is an Effect `HttpApi` over Postgres through `@effect/sql-pg`, with migrations shipped as code ([migrations.ts](../../infra/relay/src/migrations.ts)). [main.ts](../../infra/relay/src/main.ts) is the Node entry for development and the E2E suite. The routes do not depend on the runtime that serves them. [compose.yaml](../../infra/relay/compose.yaml) runs the local Postgres; production is managed Postgres behind Hyperdrive. The E2E suite in [test](../../infra/relay/test) runs real connects against a real Relay and Postgres.
