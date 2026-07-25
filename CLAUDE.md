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
- `packages/agent` - DEPRECATED.
- `packages/bridge` - WIP.
- `packages/desktop` - WIP.
- `packages/sdk` - WIP.
- `packages/utils` - DEPRECATED.
- `packages/webui` - WIP.

## Picking the right models for workflows and subagents

Rankings, higher = better. Cost reflects what I actually pay, not list price. Intelligence is how hard a problem you can hand the model unsupervised. Taste covers UI/UX, code quality, API design, and copy.

| **model** | **cost** | **intelligence** | **taste** |
| --------- | -------- | ---------------- | --------- |
| gpt-5.5   | 9        | 8                | 5         |
| sonnet-5  | 5        | 5                | 7         |
| opus-4.8  | 4        | 7                | 8         |
| fable-5   | 2        | 9                | 9         |

How to apply:

- These are defaults, not limits. You have standing permission to override them: if a cheaper model's output doesn't meet the bar, rerun or redo the work with a smarter model without asking. Judge the output, not the price tag. Escalating costs less than shipping mediocre work.
- Cost is a tie–breaker only; when axes conflict for anything that ships, intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 – it's effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent perspective.
- Never use Haiku.
- Mechanics: gpt-5.5 is only reachable through the Codex CLI – `codex exec` / `codex review` (my `~/.codex/config.toml` defaults to gpt-5.5). Use the codex-implementation, codex-review, and codex-computer-use skills; for work they don't cover (investigation, data analysis), run `codex exec -s read-only` directly with a self-contained prompt.
- Claude models (sonnet-5, opus-4.8, fable-5) run via the Agent/Workflow model parameter.

Using gpt-5.5 inside workflows and subagents (the model parameter only takes Claude models, so use a wrapper):

- Spawn a thin Claude wrapper agent with `model: 'sonnet', effort: 'low'` whose prompt instructs it to write a self-contained codex prompt, run `codex exec` via Bash, and return the report (use `schema` on the wrapper to get structured output back).
- Always label these agents with a `gpt-5.5:` prefix, e.g. `{label: 'gpt-5.5:review-auth'}` – the workflow UI shows the wrapper's Claude model, so the label is the only indication the real worker is gpt-5.5.
- Codex runs can exceed Bash's 10-minute timeout: pass an explicit timeout, or run in the background and poll for the report file.
- Parallel gpt-5.5 implementation agents must use `isolation: 'worktree'` so codex edits don't collide in the shared checkout.
- Workflow token budgets only count Claude tokens; codex work is free and invisible to `budget.spent()`.

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

Publishable packages (`@codeworksh/aikit`, `@codeworksh/sdk`) each own their release scripts; the root exposes `*:aikit` / `*:sdk` aliases so every command works from the repo root or from inside the package. Versioning uses `bumpp`, configured per package in `bump.config.ts` (tags follow `@codeworksh/<pkg>@<version>` and pushing is disabled). Build + publish run through `scripts/publish.js`, which builds, rewrites the manifest, and publishes from a temp dir. Pushing and publishing stay manual.

Flow (shown for `aikit`; substitute `sdk` as needed):

1. Update `CHANGELOG.md` — move the entry from `[Unreleased]` into a versioned section.
2. `pnpm bump:aikit` (or `pnpm run bump` inside `packages/aikit`): pick the bump; it commits and tags `@codeworksh/aikit@<version>` without pushing.
3. `git push && git push --tag`.
4. `pnpm release:aikit:dry` to preview the tarball, then `pnpm release:aikit` to publish. Use `pnpm release:aikit:dev` for a prerelease under the `dev` dist-tag.
