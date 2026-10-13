# codework-tui

A fast and lightweight terminal interface for [CodeWork](https://www.codework.sh), written in **Rust**.

The TUI is an early skeleton. Today it opens one screen: the landing site's hero, its wordmark over
the same hairline lattice the site draws it on. Prompt entry, model selection and the session view
are not built yet; the launcher and the RPC transport they will need are already in place.

---

## Architecture

The TUI is a thin client. It draws the screen and reads keystrokes, and a CodeWork server
owns the agent, the tools and the model calls. The two talk over a WebSocket carrying
newline-delimited JSON-RPC.

| Path                 | Role                                                                  |
| :------------------- | :-------------------------------------------------------------------- |
| `src/main.rs`        | Wiring: build the app, terminal and event loop, then run them.        |
| `src/tui.rs`         | Terminal lifecycle: raw mode, alternate screen, input modes, restore. |
| `src/event.rs`       | Input: the reader thread, and the app events it produces.             |
| `src/action.rs`      | Named actions and the keymap, with the `<leader>` prefix.             |
| `src/app.rs`         | UI state and `update`, the one place state changes.                   |
| `src/ui.rs`          | Rendering: reads state and draws, nothing else.                       |
| `src/ui/glyphs.rs`   | Pixel glyphs, generated from the landing site's wordmark.             |
| `src/ui/wordmark.rs` | Drawing the wordmark, and the mark it falls back to, in half-blocks.  |
| `src/ui/field.rs`    | The lattice behind the wordmark, on the wordmark's own grid.          |
| `src/theme.rs`       | The palette, generated from the landing site's themes.                |
| `src/rpc/`           | The transport: WebSocket client and wire protocol.                    |
| `src/types.rs`       | The DTOs the transport speaks in.                                     |
| `src/index.ts`       | Thin TypeScript launcher: resolves the platform binary for the CLI.   |

Two files are generated from the landing site instead of written by hand: `src/theme/palettes.rs`
from its theme tokens — including the lattice ink its canvas derives from two of them — and
`src/ui/glyphs.rs` from its pixel wordmark. Run `node scripts/themes.mjs` or
`node scripts/wordmark.mjs` after the site moves; each takes `--check` and fails on drift.

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

| Shortcut    | Action                            |
| :---------- | :-------------------------------- |
| `Esc`       | Exit the app                      |
| `Ctrl+C`    | Exit the app                      |
| `Ctrl+D`    | Exit the app                      |
| `<leader>q` | Exit the app (`Ctrl+X`, then `q`) |

---

## Contributors

- **Prem** ([@prem315](https://github.com/prem315))
- **Sanchit** ([@sanchitrk](https://github.com/sanchitrk))

---

## License

MIT © [CodeWork](https://codework.sh)
