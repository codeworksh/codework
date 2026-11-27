# CodeWork

CodeWork is an open source coding agent harness and GUI, like Claude Code, Pi, OpenCode and Codex. Think of it as an open alternative to Claude Desktop, Codex App, Cursor Glass and Conductor.

The harness runs in the `codework` CLI, in-process or as an RPC server. The desktop app runs its own Node server, which connects to one or more of those RPC servers over WebSocket.

## What Makes CodeWork Special?

Here's a brief list of the things we can never compromise on.

### 1. Open at the Core

CodeWork is truly open. The harness, the SDKs and the apps stay open source and MIT licensed. We work in the open, and should strive to stay that way.

### 2. Always Multi-Model

The harness is never tied to one provider. Every model call goes through `packages/aikit`, one wire protocol over many providers, with first-party support for `anthropic`, `openai`, `openai-codex`, `github-copilot` and `openrouter`, and soon `radar` from the CodeWork team. aikit also speaks the Google, Vertex, xAI and OpenAI-compatible protocols. The model catalog is generated from models.dev and OpenRouter's listing, and served from catalog.codework.sh. A feature that only works with one provider needs a decision for every other: supported, degraded, or plainly refused.

### 3. Server First, Durable by Default

Agents run on the server, not in the client. A client can close, sleep or lose its connection, and the run keeps going. When it comes back, it catches up from the server's stored state.

The server also survives its own restarts. Every run, prompt and durable event is persisted; only live streams such as text deltas are not. A run cut off by a crash or restart resumes when the server comes back, and a stop parks queued prompts instead of dropping them.

New features keep both promises: state that matters lives on the server and is persisted, and no client is ever needed for a run to finish.

### 4. Extensible by Plugins

Third parties extend the harness through `packages/plugin`: MCP servers, tools and prompt sections. Sandbox drivers share the contract package, but the embedder supplies them, not settings. If a capability could be a plugin, its contract lives in `packages/plugin`, and the harness depends on it, never the other way round.

### 5. Performance Without Compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of CodeWork. We regularly audit for performance regressions, often caused by sending too much data over WebSockets, CSS animations causing GPU spikes, lists being hard to render, and more. Keep the performance cost of every change in mind.

### 6. Remote Ready

Because agents run on the server, users can work from anywhere. Whether they connect directly over their local network, use Tailscale, or lean in fully with Relay (our cloud service for workspaces and machines, also in this repo), new features must work across all of them.

### 7. Multi-Surface

CodeWork has three surfaces: the **RPC server**, the **CLI** and the **desktop** app.

**RPC server** (`codework serve`) is where agents run. The CLI, the desktop app and widget backends are all its clients, and other machines pair with it to work remotely.

**CLI** (`codework`) runs `codework run` in-process by default, or against the home's server with `--server`, and both modes stay supported. Commands that manage existing sessions and threads always go through the home's server, and `--server` never accepts any other server. ACP (`codework acp`) is a best-effort add-on that always runs in-process.

**Desktop** (`apps/desktop`) is a client of one or more RPC servers, local and paired, through its own app server.

A new feature needs a decision for every surface, even if the decision is "not here".

## Architecture

**Core** (`packages/aikit`, `packages/harness`, `packages/plugin`) is the agent: models, the loop, tools, sandboxes and the plugin contract. It is a library and never knows how it is reached.

**Host** (`packages/codework`) is the `codework` binary and its RPC server, the only place an agent runs. It owns the machine's identity: paired devices, and a workspace link through Relay.

**App** (`apps/*`) is the desktop app: Electron (`apps/desktop`), its server (`apps/server`) and the UI (`apps/web`). The app server is a client of host RPC servers, local and paired. It never touches project files, and app-only state (tabs, tracking, widgets) lives here.

**Cloud** (`infra/*`) is Relay (accounts, workspaces, machines) and the model catalog. It records membership, carries no traffic and never runs an agent.

## A Note from CodeWork Engineering Team

We like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most CodeWork contributions will come from CodeWork itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the CodeWork instance that the contributor is using.

## Terminology

- **you** = the agent reading this file. **we / us / maintainers** = Sanchit, Prem and the people building CodeWork. **user** = the person driving coding agents in CodeWork. **agent** = a coding agent running inside CodeWork.
- **session** is the top level; **threads** live inside a session. Never call the top level a thread.
- Domain terms (home, machine, project, space, sandbox, session, thread, run, execution, turn, etc.): [00_glossary.md](docs/internals/00_glossary.md).

## Hit Every Layer

The most common defect is a change that works on the path you tested and is missing everywhere else. Start with the core: harness and CLI first, then `apps/server`, then the UI. Before calling work done, walk this list and say which entries applied:

- **Providers.** Every aikit provider needs a decision, even if it's "not supported here".
- **Contracts.** Plugin-facing types go in `packages/plugin`, the app server's RPC in `apps/contract`, and Relay and signed machine requests in `packages/schema`. The host's RPC contract lives in `packages/codework/src/server/contract.ts` and is mirrored by hand in `apps/widget/src/codework.ts`, so a change there lands in both.
- **Modes.** The CLI in-process and with `--server`; local, virtual and remote sandboxes.
- **Connections.** Local network, Tailscale and Relay, across more than one machine.
- **Reverse states.** Every way in needs a way out and a way to see it. A one-way door is a bug.
- **Docs.** Check whether the change makes existing guidance wrong.

## Dev Servers and Test Data

[00_development.md](docs/operations/00_development.md) walks through setup, the dev home and each dev server. A few things matter most when an agent runs them:

- **Dev home:** Export `CODEWORK_HOME_DIR="$PWD/.scratch/home"` in every shell you start a process from. Please keep dev processes away from `~/.codework`: it's the user's real install, and it may be the CodeWork running you right now.
- **Start order:** Start Relay first (`infra/relay`, see its README), then the RPC server (`vp run dev:cli serve --port 0`), then the desktop app and its server (`vp run dev:desktop`), the last two with the same home and `CODEWORK_RELAY_URL=http://127.0.0.1:8787`. The app signs everyone in and needs a Relay it can reach. The app finds the server through `<home>/service.json`. Nothing reloads the RPC server, so restart it after harness or codework changes.
- **Desktop app:** Leave the Install and Start buttons alone in the dev app. Install writes the released binary to `~/.codework/bin`, and Start runs the installed `codework` (the one in `~/.codework/bin`, else your login shell's) against the dev home.
- **Process lifecycle:** Start dev servers from your own shell so they stop when your session does, and don't detach them with `nohup`, `setsid` or `tmux` unless asked. When you clean up, stop only the PIDs you started, never by name or pattern.
- **Test data:** An empty home is the easy default. If the flow needs existing sessions, copy the real database in with `sqlite3 ... .backup`, and only while no run is active: the dev server resumes open runs, and they would act on the real project files.

## Verifying

- We test by running the real thing: E2E first, each case ending in an `__artifacts__/` file, and isolated tests only where they catch a bug E2E misses. Never write unit tests after you write code. [13_testing.md](docs/internals/13_testing.md) has the details.
- Before handing work back, run `vp run verify`. It's the same gate CI runs: `vp check` over packages, scripts, `.github` and infra, the package typechecks, then knip. Its check and typecheck steps skip `apps/`, so for app changes also run `vp check <paths>` and `vp run --filter <app> typecheck`.
- While you iterate, `vp check <paths>`, `vp test <files>` (add `-t "<name>"` in large files) and `vp run --filter <pkg> typecheck` keep the loop fast.
- CI runs no test suites on pull requests, so it's on you to run the suites for the code you changed. [13_testing.md](docs/internals/13_testing.md) covers what to test, the throwaway home, and the `__artifacts__/` file each E2E case ends with. `vp test -u` accepts whatever the code now does, so use it once you've read the diff.
- When a change touches provider or model behavior, run the live suites: `*.live.test.ts` in harness and codework, and `test/e2e/` in aikit. They call paid models, so pick the cheapest one that exercises the change.
- For user-visible desktop changes, give the real app one pass: start the dev servers above with `vp run dev:desktop -- --remote-debugging-port=9222`, drive Electron through that port with the `agent-browser` skill, and walk the flow as a user would, with a real model call. Smooth out anything rough before you hand back. The desktop dev server holds port 5173, so only one runs per machine; leave it to the primary agent, not subagents.
- Sync, usage, recovery and other behavior that crosses machines deserves the OrbStack machine simulations (`*.machines.live.test.ts` in `apps/server`), on at least three machines.

## Pull Requests

We're open to pull requests and glad to get them, especially ones that fix a bug, solve a real problem, or make CodeWork faster or clearer. Adding a feature is different: every feature is one we support for a long time, across every provider and surface, so think twice and suggest an issue first. [CONTRIBUTING.md](CONTRIBUTING.md) has the short version for everyone.

- Commit, push or open a PR only when the developer asks. A request to commit isn't a request to push.
- PRs target `canary` unless the developer picks another base, such as a feature branch. Changes then move `canary` → `dev` → `main`, and each branch is a release channel: `canary` builds every push for quick testing, `dev` publishes verified prereleases and is where versions are bumped, and `main` ships the latest release. [14_releasing.md](docs/internals/14_releasing.md) has the details.
- We squash-merge, so the PR title becomes the commit on `canary`. Write a conventional title in plain language, scoped by package when one fits: `fix(harness): count a crash before the request as a failed attempt`.
- In the body, say what changed and why in a sentence or two, add sections by area when the change spans packages, then a `## Testing` section with what you ran and saw. If something failed or was skipped, say so plainly; reviewers would rather know. End with the model and harness that did the work.
- This repository is public, so keep issue tracker ids and links, and the names of vendored reference repos, out of commits and PR text.
- One request is one PR, and fixes you find along the way belong in it too. Split only when asked.
- Leave `CHANGELOG.md` and package versions to the maintainers. We write release notes by hand and cut releases ourselves.

## Documentation

Most code changes don't need a doc change; people and agents can read the code. When one does, here's where it goes:

- **`docs/internals/`** holds decisions and their reasons, constraints that span packages, and traps that are hard to spot in the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If the code already answers that, leave it out.
- Skip what drifts: lists of fields, constants or timeouts, file catalogs, step-by-step control flow, PR summaries. Types, tests and code already record those. The glossary defines shared words; it isn't a feature index.
- A reason that only matters in one place belongs in a short comment beside the code. Link to source rather than copying it.
- When a documented decision changes, rewrite or remove the old text instead of appending the new story. A new internal page needs a lasting reason to exist.
- **`docs/operations/`** holds runbooks for people working on CodeWork: setup, releasing and debugging.
- **Package READMEs** (`packages/*/README.md`) are what npm shows, so keep them about using the package.

## Plans and Work Artifacts

- Private design documents live in `.notes/`, which is gitignored. Use it for planning, designing and brainstorming when asked. Start each new doc with the current date and git commit, so a later reader knows which code it describes. When it helps, ask subagents to review a doc and propose improvements.
- Keep plans, research notes and scratch files out of commits. `.scratch/` or your own temp directory works for anything throwaway.
- Once a design is agreed, it moves to the issue. A merged PR is the record of what was built.

## Where Code Lives

- `packages/aikit` - one API over many model providers: streaming, tools, usage and OAuth logins. Plain TypeScript, no Effect.
- `packages/harness` - the agent: the loop, tools, sandboxes, plugins, MCP, projects and spaces, settings and the durable store. Effect-native.
- `packages/plugin` - the SDK third-party plugins and sandbox drivers build against. It owns the contracts the harness implements.
- `packages/codework` - the `codework` CLI (`@codeworksh/cli`) and its RPC server. Ships on npm and as a Node SEA binary.
- `packages/schema` - wire schemas for Relay and signed machine requests. Private, and bundled into its consumers.
- `apps/desktop` - the Electron app. `apps/server` is its app server, `apps/web` its UI, `apps/contract` the RPC contract between them, and `apps/widget` the widget SDK.
- `infra/relay` - Relay, the cloud API for accounts, workspaces and machines. `infra/catalog` serves the model catalog.
- `extras/` - example third-party plugins, handy as templates.
- `packages/tui` - paused. It stays in the tree but outside the workspace, so nothing checks, builds or publishes it.
- `.repos/` - vendored reference repos, read-only. Read them for ideas and idioms (Effect 4 lives in `.repos/effect-smol`, start with its `LLMS.md`), but never edit or import from them.

### Internal Docs by Area

Each area has a short doc. Reading it before you change that code saves a lot of wrong turns.

| Area                                     | Read first                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Vocabulary and architecture              | [00_glossary.md](docs/internals/00_glossary.md), [01_architecture.md](docs/internals/01_architecture.md) |
| Effect services, layers and errors       | [02_services.md](docs/internals/02_services.md)                                                          |
| Providers, credentials and model catalog | [03_models.md](docs/internals/03_models.md)                                                              |
| Sessions, threads, runs and durability   | [04_runtime.md](docs/internals/04_runtime.md)                                                            |
| Projects, spaces and locations           | [05_projects.md](docs/internals/05_projects.md)                                                          |
| Sandboxes and drivers                    | [06_sandboxes.md](docs/internals/06_sandboxes.md)                                                        |
| Host directories and settings            | [07_settings.md](docs/internals/07_settings.md)                                                          |
| Plugins, tools, prompt sections and MCP  | [08_plugins.md](docs/internals/08_plugins.md)                                                            |
| RPC server, pairing and the CLI client   | [09_server.md](docs/internals/09_server.md)                                                              |
| Relay, workspaces and machine links      | [10_relay.md](docs/internals/10_relay.md)                                                                |
| Desktop app, app server and widgets      | [11_desktop.md](docs/internals/11_desktop.md)                                                            |
| Telemetry                                | [12_telemetry.md](docs/internals/12_telemetry.md)                                                        |
| Writing tests                            | [13_testing.md](docs/internals/13_testing.md)                                                            |
| Releasing and the CLI binary             | [14_releasing.md](docs/internals/14_releasing.md)                                                        |

## Taste

- If asked to do too much at once, stop and say so.
- Design talk is not a go-ahead. Wait for an explicit "implement".
- If a rule fights the task in front of you, say so loudly and get a human sign-off before breaking it.
- No continuously repainting animations; they peg the GPU on high-refresh displays.
- Default to no comment. Write one only for a constraint, external quirk, or invariant the code can't show.
- Inferred types over annotations. `any` is the enemy.
- Look for shared logic before adding more. Duplicated logic is a smell, so don't solve a problem with a local patch when the shared code should change.
- Single-word filenames where you can, kebab-case otherwise. Runtime data files follow the same rule: `mcpauth.json`, not `mcp-auth.json`.
- Use `vp` and `pnpm`, never `npm`, `yarn` or `bun`.
- For a fresh tech choice, we lean toward Effect, TypeScript, React, TanStack, Tailwind, Clerk, Vite and Vercel.
- Ask a peer agent for a fresh review when the change is complex enough to be worth it.
