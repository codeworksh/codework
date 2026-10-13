# codework-tui

A fast and lightweight terminal interface for [CodeWork](https://www.codework.sh), written in **Rust**.

The TUI is an early skeleton. Today it opens one screen that welcomes you to CodeWork.
Prompt entry, model selection and the session view are not built yet; the launcher and the
RPC transport they will need are already in place.

---

## Architecture

The TUI is a thin client. It draws the screen and reads keystrokes, and a CodeWork server
owns the agent, the tools and the model calls. The two talk over a WebSocket carrying
newline-delimited JSON-RPC.

| Path           | Role                                                                |
| :------------- | :------------------------------------------------------------------ |
| `src/main.rs`  | Terminal setup and the event loop.                                  |
| `src/app.rs`   | The UI state (today: whether the user asked to quit).               |
| `src/ui.rs`    | Rendering.                                                          |
| `src/rpc/`     | The transport: WebSocket client and wire protocol.                  |
| `src/types.rs` | The DTOs the transport speaks in.                                   |
| `src/index.ts` | Thin TypeScript launcher: resolves the platform binary for the CLI. |

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable version)
- Node.js and pnpm (to run the CodeWork CLI and background server)

### Running the App

`codework tui` is the normal way in: the CLI starts or reuses the background server
(registered in `<home>/service.json`) and launches this binary with `CODEWORK_RPC_SERVER`
set. From a checkout it picks up a `target/{release,debug}` build.

To run the binary directly, use Cargo:

```bash
# Run in development mode
cargo run

# Build and run an optimized release version
cargo build --release
./target/release/codework-tui
```

Or using pnpm:

```bash
# From packages/tui
pnpm start
```

---

## Keyboard Shortcuts

| Shortcut | Action       |
| :------- | :----------- |
| `Esc`    | Exit the app |
| `Ctrl+C` | Exit the app |

---

## Contributors

- **Prem** ([@prem315](https://github.com/prem315))
- **Sanchit** ([@sanchitrk](https://github.com/sanchitrk))

---

## License

MIT © [CodeWork](https://codework.sh)
