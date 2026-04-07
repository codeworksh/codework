# Repository Guidelines

## Project Structure & Module Organization

This repository is a `pnpm` workspace with two TypeScript packages under `packages/`: `packages/aikit` for the AI agent toolkit and `packages/utils` for shared helpers. Source files live in each package's `src/` directory. Tests currently live in `packages/aikit/test/` and use the `*.test.ts` pattern. Shared repo files include `vite.config.ts`, `models.json`, `assets/` for static assets, and `scripts/publish.js` for package publishing.

## Build, Test, and Development Commands

Use Node `>=24.14.1` and `pnpm@10`.

- `pnpm install`: install workspace dependencies.
- `pnpm lint`: run `vite-plus` lint checks across the repo.
- `pnpm check`: run TypeScript and repo validation checks.
- `pnpm test`: run the workspace test suite.
- `pnpm build`: build all packages.
- `pnpm --filter @codeworksh/aikit test`: run only `aikit` tests.
- `pnpm publish:aikit:dry`: dry-run the publish flow for `aikit`.

## Coding Style & Naming Conventions

The codebase uses ESM TypeScript with strict compiler settings. Follow the formatting configured in `vite.config.ts`: tabs for indentation, tab width `3`, and print width `120`. Prefer named exports, keep modules small, and use clear singular file names such as `agent.ts`, `model.ts`, and `stream.ts`. Test files should end in `.test.ts`. Keep imports explicit and consistent with the existing source, including `.ts` extensions where already used.

## Testing Guidelines

Tests use `vite-plus/test`. Add coverage for every behavior change in the affected package; for `aikit`, place tests in `packages/aikit/test/`. Prefer focused unit tests that mirror the source area being changed, for example `packages/aikit/test/stream.test.ts` for streaming behavior. Run `pnpm test` before opening a PR and use package-scoped test commands while iterating.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit style with optional package scopes, for example `feat(aikit): ...`, `fix(aikit): ...`, and `chore: ...`. Keep commit subjects imperative and concise.

PRs should describe the behavior change, list affected packages, and include test evidence such as `pnpm test` or `pnpm --filter ... test` output. Link related issues when applicable. Screenshots are only useful for docs or asset updates; library API changes should include code samples instead.

## Security & Configuration Tips

Do not commit secrets. Provider keys such as `ANTHROPIC_API_KEY` should come from the environment. Treat `models.json` and provider integrations as compatibility-sensitive files and note any downstream impact when changing them.
