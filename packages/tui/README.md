# codework-tui

A fast and lightweight terminal interface for [CodeWork](https://www.codework.sh), written in **Rust**.

The TUI connects to the CodeWork server to send prompts and follow conversations through
`thread.sync`. It supports a multiline composer, saved per-thread drafts, a live thread browser,
model and thinking selection, queued prompt management,
collapsible work logs, conversation forks, clipboard copying, and older history on demand.

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
| `src/prompt.rs`      | The prompt line's text and caret, and the keys that edit it.          |
| `src/menu.rs`        | A menu: its entries, its previews and where the cursor is.            |
| `src/ui.rs`          | Rendering: reads state and draws, nothing else.                       |
| `src/ui/glyphs.rs`   | Pixel glyphs, generated from the landing site's wordmark.             |
| `src/ui/wordmark.rs` | Drawing the wordmark, and the mark it falls back to, in half-blocks.  |
| `src/ui/field.rs`    | The lattice behind the wordmark, on the wordmark's own grid.          |
| `src/ui/input.rs`    | The prompt box and its line, which reports where the caret goes.      |
| `src/ui/menu.rs`     | Drawing a menu: its rows, its scrolling and what a row previews.      |
| `src/ui/badge.rs`    | The tag a box clips to its top border.                                |
| `src/ui/text.rs`     | Measuring and cutting text by columns, which both of the above need.  |
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

| Shortcut | Action |
| --- | --- |
| `Enter` | Send, or steer a running thread |
| `Shift+Enter` / `Ctrl+J` | Insert a newline; pasted code keeps its indentation |
| `↑` / `↓` while typing | Move between composer lines |
| `Home` / `End` | Move to the start/end of the current line |
| `Ctrl+Home` / `Ctrl+End` | Move to the start/end of the whole draft |
| `Ctrl+P` / `/session` | Open the live thread browser; Ctrl+P preserves the current draft |
| `Alt+Enter` | Queue a follow-up |
| `Shift+↑` / `Shift+↓`, mouse wheel, `PageUp` / `PageDown` | Scroll; fetch older history at the top (plain arrows also scroll when the composer is empty) |
| `/queue`, `Alt+↑` / `Alt+↓` | Focus and navigate queued prompts above the composer |
| `l` / `Enter` in queue | Switch steer/follow-up lane, or Send Now when parked/idle |
| `e` in queue | Edit in place; Enter saves, Escape cancels |
| `w` in queue | Cancel and prepend to the composer when cancellation succeeds, preserving the existing draft |
| `Delete` / `d` in queue | Cancel without restoring |
| `Ctrl+O` | Toggle the focused turn's work log, or the latest turn |
| `Ctrl+↑` / `Ctrl+↓` | Focus a turn; Space or Enter toggles its work log |
| `/fork` | Pick a committed message; Enter forks after it, `b` forks before a user message and restores its text |
| `/copy`, `Ctrl+Y` | Copy the selected or last assistant answer via OSC 52 |
| `/model`, `/thinking`, `/session`, `/theme` | Open the corresponding picker (`/session` lists threads) |
| `/new`, `/reload` | Start a new session or reload plugins |
| `Esc` | Close editing/focus/menu, interrupt a running thread, clear the composer, or exit |
| `Ctrl+C`, `Ctrl+D`, `Ctrl+X` then `q` | Exit |

The composer grows to six visible text rows and scrolls to keep the caret visible. Drafts
are saved after 400 ms of inactivity and when switching threads or exiting. They live in
`<CodeWork home>/tui/drafts/`, separated by server endpoint and thread; the default home is
`~/.codework` and can be changed with `CODEWORK_HOME_DIR`. Empty drafts are removed.
Scroll position and work-log choices are remembered while this TUI stays open.

The browser groups threads by project and session, with main/fork/subagent labels and
idle/starting/running/parked states. It watches `index.sync` and refreshes `thread.list`
without losing the current filter or selection. Closing it stops the subscription.

OSC 52 sends clipboard content through the terminal, including over SSH. Clipboard access
must be enabled in the terminal (and forwarded by any terminal multiplexer).

## Verification

```bash
cd packages/tui
cargo test
cargo clippy --all-targets -- -D warnings
```

The terminal integration test launches the real binary in a Python 3 standard-library PTY
against a deterministic local WebSocket peer; it does not need provider credentials.
The restart test also launches the binary twice, checks a live browser update, and verifies
that multiline text survives switching threads, restarting, and sending. Its artifact is
`__artifacts__/composer.json`.
The suite records the queue, fork, and paging RPCs in `__artifacts__/terminal.json` and checks
rendered conversation output in `__artifacts__/conversation.txt`. Regenerate intentional
changes with `UPDATE_ARTIFACTS=1 cargo test`, then rerun `cargo test` without that variable.

---

## Contributors

- **Prem** ([@prem315](https://github.com/prem315))
- **Sanchit** ([@sanchitrk](https://github.com/sanchitrk))

---

## License

MIT © [CodeWork](https://codework.sh)
