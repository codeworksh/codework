# Glossary

Shared vocabulary across CodeWork. Each term names one thing, and the code uses the same word.

## Offering

What users get and the words they see.

| Term          | Meaning                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| CodeWork      | The whole product: harness, CLI, desktop app and Relay.                                                                 |
| Harness       | The agent itself: the loop, tools, sandboxes and plugins. Open source, MIT licensed.                                    |
| Surface       | A way users reach CodeWork: the RPC server, the CLI or the desktop app.                                                 |
| CLI           | `codework`, on npm and as a single binary. `run` works in-process, or against the home's server with `--server`.        |
| Desktop app   | The Electron app. A client of one or more RPC servers, local and paired.                                                |
| ACP           | `codework acp`: the harness for editors over stdio, always in-process. A best-effort add-on, not a surface.             |
| Relay         | The cloud service for accounts, workspaces and machines, at relay.codework.sh. Carries no traffic.                      |
| Model catalog | The models CodeWork knows and their limits, generated from models.dev and OpenRouter's listing, at catalog.codework.sh. |
| Plugin        | A package that adds MCP servers, tools or prompt sections. One package is one plugin.                                   |

## Architecture

The domains and the processes that make up CodeWork.

| Term           | Meaning                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Core           | `packages/aikit`, `packages/harness`, `packages/plugin`. Libraries that never know how they are reached.                              |
| Host           | `packages/codework`: the `codework` binary and its RPC server. The only place an agent runs.                                          |
| App            | `apps/*`: the desktop app's Electron shell, app server and UI.                                                                        |
| Cloud          | `infra/*`: Relay and the model catalog. Records membership; never carries traffic or runs an agent.                                   |
| aikit          | One wire protocol over many model providers. Every model call goes through it.                                                        |
| RPC server     | `codework serve`: one home's harness over WebSocket. Advertises itself in the home's `service.json`.                                  |
| App server     | `apps/server`: the desktop app's own server and database. A client of RPC servers; never touches project files.                       |
| Home           | The user-wide data directory (`--home`, else `CODEWORK_HOME_DIR`, else `~/.codework`): settings, credentials, plugin cache, data.     |
| Machine        | A computer with a CodeWork home. Its id and keys are in the home's `machine.json`. The desktop app gives each machine row its own id. |
| Sandbox driver | Code that provisions remote sandboxes. Its contract is in `packages/plugin`, but the embedder supplies it, not settings.              |
| Paired         | A device given access to a server with a one-time code (`codework service pair`), like an SSH key. It cannot manage devices.          |
| Linked machine | A machine that joined a workspace through Relay (`codework connect`). Membership, not access.                                         |
| Workspace      | A group of people and machines in Relay. People are owners, admins or members.                                                        |

## Technical Details

### Where Work Happens

| Term         | Meaning                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project      | A body of work, usually one repository, across every place it is checked out.                                                                            |
| Space        | One directory of a project in one env. Sessions attach to a space. Kind: primary, linked, copy or plain.                                                 |
| Primary      | A project's main checkout in an env. One per project and env.                                                                                            |
| Linked space | A git worktree sharing the primary's store. Shown as "Worktree" in the UI.                                                                               |
| Location     | A space plus a directory at or under its root: the exact place a run works.                                                                              |
| Sandbox      | Where tools act: a filesystem, a shell and an identity. Kind: local, virtual or remote.                                                                  |
| Env          | The sandbox instance a space lives in, `local` for the host. A path means nothing without its env.                                                       |
| Managed      | A sandbox CodeWork started and stops. An `external` one is attached and left running.                                                                    |
| hostCwd      | The app process's working directory on the host. Resolves app-level flags. Never searched for a project.                                                 |
| hostDir      | The host directory linked to a session. Per-session configuration resolves from it, with no fallback to `hostCwd`. The CLI passes the shell's directory. |
| cwd          | The sandbox working directory, where tools run. Never a source of configuration.                                                                         |

### Sessions and Runs

| Term       | Meaning                                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Session    | The top level of a conversation, attached to a space. Never called a thread.                                                       |
| Thread     | One line of history inside a session: `main`, a `fork` or a `subagent`.                                                            |
| Prompt     | A user message admitted to a thread under a stable id, so a retry is idempotent.                                                   |
| Inbox      | A thread's durable queue of prompts not yet sent to the model.                                                                     |
| Steer      | Delivery that joins running work at the next boundary. The default.                                                                |
| Follow-up  | Delivery (`followUp`) that waits for a reply without tool calls. One is promoted at each such boundary, inside the same run.       |
| Run        | A thread working through its prompts until it settles. State: idle, starting or running.                                           |
| Execution  | One process's attempt at a run, ending in exactly one terminal. After a restart, a resumed one picks it up.                        |
| Turn       | One model request and the tool calls it makes. A committed turn resets the crash count, unless it is a recovered one.              |
| Interrupt  | Stopping an execution, with a reason: user, shutdown or crash. A user stop or a failed run parks the inbox.                        |
| Event      | A fact about a session. Durable events are stored with their projections in one transaction; ephemeral ones are live only.         |
| Event feed | The live stream of events to a client (`event.subscribe`). It replays no session history; clients catch up through the sync calls. |
| Compaction | Summarising older history so a thread fits the model's context.                                                                    |

### Models and Extensions

| Term           | Meaning                                                                                                                                                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider       | A model vendor behind aikit, such as `anthropic` or `openai-codex`.                                                                                                           |
| Thinking level | How hard a model reasons. Clamped to what the model supports before the call.                                                                                                 |
| Tool           | Something the model can call: built in, from a plugin, or from an MCP server.                                                                                                 |
| Prompt section | A tagged block of the system prompt, built in or from a plugin.                                                                                                               |
| Settings       | Two layers: user (`<home>/settings.jsonc`, or `--user-config-dir`) under project (the nearest `.codework` directory at or above `hostDir`). `.json` is the fallback spelling. |
| MCP server     | An external tool server. Always runs on the host, never in a sandbox.                                                                                                         |

### Desktop App

| Term   | Meaning                                                                             |
| ------ | ----------------------------------------------------------------------------------- |
| Tab    | A named, tiled view in the desktop app, switched with Cmd+1–9 (Ctrl+1–9 off macOS). |
| Widget | A desktop panel with a view half and a backend half, built on `@codeworksh/widget`. |
