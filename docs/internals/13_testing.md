# Testing

We test by running the real thing. A test spawns the real CLI or boots the real harness runtime, drives it the way a user or client would, and records what came out in a file that fails on drift. Mocks of our own code are rare, and an isolated test has to earn its place.

## End-to-End First

The default shape of a test, from the bottom of the stack up:

- **aikit** is the exception. Most of its suites test wire parsing, so they are isolated and feed scripted SSE responses through a mock `fetch`. Its live suites in `test/e2e/` call the real providers.
- **harness** boots a real `Harness` with a real store, real plugins and a real sandbox. Most suites swap only the model, with a scripted LLM at the harness's model boundary ([fixtures/llm.ts](../../packages/harness/test/fixtures/llm.ts)).
- **codework** spawns `src/index.ts` with `node --conditions=development` as a child process. The model is a local OpenAI-compatible HTTP server ([fixtures/cli.ts](../../packages/codework/test/fixtures/cli.ts)), so the full wire path from aikit to the provider protocol runs for real.
- **apps/server** starts a real CodeWork server from the harness and codework sources with a scripted model ([fixtures/codework.ts](../../apps/server/test/fixtures/codework.ts)), and syncs it into a real app server.
- **infra/relay** starts Postgres in Docker, creates a Clerk test user, and connects the real CLI to it.

A scripted or local fake model keeps the default run free and repeatable. The real provider is exercised by the live suites below.

## Artifacts, Not Snapshots

Each E2E case ends with a repeatable artifact under `__artifacts__/` beside the test, written with `toMatchFileSnapshot`. It fails on drift, and `vp test -u` regenerates it. No suite uses `__snapshots__/`; keep it that way.

What makes an artifact repeatable:

- **Normalise before you write.** Temp homes, ids and timestamps are replaced with stable labels such as `<machine 1>` or `<session 1>` (see `normalizer` in [apps.ts](../../apps/server/test/fixtures/apps.ts)). An artifact with a temp path in it fails on the next run.
- **Artifacts are exact bytes.** The formatter ignores `**/__artifacts__/**` ([vite.config.ts](../../vite.config.ts)). Never reformat an artifact, by hand or by an editor's format-on-save; regenerate it instead.
- **Review the diff.** Regenerating with `-u` accepts whatever the code now does. The artifact diff is the review.

## Isolation From the Developer's Machine

Tests run on the developer's computer while their real CodeWork is in use. Every suite isolates itself:

- **A throwaway home.** Spawned CLIs get `--home <tmp>` or `CODEWORK_HOME_DIR=<tmp>`, often with `--database :memory:`. Never point a test at `~/.codework`.
- **`HOME` too.** Provider SDKs cache credentials under the user's home directory, so CLI suites set `HOME` to the temp home as well ([cli.test.ts](../../packages/codework/test/cli.test.ts)).
- **A temp working directory.** Project settings are discovered by walking up from the directory a process runs in. A child spawned inside this repository would read the repository's own `.codework/settings.jsonc`.
- **A pinned model catalog.** Suites set `CODEWORK_MODELS_FILE` to the workspace's `models.gen.json`, so no spawn downloads a catalog into its home.
- **Kill only what you spawned.** Fixtures keep the child or PID they started and stop that one ([stop.sh](../../apps/server/test/machines/stop.sh)). Never kill by name or pattern.

## Live Provider Tests

Live suites call paid providers. In harness and codework they are named `*.live.test.ts`; a few harness ones reach other real services, such as npm and git hosts, instead. In aikit they are the `*.e2e.test.ts` files under `test/e2e/`. Each provider's case is skipped when its key is missing, so a run without keys still passes. The `*.live.test.ts` suites in apps/server are the machine simulations below, not provider tests.

Credentials come from two places ([aikit env.ts](../../packages/aikit/test/utils/env.ts), [harness live.ts](../../packages/harness/test/utils/live.ts)):

- `.env.local` at the repository root, loaded with `process.loadEnvFile`. API keys such as `OPENAI_API_KEY` and `OPENROUTER_API_KEY` go here.
- For OAuth providers (`openai-codex`, `github-copilot`), the current access token from `~/.codework/aikit/auth.json`, read into the provider's key variable.

The login file itself is never used or copied into a test home. A refresh there would rotate the refresh token and sign the developer out of their real install. A token close to expiry skips the suite instead of refreshing.

The harness runs each live case across a list of providers and models in [live.ts](../../packages/harness/test/utils/live.ts). A multi-model feature should add its case there, not against one provider.

## Remote Sandboxes

`*.e2e.test.ts` files in harness drive real remote sandboxes (Vercel, Daytona). They are excluded from the default run, along with aikit's live suites, which share the suffix. `vp run test:sandbox:e2e` in `packages/harness` runs them with `CODEWORK_SANDBOX_E2E_REQUIRED=1`, which turns a missing credential into a failure instead of a skip ([fixtures/live.ts](../../packages/harness/test/fixtures/live.ts)).

## Machine Simulations

Multi-machine behavior, such as sync, usage and recovery, is tested on real Linux machines in OrbStack ([machines/](../../apps/server/test/machines)). Each machine copies the checkout through the Mac mount, installs its own dependencies and runs the fixture server. The suite then cuts, throttles, crashes and replaces machines with `iptables` and `tc` while one app server on the Mac syncs them all.

These are the `*.live.test.ts` suites in apps/server: the `*.machines.live.test.ts` files and the metrics simulation. They run as their own vitest project with file parallelism off, because the suites share the OrbStack machines and each start stops the server another one runs ([vite.config.ts](../../apps/server/vite.config.ts)). Without the `orb` CLI they skip.

## When an Isolated Test Is Allowed

Never write unit tests after you write code. Write down how a system could fail before writing an isolated test for it, then write the code. Keep one only if it catches a real bug the E2E tests miss. The cases that qualify:

- Wire-protocol parsing: provider streams, JSON repair, event streams.
- OAuth flows and token refresh.
- Cancellation and concurrency: races between interrupts, MCP connections and turns.
- Data integrity: the store and the usage rollup.
- Security boundaries.

Harness tests that run Effects use the local `it.effect` helper in [utils/effect.ts](../../packages/harness/test/utils/effect.ts), which runs on a test clock. Use `it.live` only for real subprocesses or the network.

## Commands

- `vp test` runs vitest in the current directory. At the root it covers `packages/**` only and skips `*.e2e.test.ts`, so neither aikit's live suites nor the remote sandbox suites run.
- `vp run test` runs a package's `test` script, which can differ. In aikit, `vp run test` excludes `test/e2e/`, while `vp test` runs the live suites too.
- Each package's `vite.config.ts` holds its test config. Suites that spawn the CLI set a longer test timeout.

CI does not run the test suites. Pull requests run `vp run verify` (check, typecheck and knip) and build the packages. The publish workflow runs only the standalone binary's offline test (see [releasing](./14_releasing.md)). Run the relevant suites locally before calling work done.
