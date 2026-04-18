# Session: Desktop Shell + Web UI Split

## Summary

This session established the new desktop app foundation as:

- `packages/desktop`: Electron main process + preload only
- `packages/webui`: React renderer app

The old inline renderer owned by `packages/desktop` was removed. The desktop app now loads the built web UI in production and the web UI dev server in development.

## What Changed

### 1. Created `packages/webui`

Added a new React app in `packages/webui` with:

- Vite
- TanStack Router file-based routing
- React 19

Current key files:

- [packages/webui/package.json](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/package.json)
- [packages/webui/vite.config.ts](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/vite.config.ts)
- [packages/webui/src/main.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/main.tsx)
- [packages/webui/src/router.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/router.tsx)
- [packages/webui/src/routes/__root.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/routes/__root.tsx)
- [packages/webui/src/routes/index.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/routes/index.tsx)
- [packages/webui/src/routes/concepts.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/routes/concepts.tsx)

### 2. Simplified `packages/desktop`

`packages/desktop` now only owns:

- Electron window creation
- preload bridge
- dev/build/start helper scripts

Current key files:

- [packages/desktop/src/main.ts](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/src/main.ts)
- [packages/desktop/src/preload.ts](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/src/preload.ts)
- [packages/desktop/scripts/dev.mjs](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/scripts/dev.mjs)
- [packages/desktop/scripts/reload.mjs](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/scripts/reload.mjs)
- [packages/desktop/scripts/start.mjs](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/scripts/start.mjs)
- [packages/desktop/scripts/smoke.mjs](/Users/sanchitrk/Developer/codeworksh/codework/packages/desktop/scripts/smoke.mjs)

Deleted from `packages/desktop`:

- old renderer source files under `src/renderer`
- old `index.html`
- old `vite.renderer.config.ts`

### 3. Connected desktop to webui

Development flow:

- `packages/webui` runs a Vite dev server
- Electron loads `VITE_DEV_SERVER_URL`

Production flow:

- `packages/webui` builds into `packages/desktop/dist/renderer`
- Electron loads `dist/renderer/index.html`

### 4. Added a minimal preload bridge

The renderer currently reads app info through preload:

- channel: `desktop:get-app-info`
- exposed on `window.desktop.getAppInfo()`

This is the first small boundary between renderer and Electron and should be extended instead of leaking Electron APIs directly into React.

## Routing Setup

The web UI uses TanStack Router with file routes.

Important detail:

- browser: `createBrowserHistory()`
- Electron: `createHashHistory()`

This is implemented in [packages/webui/src/main.tsx](/Users/sanchitrk/Developer/codeworksh/codework/packages/webui/src/main.tsx).

## Commands

Install:

```bash
pnpm install
```

Run desktop dev:

```bash
pnpm --filter @codeworksh/desktop dev
```

Build desktop:

```bash
pnpm --filter @codeworksh/desktop build
```

Smoke test:

```bash
pnpm --filter @codeworksh/desktop test:smoke
```

Check web UI types:

```bash
pnpm --filter @codeworksh/webui check
```

## Cleanup Done

Structural cleanup completed in this session:

- removed old desktop-owned renderer files
- removed the empty `packages/desktop/src/renderer` directory
- removed unused `@base-ui/react` from `packages/webui`
- ignored `.tanstack` scratch output in `.gitignore`

## Current State

The project now has a clean baseline for the desktop app:

- Electron shell is separate from the renderer
- renderer is a standalone React app
- preload is the only renderer bridge
- no `Effect` usage was introduced

## Recommended Next Step

Next session should focus on the first real app backend boundary:

1. Decide how the local app server will be started from Electron main.
2. Define the minimal preload API needed for server bootstrap/auth status.
3. Add a renderer-side environment/bootstrap module that consumes only preload APIs.
4. Keep server process management in `packages/desktop`, not in `packages/webui`.

## Notes For Next Session

- Keep `CodeWork` as the app name.
- Keep `test:smoke` as the smoke script name.
- Do not move Electron logic into the renderer.
- Prefer extending preload APIs deliberately as the app/server contract evolves.
