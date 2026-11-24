# @codeworksh/cli

The `codework` binary: run coding-agent sessions from your terminal, and serve them to the CLI, the desktop app and paired machines from a long-lived RPC server.

## Install

```bash
pnpm add -g @codeworksh/cli
```

Requires Node 24.14.1 or newer. Every command is then `codework <command>`, and `codework <command> --help` lists its flags.

## Quick Start

```bash
# Sign in with an OAuth provider, or set its usual API key env var (e.g. ANTHROPIC_API_KEY)
codework auth login --openai-codex

# Start a session in this directory, with the harness running in-process
codework run "Inspect the failing tests"

# Continue it, on its main thread or another one
codework run --session <session-id> "Now fix them"
codework run --session <session-id> --thread <thread-id> "Try it without the cache"

# Or keep a server running and send runs to it
codework service start
codework run --server ws://127.0.0.1:7433/rpc/v1 "Inspect the failing tests"
```

## Commands

| Command                  | What it does                                                                     |
| ------------------------ | -------------------------------------------------------------------------------- |
| `run`                    | Start or continue a session, in-process or on the server with `--server`         |
| `serve`                  | Run the RPC server in the foreground (default `127.0.0.1:7433`)                  |
| `service`                | Start, stop or check the background server; pair, list and revoke devices        |
| `session link`, `relink` | Anchor a session to a host directory, or move a session or thread somewhere else |
| `thread list`, `fork`    | List a session's threads, or start a new one from a point in a thread's history  |
| `auth`                   | Log in to, inspect, refresh or log out of `openai-codex` and `github-copilot`    |
| `mcp`                    | Add, remove, list, sign in to and reconnect MCP servers in `mcp.json`            |
| `plugin`                 | Add, install, list, update, reload and remove plugins in `settings.jsonc`        |
| `models`                 | List catalog models and providers, or refresh the catalog                        |
| `connect`, `disconnect`  | Link this machine to a Relay workspace, or leave one                             |
| `acp`                    | Serve the Agent Client Protocol on stdio for editors, always in-process          |

Every command takes `--home` (default `~/.codework`, or `CODEWORK_HOME_DIR`): the user settings, credentials, catalog, database and machine identity it works with. `--user-config-dir` replaces the user settings file, and `--database` picks the SQLite file.

## What It Owns

This package is the host: the only place an agent runs. It owns the CLI, the RPC server and its contract, and the machine's identity, which is its paired devices and its Relay workspace links. It builds on `@codeworksh/harness` and `@codeworksh/aikit`, and nothing in the core imports it, so the harness never knows how it is reached.

Two rules shape the CLI:

- **In-process and `--server` both stay supported.** They share the home and database, so a session made by one is readable by the other. With `--server`, harness flags like `--database` belong on `serve`.
- **The CLI only talks to its own home's server.** `--server` must be the server `<home>/service.json` names. Other machines are reached by the desktop app as a paired device.

See [docs/internals/09_server.md](https://github.com/codeworksh/codework/blob/main/docs/internals/09_server.md) for the contract, admission, pairing and shutdown rules.

## Code Map

- [`src/index.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/index.ts) is the entry point, mapping each command to its lazily imported handler.
- [`src/cli/cmd/cmd.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/cli/cmd/cmd.ts) declares every command, flag and example.
- [`src/cli/cmd/handlers`](https://github.com/codeworksh/codework/tree/main/packages/codework/src/cli/cmd/handlers) holds one handler per command.
- [`src/cli/harness.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/cli/harness.ts) builds the harness options `run` and `serve` must share.
- [`src/cli/service.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/cli/service.ts) finds and connects to the home's server.
- [`src/server/server.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/server/server.ts) assembles the RPC server and fixes its startup and shutdown order.
- [`src/server/contract.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/server/contract.ts) is the RPC contract; [`src/server/handlers.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/server/handlers.ts) implements it over harness services.
- [`src/server/door.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/server/door.ts) and [`src/server/pairing.ts`](https://github.com/codeworksh/codework/blob/main/packages/codework/src/server/pairing.ts) decide who may connect.
- [`src/machine`](https://github.com/codeworksh/codework/tree/main/packages/codework/src/machine) keeps `machine.json`, Relay connects and the heartbeat.
- [`src/acp`](https://github.com/codeworksh/codework/tree/main/packages/codework/src/acp) is the ACP server.

## Working Locally

From `packages/codework` (or `pnpm dev:cli` at the repo root), `start` runs `src/index.ts` with `--conditions=development` so workspace packages resolve to source:

```bash
pnpm start --help
pnpm start models
pnpm start run "Inspect the failing tests"
pnpm test
pnpm check
```

`pnpm build` packs the published `dist` build.

## License

MIT
