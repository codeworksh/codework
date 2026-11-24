# @codeworksh/schema

The wire schemas that more than one part of CodeWork speaks: Relay's HTTP API, signed machine requests, pairing, the server's WebSocket door and the machine status the desktop app reads. The CLI and RPC server (`packages/codework`), the app packages and Relay (`infra/relay`) all import it.

It is private and never published. Consumers bundle it, which is why `@codeworksh/cli` lists it as a dev dependency.

## Boundaries

- **Only `effect`.** This code runs in Node and in the desktop renderer, a browser, so it uses Effect and WebCrypto and nothing from Node. A Node import here would break the renderer.
- **Shapes, not services.** It declares what crosses the wire and the small helpers both ends need to agree on it (signing, token checks). Who stores what, and how a call is handled, stays in the consumer.
- **It sits outside the core.** `packages/harness` never imports it. The host and the apps do.
- **Fields are wire format.** Machines, desktop apps and Relay update at different times, so an older peer may be on the other end. Add a new field as optional rather than renaming or removing one.

## Code Map

- [`src/index.ts`](./src/index.ts) exports each module as a namespace.
- [`src/relay.ts`](./src/relay.ts) declares Relay's HTTP API (`Relay.Api`), its records, the signed request claims and its errors.
- [`src/jws.ts`](./src/jws.ts) signs and verifies compact Ed25519 JWS with WebCrypto, so a machine signs and Relay verifies with the same code.
- [`src/pairing.ts`](./src/pairing.ts) is how another computer pairs with a CodeWork server over HTTP.
- [`src/door.ts`](./src/door.ts) carries the WebSocket token as a subprotocol and checks it at the listener.
- [`src/forwarded.ts`](./src/forwarded.ts) decides whether a request reached the listener over TLS through a trusted proxy.
- [`src/machine.ts`](./src/machine.ts) is a server's machine status and connect events as its clients see them over RPC.

## Working Locally

```sh
pnpm typecheck   # tsc --noEmit
```

## Learn More

- [Relay](../../docs/internals/10_relay.md): the API, the signed machine requests and the keys behind them.
- [Server](../../docs/internals/09_server.md): the door, pairing and trusted proxies.
