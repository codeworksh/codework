# Contract

The app server's RPC contract, shared by the app server ([`apps/server`](../server)) and the UI ([`apps/web`](../web)). One file, [`src/contract.ts`](./src/contract.ts), exported as `Contract`: the schemas, errors and the `Contract.Api` RPC group.

## Boundaries

- This is the desktop app's own protocol, not the harness protocol. The UI speaks only this; the app server translates to CodeWork RPC servers through the mirror in [`@codeworksh/widget/codework`](../widget/src/codework.ts).
- It holds desktop-only shapes too, such as thread status and grouping for issue tracking, which never reach the harness.
- It depends only on `effect`, `@codeworksh/schema` and `@codeworksh/widget`, and builds on the widget SDK's event and mirror schemas rather than redefining them.

A change here is a change to both sides: update the handler in [`apps/server/src/handlers.ts`](../server/src/handlers.ts) and the callers in `apps/web` together.

## Code Map

- [`src/contract.ts`](./src/contract.ts): every schema and the `Api` group.

## Working Locally

`vp run typecheck` here checks the contract alone. See [desktop internals](../../docs/internals/11_desktop.md) for how the app server and UI use it.
