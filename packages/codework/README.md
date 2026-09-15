# @codeworksh/cli

Run coding-agent sessions in your repo or a sandbox.

## Installation

```bash
pnpm add -g @codeworksh/cli
# or run directly
pnpm dlx @codeworksh/cli <command>
```

After install, every command is `codework <command>`.

## Development

From `packages/codework`, or `pnpm cli` at the repo root:

```bash
pnpm start -- --help
pnpm start -- models
pnpm start -- run "Inspect the failing tests"
```

`start` runs `src/index.ts` with `--conditions=development` so workspace packages resolve to source. The published `codework` binary is the packed `dist` build.

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

- `--server <url>` — Connect to a running RPC server, e.g. `ws://127.0.0.1:7433/rpc`.
- `-s, --session <id>` — Continue an existing session.
- `-C, --cwd <path>` — Working directory for a new session.
- `--sandbox <driver>` — Sandbox driver (`local`, `daytona`, `vercel`, `memory`, `sqldb`). Default: `local`.
- `--sandbox-id <id>` — Reuse an existing sandbox instance; mutually exclusive with driver/provider coordinates.
- `--sandbox-provider-id <id>` — Provider ID of an existing remote sandbox.
- `--provider <id>` — Model catalog provider ID.
- `--model <id>` — Model ID.
- `--thinking <level>` — Reasoning effort the model uses before answering (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).

Global flags: `--user-config-dir`, `--home`, `--database`.

---

### `codework serve`

Start a persistent server that owns sessions and sandboxes:

```bash
codework serve --host 127.0.0.1 --port 7433
codework run --server ws://127.0.0.1:7433/rpc "Inspect the failing tests"
codework run --server ws://127.0.0.1:7433/rpc --session <id> "Now fix them"
codework run --server ws://127.0.0.1:7433/rpc --sandbox-id <sandbox-id> "Start another session in this sandbox"
```

The default address is `127.0.0.1:7433`; `--port 0` picks an available port and prints the actual URL. Set `--home`, `--database`, and `--user-config-dir` on the server. Model credentials, plugins, and working directories are resolved by the server. A remote run does not boot a local harness.

Events are live and not replayed. The client subscribes before admitting its prompt and waits for execution completion after rendering. Lost connections and overflow fail the command; disconnecting leaves server work running. Ctrl-C sends `session.interrupt`, which interrupts the shared session. Remote runs print the sandbox ID for reuse. `session.interrupt` returns `{ interrupted }` as soon as the stop is accepted; `session.wait` is the separate cleanup barrier. A busy period reports itself as `session.execution.started` followed by exactly one of `succeeded`, `failed`, or `interrupted` -- a failure carries a namespaced category (`provider.auth`, `model.not-found`, `sandbox.mount`, ...) that the client renders, and an interruption carries whether it was the user or a server shutdown. Managed sandboxes remain available until explicitly stopped or server shutdown; external sandboxes are not stopped.

The v0 endpoint has no authentication; its default binding is loopback. Plugins publish their own event types by declaring them (`Plugin.define({ events: [...] })`, namespaced `plugin.<plugin-id>.*`); the feed carries those and skips types nothing declared. Invalid payloads for declared types fail with a typed encoding error.

---

### `codework models`

List catalog models as `provider/model`, one per line.

```bash
# List all models across all providers
codework models

# List models for a specific provider
codework models --provider openai

# List all supported provider IDs
codework models providers
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
