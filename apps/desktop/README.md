# Desktop

The Electron app. Main hosts the window, serves the UI from [`apps/web`](../web) and starts the app server from [`apps/server`](../server) as a child process. It is a client: agents run on a CodeWork RPC server, never here.

## What It Owns

- **The window and its scheme.** Main serves the built UI from `codework://app` when packaged and `codeworkdev://app` from the repo, or proxies to a web dev server when `CODEWORK_WEB_URL` is set.
- **The app server's lifetime.** Main runs it with Electron's own binary and `ELECTRON_RUN_AS_NODE`, so no system Node is needed. If the app server exits, the app quits, and quitting waits for it to stop.
- **The bridge.** The renderer is sandboxed and sees only the narrow `desktopBridge` from the preload: the app server's URL and token, the home folder, a folder picker and reveal.
- **Channels.** Each channel (`latest`, `dev`, `canary`, and `local` from the repo) installs side by side with its own identity and data.

Main holds no CodeWork state and makes no RPC calls of its own. Everything the UI shows comes through the app server, so the app keeps one owner for app.db and one client of each host.

## Code Map

- [`src/main.ts`](./src/main.ts): app lifecycle, the custom scheme, the window and the single-instance lock.
- [`src/server.ts`](./src/server.ts): starts the app server and reads its ready line.
- [`src/preload.ts`](./src/preload.ts): the `desktopBridge` the renderer sees.
- [`src/ipc.ts`](./src/ipc.ts): IPC channel names shared by main and preload.
- [`src/manifest.ts`](./src/manifest.ts): the packaged manifest and the current channel.
- [`electron.config.ts`](./electron.config.ts): electron-builder config, one identity per channel.
- [`scripts/dev.mjs`](./scripts/dev.mjs): the dev loop behind `vp run dev:desktop`.
- [`scripts/package.mjs`](./scripts/package.mjs): builds the web app, the app server and this app, then packages them.

## Working Locally

From the repository root, with a dev home exported:

```sh
vp run dev:desktop
```

This starts the UI on Vite, watches the Electron and app server bundles, and opens Electron as **CodeWork Local**. To package a build, run this from `apps/desktop`:

```sh
vp run package <canary|dev|latest> [electron-builder args]   # e.g. latest --mac --arm64 --dir
```

See [development](../../docs/operations/00_development.md) for the dev home and run order, and [desktop internals](../../docs/internals/11_desktop.md) for processes, channels and data.
