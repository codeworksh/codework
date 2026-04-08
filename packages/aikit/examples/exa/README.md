# exa

Node.js example project for `@codeworksh/aikit` that uses `Agent.create(...)` with an Exa-backed search tool.

This example is intentionally not part of the repo workspace install.

## What it does

- Creates an `aikit` agent with a sales-research system prompt
- Exposes an `exa_search` tool backed by `exa-js`
- Runs an interactive shell with `node:readline`
- Lets the model decide when to search for people or companies

## Setup

From the example directory:

```bash
cd packages/aikit/examples/exa
pnpm install --ignore-workspace
cp .env.example .env
```

Set these environment variables in `.env`:

```env
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY
EXA_API_KEY=YOUR_EXA_API_KEY
AIKIT_MODEL=claude-haiku-4-5-20251001
```

## Run

```bash
pnpm dev
```

Then ask questions in the shell, for example:

```text
Find 5 AI healthcare companies in the US that look promising for outbound sales.
```

Type `exit` or `quit` to stop the session.
