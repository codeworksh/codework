# Widget

The SDK for CodeWork desktop widgets. A widget has two halves: a view, a React component in the UI, and an optional backend, an Effect program that runs inside the app server. They talk over the event bus. Built-in widgets in [`apps/web/src/widgets`](../web/src/widgets) use it, and third-party widgets will too.

> [!NOTE]
> [`src/codework.ts`](./src/codework.ts) is a hand-kept mirror of the CodeWork RPC server's contract, whose source of truth is [`packages/codework/src/server/contract.ts`](../../packages/codework/src/server/contract.ts) (with `part.ts` and `envelope.ts` beside it). A contract change lands in both, or the app server fails to decode replies and reports `CodeworkUnavailable`.

## Entry Points

| Import                        | What it is                                                          |
| ----------------------------- | ------------------------------------------------------------------- |
| `@codeworksh/widget/view`     | `defineWidget`, the shell and frame contexts, `useBus`, `useKv`     |
| `@codeworksh/widget/backend`  | `defineBackend` and the `Bus`, `Kv`, `Codework` and `Sync` services |
| `@codeworksh/widget/event`    | the event log's wire schemas, shared by both halves                 |
| `@codeworksh/widget/codework` | the mirrored CodeWork RPC contract                                  |

## Boundaries

- Topics are `<package>/<name>`, and a widget publishes only under its own package. A backend that tries another package dies, because that is a bug.
- A backend reaches CodeWork through the `Codework` service, the app's one long-lived connection, rather than its own socket. `run` is given only `Bus`, `Kv`, `Codework` and `Sync`.
- `react`, `effect` and `@phosphor-icons/react` are peer dependencies, so a widget shares the app's copies.

## Code Map

- [`src/view.ts`](./src/view.ts), [`src/view`](./src/view): the view half.
- [`src/backend.ts`](./src/backend.ts): the backend half.
- [`src/event.ts`](./src/event.ts): the event contract.
- [`src/codework.ts`](./src/codework.ts): the CodeWork RPC mirror.

See [desktop internals](../../docs/internals/11_desktop.md#widgets-and-the-bus) for how the app server runs backends and the bus replays events.
