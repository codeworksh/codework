# Server

The RPC server (`codework serve`) is the only place an agent runs. It serves one home's harness over Effect RPC on a WebSocket. The CLI, the desktop app server and widget backends are all its clients. This page holds the rules for the contract, who may call it, how clients find it and how it stops.

## One Contract, Two Copies

The contract is [contract.ts](../../packages/codework/src/server/contract.ts), with the wire shapes of events in [envelope.ts](../../packages/codework/src/server/envelope.ts) and message parts in [part.ts](../../packages/codework/src/server/part.ts). It is served at a versioned path. The version moves only with a breaking wire change.

The desktop app and widgets do not import it. [apps/widget/src/codework.ts](../../apps/widget/src/codework.ts) is a hand-kept mirror of the subset they call. A change to an RPC the mirror carries, or to a part or envelope shape, must land in both files in the same change. The mirror has to agree on the wire, not on TypeScript identity: RPC names, payloads, success shapes and error `_tag`s. Its middleware tag is its own, but its `Unauthorized` must keep the server's tag.

Event `data` crosses the wire in its encoded form and is decoded lazily on the client against its own registry. Decoded payloads are not wire-safe, and a server may know event types a client does not, such as ones a plugin registers. A client skips a type it cannot decode. It must never fail on one.

Handlers in [handlers.ts](../../packages/codework/src/server/handlers.ts) stay thin and call harness services. Logic written into a handler is missing from the in-process CLI and from ACP.

## Who Is Calling

Every socket is judged once, before the upgrade, in [door.ts](../../packages/codework/src/server/door.ts). There are two kinds of caller ([principal.ts](../../packages/codework/src/server/principal.ts)):

| Caller | Credential                                  | May                              |
| ------ | ------------------------------------------- | -------------------------------- |
| local  | the home's token, from a loopback peer only | everything                       |
| device | a one-time ticket from a paired device      | everything except manage devices |

One call runs the other way: only a device may call `device.leave`, to unpair itself.

The token is offered as the second WebSocket subprotocol, because a browser WebSocket cannot set headers ([door.ts in schema](../../packages/schema/src/door.ts)). The listener selects the fixed first one, so the token is never echoed back. Any request with an `Origin` header is refused, so no web page can open the socket. The desktop renderer goes through its app server.

The right token from a non-loopback peer is refused. Binding to `0.0.0.0` does not open the server to the network. Another computer must pair.

After admission the door files the connection under a random key and adds it to the upgrade request as a header. Every call on that socket carries the upgrade headers, so each call finds its principal by that key. A client cannot claim another connection by sending the header in a call, because the upgrade's headers override it. Ending a connection closes its socket and drops its in-flight calls.

The token is fresh on every start and lives only in `<home>/service.json`, written 0600. A `<home>/token` file left by an older build is deleted on start.

## Pairing Is Full Authority

Pairing ([pairing.ts](../../packages/codework/src/server/pairing.ts), wire in [schema/pairing.ts](../../packages/schema/src/pairing.ts)) works like SSH keys. Each side holds a key and keeps the other's public half. Only signatures cross the wire.

1. A local caller asks for a code (`codework service pair`). The code is short-lived, single use and held in memory.
2. The other computer posts the code, a label and its public key to the devices route. It gets back its device id and this machine's identity key.
3. For each socket, the device signs a proof naming this machine's key, with a fresh nonce. The tickets route answers with a single-use ticket signed by the machine key. The device offers the ticket where a local client offers the token.

A paired device can do anything a local caller can, except pair, list or revoke devices. The CLI prints that warning with every code. Revoking a device ends its open connections at once, not on the next call.

Refusals are signed and echo the proof's nonce. This lets a device tell a real refusal from a wrong machine or an impostor, and read the machine's clock to report skew ([apps/server/src/pairing.ts](../../apps/server/src/pairing.ts)). A refusal never says why.

The identity key that signs tickets is the home's identity in `machine.json`, the same key that vouches for Relay link keys. See [relay](./10_relay.md).

TLS ends at a proxy in front of the server. `X-Forwarded-Proto` is believed only from loopback or a configured trusted proxy ([forwarded.ts](../../packages/schema/src/forwarded.ts)). The result is recorded per device so the app can warn about a plain connection. It does not gate access.

Paired devices persist in `<home>/devices.json`. Codes, tickets and spent nonces live in memory. A restart forgets pending codes. A proof used just before a restart is good once more after it.

## Finding the Server

A server advertises itself in `<home>/service.json` ([registration.ts](../../packages/codework/src/server/registration.ts)). The file is a hint, never proof. A caller reads the endpoint and the token, calls `server.info`, and believes the file only when the live pid matches ([discovery.ts](../../packages/codework/src/server/discovery.ts)). A file left by a crash, or a reused port, must not pass for a live server. [health.ts](../../packages/codework/src/server/health.ts) turns every failure into "no", so callers never wrap it in a catch.

One home has one discoverable server. A running server re-checks the file on an interval. If the file names another server, this one has lost discovery and shuts itself down rather than run where nothing can find or stop it.

The CLI sends the home's token only to the server `service.json` names ([service.ts](../../packages/codework/src/cli/service.ts)). A `--server` URL must be that server or a loopback alias of it. Any other server, however local it looks, may belong to someone else. So the CLI only ever reaches its own home's server. Other machines are reached by the desktop app server, as a paired device.

## `serve` and `service`

`codework serve` runs in the foreground. `codework service start` finds a live server for the home or spawns a detached `serve --service` that logs to `<home>/log/server.log`. It is a plain detached process; nothing registers it with the OS. When two callers race, only the one that binds the port registers, and both adopt the winner. A contender that does not win is stopped, so no unmanaged server is left behind. `start` replaces a live server only when it runs a different build; `restart` always replaces it.

## In-Process and `--server`

The CLI runs the harness in-process when there is no `--server`, and that mode stays supported. Both modes use the same home and database, so `run` and `serve` must build the harness from the same options ([harness.ts](../../packages/codework/src/cli/harness.ts)). A session made by one must be readable by the other. With `--server`, flags that configure the harness (`--database`, `--user-config-dir`) belong on `serve` and are refused on the client.

Threads are shared, so the event stream a CLI client reads carries other clients' work too. [client.ts](../../packages/codework/src/server/client.ts) attributes every terminal event to its own prompt before believing it.

Logins run in the CLI, because a browser callback or a device code cannot travel over RPC. The CLI sends the resulting credentials to the server, which only stores, refreshes and clears them ([oauth.ts](../../packages/codework/src/server/oauth.ts)).

## Two Ways to Keep Up

`event.subscribe` is the live feed ([feed.ts](../../packages/codework/src/server/feed.ts)). Each event is encoded once and shared by every subscriber. Each subscriber has a bounded queue, and its filter runs before an event takes a place in it. A client that falls behind fails alone with an overflow. An event that cannot be encoded is a server bug and disconnects every subscriber. Types outside the registry are dropped before they reach any queue. The feed replays no durable history. With `types`, it first sends the last event of each type a space daemon published. Those are kept in the store's `space_state`, so a client that connects after a restart still sees each space's git status and skills before the space mounts again, and a stopped sandbox is never woken to read them.

The `server.connected` frame is a readiness barrier. It is sent only after the subscriber is registered, so a prompt sent after it cannot land in a gap.

Durable catch-up goes through the sync RPCs (`index.sync`, `thread.sync`, `usage.sync`, `session.log`). They read store revisions from a cursor, then follow new commits ([rows.ts](../../packages/codework/src/server/rows.ts)). They never drop rows for a slow client. A client that resumes against a different store, such as a restored backup, is told to read from zero. Text deltas are never stored, so they arrive only live.

## Shutdown

The order is fixed in [server.ts](../../packages/codework/src/server/server.ts). Before the listener opens, every execution the last process left open gets a durable interrupt, so a client never sees a dead execution as live. The runs it cut off then resume in the background. On shutdown, active runs are interrupted with reason `shutdown`, then managed sandboxes are stopped. External sandboxes are left running. Both steps are bounded so a provider cannot hold the process open. A stop that is cut short is persisted as faulted and recovers on the next mount. The registration is removed after that, and only if it still names this server.

## ACP

`codework acp` ([acp](../../packages/codework/src/acp)) serves the Agent Client Protocol on stdio for editors. It is a best-effort add-on, not a surface. It always runs its own harness in-process and never talks to an RPC server. Its shutdown mirrors the server's: when the editor disconnects, active runs are interrupted and managed sandboxes stopped. stdout carries the protocol, so logs go to stderr.
