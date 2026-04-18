# Changelog

This file is the canonical source for unreleased changes and published release notes for the codework.

## Format

- Add in-progress work under `## [Unreleased]`.
- Move shipped changes into a versioned release section when publishing.
- Prefer these labels when writing release notes: `Added`, `Changed`, `Fixed`, `Removed`, `Internal`, `Breaking Changes`, `Reverted`.
- Keep entries user-facing where possible. Use `Internal` for refactors, tooling, and package housekeeping.

## [Unreleased]

## [@codeworksh/aikit@0.3.1]

### Added

- Added OpenAI Completions API support to `@codeworksh/aikit`, including streaming responses, tool-call handling, and compatibility switches for OpenAI-compatible providers.

### Changed

- Extended the model and provider registry to support runtime protocol overrides and custom model transforms for future provider-specific expansion.
- Updated the `exa` example to run against the OpenAI completions flow and simplified example result rendering to reduce response noise.

### Fixed

- Fixed TypeScript issues around the new OpenAI completions integration.
- Fixed base URL handling for OpenAI-compatible completions providers, including canonical fallback behavior when the catalog omits an explicit OpenAI base URL.

## [@codeworksh/aikit@0.3.0]

### Added

- Added Code Mode to `@codeworksh/aikit` with TypeScript system-prompt stubs and the `sandbox_execute_typescript` tool.
- Added a QuickJS-WASI sandbox driver for executing generated TypeScript code.
- Added the [`codemode-finance-csv` example](./packages/aikit/examples/codemode-finance-csv/README.md) showing Code Mode over a typed CSV-backed finance workflow.

### Changed

- Updated Code Mode to use pluggable drivers via `CodeMode.create({ driver, tools })`.
- Exposed first-party Code Mode drivers from `@codeworksh/aikit/codemode/drivers`.
- Updated `aikit` packaging so examples consume built package artifacts like external apps instead of bundling workspace source.

### Internal

- Added runtime and live-agent test coverage for Code Mode, sandbox execution, and tool bindings.
- Updated package publishing and subpath build outputs to support dedicated Code Mode driver artifacts.

## [@codeworksh/aikit@0.2.1]

### Added

- Generated stable message IDs so messages keep a consistent identifier through creation and follow-up updates.

### Changed

- Updated message-part mutation and update flows to target message IDs, making streamed and incremental assistant updates more reliable.
- Reduced the exposed public API surface to keep internals out of the package contract.

### Internal

- Applied general package cleanup as part of the patch release.

## [@codeworksh/aikit@0.2.0]

### Added

- Introduced the core AI toolkit with agent loops, streaming, message primitives, model catalog support, provider abstractions, and an Anthropic provider.
- Added a stateful `Agent.create(...)` instance API on top of the core loop.
- Expanded package coverage with tests for public API behavior, instance state, loop continuation, and self-contained test paths.

### Changed

- Standardized runtime and stream event names to dot notation for a more consistent public API.
- Improved async agent emit flow and `run` or continue-loop behavior.
- Simplified internal generic usage while keeping the public tool authoring API ergonomic, including cleaner `Message.defineTool(...)` and `Agent.defineTool(...)` patterns.

### Fixed

- Fixed state persistence so tool-driven mutations continue to update assistant messages after `message.end`.

### Internal

- Applied Vite+-driven lint cleanup across provider and stream internals.

## [@codeworksh/utils@0.1.1]

### Added

- Added the shared utilities package for reusable filesystem, lazy evaluation, async, and runtime helpers.

### Changed

- Aligned package metadata and workspace setup for npm publishing as part of monorepo release preparation.

### Internal

- Carried the package through the Bun-to-Vite+ workspace migration and package rename cleanup reflected in repository history.

## [Setup]

### Added

- Bootstrapped the workspace with the initial `aikit` and shared utilities packages.
- Added top-level documentation, the project logo, the repository license, and `AGENTS.md`.

### Changed

- Prepared the workspace for npm publishing and cleaned up package naming and dependency metadata.
- Migrated the repo from Bun and Biome-based tooling to `pnpm` with `vite-plus` and an ESM-first configuration.

### Internal

- Pinned the root `vite-plus` version and tightened the publishing pipeline for package releases.
