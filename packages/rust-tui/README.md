# codework-tui

High-performance Terminal User Interface (TUI) for [CodeWork](https://www.codework.sh), written in **Rust** using [Ratatui](https://ratatui.rs) and [Crossterm](https://github.com/crossterm-rs/crossterm).

`codework-tui` provides a blazing-fast, zero-overhead terminal chat experience for interacting with the CodeWork coding agent. It connects to the CodeWork background RPC server via WebSockets to stream reasoning tokens, active tool executions, and file diffs in real time with a custom terminal Markdown engine and live telemetry.

---

## Highlights

- **Native Rust Performance** — Instant startup, minimal memory footprint, and fluid rendering via an asynchronous event loop and dedicated OS thread for input handling.
- **Real-Time Streaming** — Live token streaming, collapsible/expandable thinking blocks (`● Thinking ▌`), and animated tool execution indicators (`⚙ running <tool>`, `✓ completed <tool>`).
- **Split-Pane Session View** —
  - **Conversation Panel**: Turn-by-turn prompts, streamed assistant responses, tool execution results, and execution speed metrics (`tok/s`).
  - **Persistent Telemetry Sidebar**: Active model & provider badges, context window capacity gauge (`[████░░░░░░] 42%`), token usage breakdown (input, output, reasoning, cache), total session cost, and Git repository location & branch.
- **Interactive Model Browser (`/model`)** — A full 3-column browser to explore providers and models, inspect context windows and pricing, enter API keys with in-terminal modals, and verify credentials against provider endpoints before persisting.
- **Custom Terminal Markdown Engine** — Native rendering for fenced code blocks, inline styling (bold, italic, inline code, links), bullet/numbered lists, blockquotes, and Unicode formatted tables with automatic text wrapping.
- **Auto-Managed RPC Server** — Connects to `ws://127.0.0.1:7433/rpc`. Automatically detects if `codework serve` is running and spawns the background daemon if needed.
- **Safe Turn Interruption** — Press `Esc` or `Ctrl+C` while the agent is streaming or running tools to interrupt the turn via RPC without quitting the application or losing context.
- **Catppuccin Mocha Aesthetics** — Custom theme featuring a dark slate palette (`#1E1E2E` base, `#252538` elevated surfaces, lavender `#B4BEFE` accents, and pastel status indicators).
- **Crash-Resilient Terminal Lifecycle** — Custom panic hooks ensure the terminal's alternate screen buffer, raw mode, bracketed paste, and background colors are safely restored under all exit conditions.

---

## Architecture Overview

```text
rust-tui/
├── Cargo.toml            # Rust dependencies (ratatui 0.29, crossterm 0.28, tokio 1, tokio-tungstenite)
├── package.json          # Monorepo integration scripts
└── src/
    ├── main.rs           # Entry point, terminal raw mode, dedicated stdin event thread, tick loop
    ├── app.rs            # Application state machine (Welcome, ModelFlow, Session screens)
    ├── catalog.rs        # Model catalog loading, search filtering, pricing, and live API key validation
    ├── config.rs         # Persistent settings manager (~/.codework/config.json)
    ├── credentials.rs    # Owner-only credential vault (~/.codework/credentials.json, 0o600 permissions)
    ├── git.rs            # Git repository name and active branch discovery
    ├── types.rs          # Core domain models (ConversationTurn, ModelConfig, SessionStats, etc.)
    ├── markdown/         # Custom terminal Markdown rendering engine
    │   ├── block.rs      # Code blocks, headers, blockquotes, lists, and word wrapping
    │   ├── inline.rs     # Inline styling (bold, italic, inline code, links)
    │   └── table.rs      # Markdown table formatting with Unicode borders
    ├── rpc/              # WebSocket RPC client and protocol bindings
    │   ├── client.rs     # WebSocket connection, automatic server spawn, event stream channel
    │   └── protocol.rs   # JSON-RPC request/response/chunk envelopes
    └── ui/               # Ratatui UI components & layouts
        ├── input.rs      # Multi-line text input with cursor positioning and word wrap
        ├── logo.rs       # Animated ASCII CodeWork banner with gradient sparkles
        ├── model.rs      # Multi-column model and provider catalog browser
        ├── session.rs    # Split-pane conversation transcript and telemetry sidebar
        ├── spinner.rs    # Terminal spinner and cursor blink animations
        ├── theme.rs      # Catppuccin Mocha-inspired color palette
        └── welcome.rs    # Hero screen with command suggestions and quick actions
```

---

## Installation & Running

### Prerequisites

- [Rust](https://rustup.rs/) (edition 2021 / latest stable)
- Node.js 24.14.1+ and pnpm (to run the CodeWork CLI and RPC backend)

### Running from Cargo

```bash
# Debug run
cargo run

# Optimized release build
cargo build --release
./target/release/codework-tui
```

### Running from the Monorepo

```bash
# From packages/rust-tui
pnpm start

# Or from workspace root
pnpm --filter @codeworksh/rust-tui start
```

---

## Slash Commands

Type `/` in any prompt input field to activate the command popup:

| Command | Description |
| :--- | :--- |
| `/help` | Show available commands and keyboard shortcuts |
| `/model` | Open the interactive model catalog and credential manager |
| `/session` | View, switch, or resume recent agent sessions |
| `/compact` | Compact current conversation history to reduce context usage |
| `/clear` | Clear the current conversation transcript and reset the view |
| `/exit` | Exit the CodeWork TUI |

---

## Keyboard Shortcuts

### General & Global

| Shortcut | Action |
| :--- | :--- |
| `Ctrl+C` | Cancel current prompt / interrupt agent stream / exit app (when idle) |
| `Esc` | Close popup, cancel current action, or interrupt streaming turn |

### Session & Conversation Screen

| Shortcut | Action |
| :--- | :--- |
| `Enter` | Send prompt to agent / execute command |
| `PageUp` / `PageDown` | Scroll conversation transcript by full page |
| `Ctrl+U` / `Ctrl+D` | Scroll transcript by half page |
| `Home` / `End` | Jump to top / bottom of conversation transcript |
| `Up` / `Down` | Navigate command dropdown (or scroll lines when prompt is empty) |

### Model Browser (`/model`)

| Shortcut | Action |
| :--- | :--- |
| `Tab` / `BackTab` | Switch focus between Providers, Models, and Details panels |
| `Up` / `Down` / `j` / `k` | Navigate items in the active list |
| `/` | Start searching models or providers |
| `s` | Cycle sorting mode (by ID, Name, Context Window, Cost) |
| `c` / `y` | Copy selected Model ID to system clipboard |
| `o` | Open provider website in default web browser |
| `Enter` | Select active model (opens API key prompt if not configured) |

---

## Configuration & Credentials

All user state and secrets are stored inside `~/.codework` (or `$CODEWORK_HOME`):

- **`~/.codework/config.json`** — Selected active model and provider:
  ```json
  {
    "provider": "anthropic",
    "model": "claude-3-7-sonnet-latest"
  }
  ```
- **`~/.codework/credentials.json`** — Securely stored API keys (written with `0o600` owner-only POSIX permissions):
  ```json
  {
    "anthropic": "sk-ant-...",
    "openai": "sk-..."
  }
  ```

API keys can also be supplied through standard environment variables:
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
- `OPENROUTER_API_KEY`
- `GROQ_API_KEY`

---

## Contributors

- **Prem** ([@prem315](https://github.com/prem315))
- **Sanchit** ([@sanchitrk](https://github.com/sanchitrk))

---

## License

MIT © [CodeWork](https://codework.sh)
