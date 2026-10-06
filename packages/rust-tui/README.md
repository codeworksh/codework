# codework-tui

A fast and lightweight terminal interface for [CodeWork](https://www.codework.sh), written in **Rust**.

`codework-tui` lets you chat with your AI coding agent directly from your terminal. Watch it write code, run tools, and edit files in real time, all while keeping track of token usage and costs.

---

## Features

- **Fast and Lightweight** — Starts up instantly and uses minimal memory.
- **Live Streaming** — Watch the AI think, stream answers, and run tools (like running terminal commands or editing files) as it happens.
- **Side-by-Side View** — 
  - **Chat screen:** See your conversation, AI replies, tool results, and response speed (`tok/s`).
  - **Sidebar:** Keep an eye on your current model, context window usage, tokens used, cost, and active Git branch.
- **Easy Model Picker (`/model`)** — Browse models (Anthropic, OpenAI, Google, OpenRouter, Groq), check pricing, and enter API keys directly in the terminal.
- **Neat Markdown Formatting** — Code blocks, lists, bold text, links, and tables look clean and readable in the terminal.
- **Cancel Anytime** — Press `Esc` or `Ctrl+C` while the AI is responding to safely stop it without losing your conversation or quitting the app.
- **Auto-Connect** — Automatically connects to the CodeWork background server, starting it for you if it isn't running yet.

---

## Getting Started

### Prerequisites

- [Rust](https://rustup.rs/) (latest stable version)
- Node.js and pnpm (to run the CodeWork CLI and background server)

### Running the App

You can run the app directly using Cargo:

```bash
# Run in development mode
cargo run

# Build and run an optimized release version
cargo build --release
./target/release/codework-tui
```

Or using pnpm:

```bash
# From packages/rust-tui
pnpm start

# Or from the project root
pnpm --filter @codeworksh/rust-tui start
```

---

## Commands

Type `/` in the prompt input to open the command menu:

| Command | What it does |
| :--- | :--- |
| `/help` | Show available commands and shortcuts |
| `/model` | Pick an AI model or enter API keys |
| `/session` | View, switch, or resume past sessions |
| `/compact` | Shorten conversation history to save tokens |
| `/clear` | Clear the current chat screen |
| `/exit` | Exit the app |

---

## Keyboard Shortcuts

### General & Chat

| Shortcut | Action |
| :--- | :--- |
| `Enter` | Send message / run command |
| `Esc` | Close popup, cancel current action, or stop the AI |
| `Ctrl+C` | Stop the AI response / exit app when idle |
| `PageUp` / `PageDown` | Scroll chat up or down by a full page |
| `Ctrl+U` / `Ctrl+D` | Scroll chat up or down by half a page |
| `Home` / `End` | Jump to the very top or bottom of the chat |
| `Up` / `Down` | Move through slash commands (or scroll lines when input is empty) |

### Model Picker (`/model`)

| Shortcut | Action |
| :--- | :--- |
| `Tab` / `Shift+Tab` | Move between Providers, Models, and Details columns |
| `Up` / `Down` (or `j` / `k`) | Move through the list |
| `/` | Search models or providers |
| `s` | Change sort order (by name, context size, cost) |
| `c` / `y` | Copy the selected model ID to clipboard |
| `o` | Open provider website in your browser |
| `Enter` | Select the model (asks for an API key if needed) |

---

## API Keys & Settings

You can provide API keys in two simple ways:

1. **Inside the app:** Type `/model`, choose a provider, and enter your API key when prompted.
2. **Environment variables:** Export the key in your terminal before running:
   ```bash
   export ANTHROPIC_API_KEY="your-key-here"
   export OPENAI_API_KEY="your-key-here"
   export GEMINI_API_KEY="your-key-here"
   export OPENROUTER_API_KEY="your-key-here"
   export GROQ_API_KEY="your-key-here"
   ```

Your configuration and keys are saved in your home folder:
- **`~/.codework/config.json`** — Your selected model and provider.
- **`~/.codework/credentials.json`** — Your securely stored API keys.

---

## Contributors

- **Prem** ([@prem315](https://github.com/prem315))
- **Sanchit** ([@sanchitrk](https://github.com/sanchitrk))

---

## License

MIT © [CodeWork](https://codework.sh)

