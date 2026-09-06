# @codeworksh/cli

Command-line interface for the CodeWork coding agent.

## Installation

```bash
pnpm add -g @codeworksh/cli
# or run directly
pnpm dlx @codeworksh/cli <command>
```

---

## Commands

### `codework run`

Run an agent session with a prompt.

```bash
# Start a new session
codework run "Inspect and fix the failing tests"

# Create a session with explicit provider and model
codework run --provider openai --model gpt-5.5 --thinking high "Plan database migration"

# Continue an existing session
codework run --session ses_01a070f0 "Now implement the migration script"

# Run in an isolated sandbox (local, daytona, vercel, memory, sqldb)
codework run --sandbox daytona "Inspect repository"
codework run --sandbox daytona --sandbox-provider-id <remote-id> "Continue in sandbox"
```

#### Flags:

- `-s, --session <id>` — Continue an existing session ID.
- `-C, --cwd <path>` — Working directory for a new session.
- `--sandbox <driver>` — Sandbox driver (`local`, `daytona`, `vercel`, `memory`, `sqldb`). Default: `local`.
- `--sandbox-provider-id <id>` — Provider ID of an existing remote sandbox.
- `--provider <id>` — Model catalog provider ID.
- `--model <id>` — Model ID.
- `--thinking <level>` — Thinking/reasoning level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

---

### `codework models`

Inspect and discover models and providers from the model catalog.

```bash
# List all models across all providers
codework models

# List models for a specific provider
codework models openai
codework models anthropic
codework models openrouter

# List all supported provider IDs
codework models provider
```

---

### `codework models generate`

Generate or update the `models.gen.json` catalog from model registries.

```bash
# Generate to CODEWORK_MODELS_FILE or ./models.gen.json
codework models generate

# Generate into a specific directory (resolves to ./models.gen.json)
codework models generate .

# Generate to an explicit file path
codework models generate ./path/to/custom-models.json
```

---

## Environment Variables

| Variable                       | Description                                          |
| :----------------------------- | :--------------------------------------------------- |
| `CODEWORK_MODELS_FILE`         | Path to the generated `models.gen.json` catalog file |
| `OPENAI_API_KEY`               | API key for OpenAI models                            |
| `ANTHROPIC_API_KEY`            | API key for Anthropic models                         |
| `OPENROUTER_API_KEY`           | API key for OpenRouter models                        |
| `GOOGLE_GENERATIVE_AI_API_KEY` | API key for Google models                            |
| `XAI_API_KEY`                  | API key for xAI models                               |

---

## License

MIT
