# Personal Preference

## TypeScript

- Never use `any` unless 100% necessary or specifically instructed.
- Use effect only if the project uses effect or specifically instructed, use effect reference repository for latest architecture patterns.

## Commands

- Don't run dev server commands (e.g `pnpm run dev`, `bun run dev`) - assume it's already running.
- Don't run build commands unless specifically told to.
- Focus on checking commands like `pnpm run check`, `bun run lint` `bun run typecheck`, etc.

## Package Managers

- Use `pnpm`, `vp - vite plus` if the project already uses it, otherwise use `pnpm`
- Never use `npm` or `yarn

## Tech Stack Preference

When uncertain, prefer: Effect, Tailwind, TypeScript, React, Clerk, TanStack, Vercel, Vite

## Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- No pre-mature optimizations, propose if required.
- Use single word filename whenever possible otherwise split into kabab-case(only if no options).

## General Preferences

- If asked to do too much work at once, stop and state that clearly.
- If computer use is helpful for completing or verifying work, use it.
- Avoid defensive future-facing design. This leads to pre-mature assumptions which are never true.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `packages/aikit` - Low level SDK that provides unified LLM API for multiple LLM providers.
- `packages/harness` - Effect powered main Agent Harness application, uses `packages/aikit` under the hood.
- `packages/plugin` - The published SDK third-party plugin and sandbox-driver packages build against. It owns the shared contract (plugin, tool, sandbox mount, event and settings types); `packages/harness` depends on it, never the other way round.
- `.scratch/packages` - Local, ignored reference archive for packages that are no longer developed.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under .repos/ unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for examples of idiomatic usage, tests, module structure, and API design.

## Personal Notes & Document Spec

This project uses private design documents under `.notes/` as implementation reference for coding agents. When specified use it for planning, designing and brainstorming. When creating, mention in doc current date and git commit ID if available.

- Allow the design docs to be reviewed by subagents when see fit.
- Propose improvements when see fit.

## Testing

- Never write unit tests after you write code.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work (spawn the real CLI, boot the real runtime, hit the real provider or sandbox).
- At the end of an E2E test, produce a verifiable and repeatable artifact under `__artifacts__/` (e.g. a path-normalised `toMatchFileSnapshot("./__artifacts__/<name>.json")` that fails on drift and regenerates with `-u`). Do not use `__snapshots__/`.
- If you must test a system in isolation, first write down all the ways it could fail, then write the code. Only keep an isolated test if it catches a real bug the E2E tests miss (wire-protocol parsing, OAuth refresh, cancellation/concurrency, data integrity, security boundaries).

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed, unless otherwise specified.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the test package script.

## Commit & Pull Request Guidelines

Conventional Commit style with optional package scopes, e.g `feat(aikit): ...`, `fix(aikit): ...`, and `chore: ...`. Keep commit subjects imperative and concise.

## Releasing

Every package is published by CI from `.github/workflows/publish.yml`, which runs `vp run release <channel>` (`scripts/release.mjs`). It builds the TUI binaries, then publishes the packages in dependency order, derived from their `package.json` workspace dependencies (`scripts/workspace.mjs`), pinning each package to the exact versions uploaded in the same run. `scripts/publish.mjs` builds a single package, rewrites its manifest and publishes it from a temp dir.

- **canary**: every push to `canary`, without `vp check` or typecheck, for quick testing. Versions are `<version>-canary.<run>.<attempt>.g<sha>`.
- **dev**: every push to `dev`. Versions are `<version>-dev.<YYYYMMDDHHMMSS>` (UTC).
- **latest**: run the workflow by hand on `main`. It publishes each package whose manifest version is not on npm yet and skips the rest.

Versions are bumped locally with `vp run bump <aikit|plugin|harness|tui|cli> [version]`, which runs `bumpp` with the package's `bump.config.ts` and commits and tags `@codeworksh/<pkg>@<version>` without pushing. `vp run bump tui` moves the launcher and its four platform packages together.

Flow:

1. Update `CHANGELOG.md` — move the entry from `[Unreleased]` into a versioned section.
2. `vp run bump <pkg>` for each package to release.
3. `git push && git push --tags`, then merge to `main`.
4. Run the Publish workflow on `main`.

`vp run release <channel> --dry-run` previews the chain locally; the TUI platform packages need their binaries under `packages/tui/dist/bin`.
