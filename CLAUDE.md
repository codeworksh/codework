# Personal Preference

## TypeScript

- Never use `any` unless 100% necessary or specifically instructed.
- Use effect only if the project uses effect or specifically instructed, use effect reference repository for latest architecture patterns.

## Commands

- Don't run dev server commands (e.g `bun run dev`, `pnpm run dev`) - assume it's already running.
- Don't run build commands unless specifically told to.
- Focus on checking commands like `bun run typecheck`, `pnpm run check`, `bun run lint`, etc.

## Package Managers

- Use `pnpm`, `vp - vite plus` if the project already uses it, otherwise use `pnpm`
- Never use `npm` or `yarn`

## Tech Stack Preference

When uncertain, prefer: Effect, Tailwind, TypeScript, React, Clerk, TanStack, Vercel, Vite.

## Code Style

- Always strive for concise, simple solutions.
- If a problem can be solved in a simpler way, propose it.
- No pre-mature optimizations, propose if required.
- Use single word filename whenever possible otherwise split into kabab-case(only if no options).

## General Preferences

- If asked to do too much work at once, stop and state that clearly.
- If computer use is helpful for completing or verifying work, shell out to gpt-5.5 with Codex for it
- Avoid defensive future-facing design. This leads to pre-mature assumptions which are never true.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `packages/aikit` - Low level SDK that provides unified LLM API for multiple LLM providers.
- `packages/harness` - Effect powered main Agent Harness application, uses `packages/aikit` under the hood.
- `packages/utils` - Shared support utilities used by `packages/aikit` and `packages/harness`.
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

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed, unless otherwise specified.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the test package script.

## Commit & Pull Request Guidelines

Conventional Commit style with optional package scopes, e.g `feat(aikit): ...`, `fix(aikit): ...`, and `chore: ...`. Keep commit subjects imperative and concise.

## Releasing

The publishable package `@codeworksh/aikit` owns its release scripts; the root exposes `*:aikit` aliases so every command works from the repo root or from inside the package. Versioning uses `bumpp`, configured in `packages/aikit/bump.config.ts` (tags follow `@codeworksh/aikit@<version>` and pushing is disabled). Build + publish run through `scripts/publish.js`, which builds, rewrites the manifest, and publishes from a temp dir. Pushing and publishing stay manual.

Flow:

1. Update `CHANGELOG.md` — move the entry from `[Unreleased]` into a versioned section.
2. `pnpm bump:aikit` (or `pnpm run bump` inside `packages/aikit`): pick the bump; it commits and tags `@codeworksh/aikit@<version>` without pushing.
3. `git push && git push --tag`.
4. `pnpm release:aikit:dry` to preview the tarball, then `pnpm release:aikit` to publish. Use `pnpm release:aikit:dev` for a prerelease under the `dev` dist-tag.
