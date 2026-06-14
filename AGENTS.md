# Repository Guidelines

## Project Structure & Module Organization

This repository is a `pnpm` workspace with TypeScript packages under `packages/`, including `packages/aikit` (the AI agent toolkit) and `packages/sdk` (the API SDK). `packages/utils` holds shared helpers that are bundled into dependents and marked `private`, so it is not published. Source files live in each package's `src/` directory. `aikit` tests live in `packages/aikit/test/` (`*.test.ts`), with opt-in live-provider suites under `packages/aikit/test/e2e/` (`*.e2e.test.ts`). Shared repo files include `vite.config.ts`, `models.json`, `assets/` for static assets, and `scripts/publish.js` for package publishing.

## Build, Test, and Development Commands

Use Node `>=24.14.1` and `pnpm@10`.

- `pnpm install`: install workspace dependencies.
- `pnpm lint`: run `vite-plus` lint checks across the repo.
- `pnpm check`: run TypeScript and repo validation checks.
- `pnpm test`: run the workspace test suite.
- `pnpm build`: build all packages.
- `pnpm --filter @codeworksh/aikit test`: run only `aikit` tests.
- `pnpm release:aikit:dry`: dry-run the publish flow for `aikit` (or `pnpm release:dry` inside `packages/aikit`).

## Coding Style & Naming Conventions

The codebase uses ESM TypeScript with strict compiler settings. Follow the formatting configured in `vite.config.ts`: tabs for indentation, tab width `3`, and print width `120`. Prefer named exports, keep modules small, and use clear singular file names such as `agent.ts`, `model.ts`, and `stream.ts`. Test files should end in `.test.ts`. Keep imports explicit and consistent with the existing source, including `.ts` extensions where already used.

## Testing Guidelines

Tests use `vite-plus/test`. Add coverage for every behavior change in the affected package; for `aikit`, place tests in `packages/aikit/test/`. Prefer focused unit tests that mirror the source area being changed, for example `packages/aikit/test/stream.test.ts` for streaming behavior. Run `pnpm test` before opening a PR and use package-scoped test commands while iterating.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit style with optional package scopes, for example `feat(aikit): ...`, `fix(aikit): ...`, and `chore: ...`. Keep commit subjects imperative and concise.

PRs should describe the behavior change, list affected packages, and include test evidence such as `pnpm test` or `pnpm --filter ... test` output. Link related issues when applicable. Screenshots are only useful for docs or asset updates; library API changes should include code samples instead.

## Releasing

Publishable packages (`@codeworksh/aikit`, `@codeworksh/sdk`) each own their release scripts; the root exposes `*:aikit` / `*:sdk` aliases so every command works from the repo root or from inside the package. Versioning uses `bumpp`, configured per package in `bump.config.ts` (tags follow `@codeworksh/<pkg>@<version>` and pushing is disabled). Build + publish run through `scripts/publish.js`, which builds, rewrites the manifest, and publishes from a temp dir. Pushing and publishing stay manual.

Flow (shown for `aikit`; substitute `sdk` as needed):

1. Update `CHANGELOG.md` — move the entry from `[Unreleased]` into a versioned section.
2. `pnpm bump:aikit` (or `pnpm run bump` inside `packages/aikit`): pick the bump; it commits and tags `@codeworksh/aikit@<version>` without pushing.
3. `git push && git push --tag`.
4. `pnpm release:aikit:dry` to preview the tarball, then `pnpm release:aikit` to publish. Use `pnpm release:aikit:dev` for a prerelease under the `dev` dist-tag.

Inside a package, drop the `:aikit` suffix: `pnpm run bump`, `pnpm run release:dry`, `pnpm run release:dev`, `pnpm run release`.

## Security & Configuration Tips

Do not commit secrets. Provider keys such as `ANTHROPIC_API_KEY` should come from the environment. Treat `models.json` and provider integrations as compatibility-sensitive files and note any downstream impact when changing them.
