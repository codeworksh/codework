# Web

The desktop app's UI: React, TanStack Router and Tailwind, rendered inside Electron. It shows what the app server mirrors from CodeWork RPC servers and sends commands back through it.

## Boundaries

- It reaches CodeWork state only through the app server, over [`@codeworksh/contract`](../contract). It never speaks the harness protocol, so one connection carries every machine.
- Account and workspace calls are the exception: they go straight to Relay over HTTP.
- Electron hands it the app server's URL and token through `window.desktopBridge`. A plain browser has no bridge, so its calls fail and widgets say so.
- It also exports the built-in widget backends as `@codeworksh/web/backends`, which the app server runs.

## Code Map

- [`src/main.tsx`](./src/main.tsx): entry, router and auth providers.
- [`src/routes`](./src/routes): file-based routes.
- [`src/kernel/rpc.ts`](./src/kernel/rpc.ts): the app server's RPC client as atoms.
- [`src/kernel/host.ts`](./src/kernel/host.ts): the bus and kv that widget views see.
- [`src/kernel/relay.ts`](./src/kernel/relay.ts): Relay calls for accounts and workspaces.
- [`src/kernel/keep.ts`](./src/kernel/keep.ts): reuses unchanged items between reads, so memoized rows skip rendering.
- [`src/shell`](./src/shell): the app frame, title bar, palette and switcher.
- [`src/wm`](./src/wm): the window manager for widget instances and tabs.
- [`src/widgets`](./src/widgets): built-in widgets (threads, session, changes) and [`backends.ts`](./src/widgets/backends.ts).
- [`src/settings`](./src/settings): settings pages, machines included.
- [`src/components`](./src/components): shared components; `ui` holds the shadcn primitives.

## Working Locally

Run it inside the app with `vp run dev:desktop` from the root; UI changes hot-reload. Vite listens on the fixed `127.0.0.1:5173`, so one checkout runs the desktop app at a time. See [development](../../docs/operations/00_development.md), and [desktop internals](../../docs/internals/11_desktop.md) for the bus, the window manager and UI performance.
