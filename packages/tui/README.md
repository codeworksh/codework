# @codeworksh/tui

Terminal User Interface (TUI) for [CodeWork](https://www.codework.sh), built with [Ink](https://github.com/vadimdemedes/ink) and [React](https://react.dev/).

`@codeworksh/tui` delivers an interactive, terminal-native chat experience for coding agent sessions. It connects to the CodeWork WebSocket RPC server to stream agent reasoning, tool executions, and diffs with real-time stats and full Markdown rendering.

---

## Installation & Running

### Using the Binary

Run directly with `pnpm dlx` or install globally:

```bash
# Direct run
pnpm dlx @codeworksh/tui

# Global install
pnpm add -g @codeworksh/tui
codework-tui
```

### From the Monorepo

```bash
# From packages/tui
pnpm start

# Or from workspace root
pnpm --filter @codeworksh/tui start
```

---

## Features

- **Real-Time Streaming:** Streams agent token responses, thinking/reasoning blocks (`● Thinking ▌`), and active tool execution indicators (e.g. bash commands, file edits).
- **Split-Pane Session View:**
   - **Main Conversation Panel:** Displays turn-by-turn prompts, streamed assistant responses, active/completed tool badges (`✓ <tool>`), and execution telemetry (turn duration and `tok/s`).
   - **Persistent Sidebar:** Live session title, active model & provider badges, token counters, context window capacity percentage (with warning threshold >80%), total cost incurred, and current Git repository location & branch (`~/repo:branch`).
- **Rich Terminal Markdown:** Full terminal Markdown parsing (via `marked`) supporting syntax code blocks, blockquotes, inline styling (bold, italic, code, links), lists, and horizontal dividers.
- **RPC Daemon Integration:** Automatically connects to the local CodeWork WebSocket RPC server (`ws://127.0.0.1:7433/rpc`), spawning `codework serve` in the background if not already running.
- **Interactive Model & Credential Flow (`/model`):** Multi-step in-terminal wizard to search and select providers and models, enter API keys securely, and validate credentials live against provider endpoints before persisting.
- **Safe Turn Interruption:** Pressing `Esc` or `Ctrl+C` while the agent is generating or executing tools interrupts the active turn via RPC without terminating the session or exiting the application.
- **Smooth History Navigation & Scrolling:** Full page, half-page (Vim-style), line-by-line scrolling, and jump-to-top/bottom controls with a floating scroll notification banner.
- **Secure Credential Storage:** Saves secrets to `~/.codework/credentials.json` with strict POSIX permissions (`0o600`), separate from user settings (`~/.codework/config.json`).
- **Git Context Awareness:** Zero-overhead branch and root discovery directly from `.git/HEAD`.
- **Clean Terminal Lifecycle:** Alternate screen buffer with automatic terminal restoration on exit.

---

## Slash Commands

In the prompt input, type `/` to open the command dropdown:

| Command    | Description                                      |
| ---------- | ------------------------------------------------ |
| `/help`    | Show available commands and keyboard shortcuts   |
| `/model`   | Open the interactive provider and model selector |
| `/session` | List or resume recent sessions                   |
| `/compact` | Compact current conversation context             |
| `/clear`   | Clear conversation history and reset screen      |
| `/exit`    | Exit CodeWork TUI                                |

---

## Keyboard Shortcuts

### Navigation & Scrolling

| Shortcut                                            | Action                              |
| --------------------------------------------------- | ----------------------------------- |
| `PageUp` / `PageDown`                               | Scroll conversation by full page    |
| `Ctrl+U` / `Ctrl+D`                                 | Scroll up / down by half page (Vim) |
| `Home` / `End`                                      | Jump directly to top / bottom       |
| `Shift+Up` / `Shift+Down`                           | Scroll transcript line-by-line      |
| `Up` / `Down` _(with empty prompt and scrolled up)_ | Scroll transcript line-by-line      |

### Interaction & Execution

| Shortcut         | Action                                                         |
| ---------------- | -------------------------------------------------------------- |
| `Enter`          | Submit prompt, confirm menu item, or continue                  |
| `Esc` / `Ctrl+C` | Interrupt active streaming turn / cancel dialog / exit session |
| `Up` / `Down`    | Navigate slash command list or model selection items           |

---

## Model Selection Flow (`/model`)

The interactive model configuration wizard walks through:

1. **Provider Selection:** Choose from Google, OpenAI, Anthropic, OpenRouter, or Groq with instant search filtering.
2. **Model Selection:** Filter models by name, ID, or description.
3. **API Key Input:** Enter API key if not already discovered in environment variables or credential store.
4. **Live Verification:** Validates the key against the provider API before saving to ensure seamless agent runs.

---

## Configuration & Credentials

Configurations and credentials are saved under `~/.codework`:

- **`~/.codework/config.json`**: Current active model and provider selection.
- **`~/.codework/credentials.json`**: Provider API keys, written with owner-only access permissions (`0o600`).
- **Environment Variables:** API keys can also be supplied via standard environment variables:
   - `OPENAI_API_KEY`
   - `ANTHROPIC_API_KEY`
   - `GEMINI_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`
   - `OPENROUTER_API_KEY`
   - `GROQ_API_KEY`

---

## Supported Providers

- **Google** (Gemini 2.5 Pro, Flash, Gemma)
- **OpenAI** (GPT-4o, o1, o3-mini)
- **Anthropic** (Claude 3.7 Sonnet, Haiku, Opus)
- **OpenRouter** (Unified access to 300+ models)
- **Groq** (Ultra-low latency LPU models)

---

## Development

```bash
# Typecheck
pnpm typecheck

# Lint and check
pnpm check
pnpm lint

# Build package
pnpm build
```

---

## License

[MIT](../../LICENSE)
