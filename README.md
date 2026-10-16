# CODEWORK

<p align="center" dir="auto">
  <a href="https://codework.sh" rel="nofollow">
    <img src="./sites/www/public/brand/wordmark.svg" alt="CODEWORK" width="720" style="max-width: 100%;">
  </a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@codeworksh/cli"><img alt="npm" src="https://img.shields.io/npm/v/@codeworksh/cli?style=flat-square" /></a>
  <a href="https://deepwiki.com/codeworksh/codework"><img alt="Ask DeepWiki" src="https://img.shields.io/badge/Ask-DeepWiki-blue?style=flat-square" /></a>
</p>

An open-source coding agent for code & work: run sessions in your repo or an isolated sandbox, on any model, extended with plugins.

## Quick start

```bash
curl -fsSL https://codework.sh/install | sh
```

Or with Node.js 24+: `pnpm add -g @codeworksh/cli`.

### OpenAI:

```bash
export OPENAI_API_KEY=...
codework run --provider openai --model gpt-6-luna "Inspect and fix the failing tests"
```

### Anthropic:

```bash
export ANTHROPIC_API_KEY=...
codework run --provider anthropic --model claude-sonnet-5-5 "Inspect and fix the failing tests"
```

List every provider and model with `codework models`.

## Features

- **Any model** — OpenAI, Anthropic, Google, xAI, OpenRouter, and more via one catalog (`codework models`).
- **Subscription sign-in** — `codework auth login --openai-codex` or `--github-copilot`.
- **Persistent sessions** — resume any session by ID; state lives in a local database.
- **Sandboxes** — run locally or in `daytona`, `vercel`, `memory`, or `sqldb` sandboxes.
- **Server mode** — `codework serve` owns sessions and sandboxes; clients attach with `--server`.
- **Plugins** — `codework plugin add <pkg>` adds tools, prompts, and sandbox drivers, per project or globally (`-g`).

See the [docs](https://codework.sh/docs/) for every command and flag.

## Packages

| Package                                     | Description                                                          |
| ------------------------------------------- | -------------------------------------------------------------------- |
| [`@codeworksh/cli`](./packages/codework)    | The `codework` coding agent CLI.                                     |
| [`@codeworksh/harness`](./packages/harness) | Effect-powered agent runtime with persistent sessions and sandboxes. |
| [`@codeworksh/plugin`](./packages/plugin)   | SDK for tools, prompt plugins, and sandbox drivers.                  |
| [`@codeworksh/aikit`](./packages/aikit)     | Unified multi-provider LLM API with streaming, tools, and usage.     |

## Development

Requires Node.js 24.14.1+ and pnpm.

```bash
git clone https://github.com/codeworksh/codework.git
cd codework
pnpm install
pnpm cli -- --help            # run the CLI from source
pnpm exec vp check
pnpm exec vp run typecheck
```

Read [AGENTS.md](./AGENTS.md) for repository conventions, and [open an issue](https://github.com/codeworksh/codework/issues) for bugs or ideas.

## Acknowledgements

The curiosity to build this project was inspired by Mario Zechner’s work on [Pi-Mono](https://github.com/badlogic/pi-mono).

## License

[MIT](./LICENSE)
