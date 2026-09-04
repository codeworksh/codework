# Changelog

This file is the canonical source for unreleased changes and published release notes for the codework.

## Format

- Add in-progress work under `## [Unreleased]`.
- Move shipped changes into a versioned release section when publishing.
- Prefer these labels when writing release notes: `Added`, `Changed`, `Fixed`, `Removed`, `Internal`, `Breaking Changes`, `Reverted`.
- Keep entries user-facing where possible. Use `Internal` for refactors, tooling, and package housekeeping.

## [Unreleased]

### Added

- Added context-aware response sizing: every request now measures what the conversation already costs and shrinks its output ceiling to what the context window can still hold, instead of asking for an answer that cannot fit.
- Added adaptive thinking for newer Claude models, which receive an effort level and size each turn's reasoning themselves rather than being pinned to a fixed token budget.
- Added `usage.cacheWrite1h`, the portion of a cache write made with 1h retention, where the provider reports the split.
- Added `isRecoverableLength`, which reports whether a length stop ended below the output limit that was actually requested, so callers can decide whether one compact-and-retry attempt is worthwhile.
- Added `compat.thinkingTokenBudgetField` and `compat.supportsThinkingTokenBudget`, letting an OpenAI-compatible endpoint declare the request field it takes a thinking-token budget in.
- Added `compat.forceAdaptiveThinking` to the generated catalog for Claude models that support it.
- Added native JSON Schema output support to the OpenAI Codex provider and a live Codex round-trip regression test.

### Changed

- Changed `maxTokens` to mean the room reserved for the answer. A thinking budget is added on top and the total is clamped to the model's ceiling, so raising the thinking level no longer silently shortens the answer.
- Changed default thinking budgets to fixed token counts per level (1024, 2048, 8192, 16384) rather than a fraction of each model's output ceiling, so one setting behaves the same across large and small models. `xhigh` and `max` inherit the `high` budget unless one is configured for them.
- Changed reasoning to be switched off explicitly when no thinking level is requested. Models that reason by default previously did so anyway, spending output tokens on reasoning the caller never asked for.
- Changed Google thinking configuration to use per-family token budgets, and to send a thinking level rather than a budget for the model families that take one.
- Aligned OpenAI Codex request shaping with the ChatGPT Codex backend: requests always disable storage, include encrypted reasoning content, and derive the prompt cache key from the provider session ID.

### Fixed

- Fixed an oversized thinking budget consuming the entire response. A budget that does not fit is now reduced, always leaving at least 1024 tokens for the answer, instead of shrinking the answer toward a single token.
- Fixed Anthropic requests counting the thinking budget twice, which inflated the requested ceiling and, with an explicit `maxTokens`, produced answers several times longer than asked for.
- Fixed a thinking budget below a provider's own minimum being sent as an enabled request, which the provider rejected outright. Thinking is now dropped for that turn instead, so a nearly full context still produces an answer.
- Fixed 1h cache writes being billed at the 5-minute rate. The 1h portion is now priced at twice the base input rate, correcting a roughly 37% understatement of cache-write cost whenever long cache retention is enabled.
- Fixed service-tier pricing being applied only to OpenAI Codex requests and being calculated from the tier requested rather than the tier the response was served at.
- Fixed rate-limit and throttling errors being misread as context overflow, which sent callers to compact a conversation that was never too long instead of retrying.
- Fixed context-overflow detection missing providers that truncate an oversized prompt to fit the window and then stop with no output, and broadened the recognized provider error messages.
- Fixed thinking-token budgets never reaching OpenAI-compatible endpoints that accept one.
- Fixed the default response ceiling being capped at a fixed 32000 tokens for models whose catalog output limit approaches their context window; the context-aware ceiling now decides.
- Replaced the OpenAI Codex SSE decoder with a standards-compliant parser, rejected streams that close before a terminal Responses event, and stopped accepting WebSocket-only completion events on the HTTP transport.
- Distinguished transient Codex rate limits from terminal plan and quota failures while preserving structured error codes, retry timing, and OpenAI request IDs.
- Restricted persisted OpenAI Codex OAuth credentials to owner-only file permissions and redacted token material from OAuth failure messages.

### Breaking Changes

- Changed the meaning of `maxTokens` from the whole response to the answer alone. A request that previously carved the thinking budget out of `maxTokens` now adds it on top, so responses can be longer than before at the same setting.
- Changed default thinking budgets to absolute token counts. On models with a large output ceiling these are substantially smaller than the previous proportional defaults; set `thinkingBudgets` explicitly to keep the old amounts.
- Changed requests without a thinking level to disable reasoning explicitly. Providers whose models reason by default will no longer do so unless a level is set.
- Removed the `store`, `include`, and `promptCacheKey` OpenAI Codex language-model options. These backend-required values are now controlled by the provider.
- Removed the unused agent lifecycle event protocol from the public `Event` namespace: `AgentEventType`, `AgentEventSchema`, `AgentEvent`, and the `tool.execution.start` / `tool.execution.update` / `tool.execution.end` types. LLM stream events (`LLMMessageEvent`) are unchanged.

### Internal

- Extracted thinking resolution, request pricing, and context estimation into `llm/thinking.ts`, `llm/pricing.ts`, and `utils/estimate.ts`, so each derivation from model metadata has one home and can be tested directly.
- Added `Model.optionsKey` as the single accessor for a model's provider option namespace, replacing a copy inside the streaming module.
- Surfaced the service tier a Codex response was served at in provider metadata, so a turn is priced by what it actually cost.
- Reorganized the OpenAI Codex unit tests by provider module and expanded live coverage for empty messages, response IDs, Unicode surrogate handling, incomplete tool-call histories, native grammar tools, and structured output using HTTP/SSE behavior as a reference.
- Renamed the Codex OAuth suite for clarity and added CLI coverage for credential status, refresh, and logout wiring.
- Removed unit coverage for the unused agent lifecycle event schemas.

## [@codeworksh/aikit@0.7.2]

### Added

- Added a provider-independent failure taxonomy with safe authentication, configuration, authorization, model availability, rate limit, quota, request, policy, timeout, transport, availability, response, and unknown failure categories.
- Added structured failure metadata to terminal assistant messages and exported the failure schemas and normalization helpers from `@codeworksh/aikit` and `@codeworksh/aikit/failure`.
- Added typed model-catalog load errors for missing, unreadable, empty, and invalid generated catalogs.

### Changed

- Changed model-catalog loading to report configuration failures instead of silently treating an unavailable catalog as empty.
- Standardized normalized provider error messages with lowercase opening prose and no terminal punctuation.

### Fixed

- Preserved safe provider status, code, request ID, retryability, and retry timing metadata without exposing request bodies, response bodies, or headers.
- Prevented the underlying AI SDK from logging raw provider exceptions before Aikit can return its normalized terminal failure event.

## [@codeworksh/aikit@0.7.1]

### Fixed

- Preserved native OpenAI Responses reasoning metadata across multi-turn requests so reasoning items replay without AI SDK `Non-OpenAI reasoning parts are not supported` warnings.
- Silently omitted legacy OpenAI reasoning parts whose replay metadata was already lost, matching the provider's existing behavior without emitting unusable-content warnings.

### Internal

- Added real API regression coverage for reasoning metadata persistence and replay with `openai/gpt-5.6-luna`.

## [@codeworksh/aikit@0.7.0]

### Added

- Added GPT-5.6 Luna, Sol, and Terra model metadata, reasoning levels, pricing, and OpenAI Codex OAuth support.
- Exported concrete pending, running, completed, error, skipped, aborted, and terminal tool-call part schemas and their corresponding TypeScript types.
- Added `skipped` and `aborted` support to the terminal `tool.execution.end` event contract.

### Changed

- Expanded the OpenAI Codex provider with deferred tools, replay metadata, usage reporting, and grammar-constrained custom tools.
- Preserved Aikit's existing tool-call event contract while adding the new Codex provider capabilities.
- Made tool execution lifecycle events self-contained: start, update, and end events now carry `messageId`, `partIndex`, and a complete pending, running, or terminal `toolCall` part.

### Breaking Changes

- Replaced the flattened `ToolCallInFlight` fields on `tool.execution.start`, `tool.execution.update`, and `tool.execution.end` with the complete tool-call part under `event.toolCall`. Consumers must read call identity and lifecycle data from `event.toolCall`.

## [@codeworksh/aikit@0.6.0]

### Added

- Added **OpenAI Codex** support: authenticate with a ChatGPT Plus/Pro subscription via OAuth (no API key required) and stream responses, tool calls, and reasoning through a dedicated provider. Adds the `openai-codex` protocol to the model catalog.
- Added the `aikit auth --openai-codex` CLI for managing Codex OAuth credentials, including `--status`, `--refresh`, and `--logout`.
- Added the `@codeworksh/aikit/oauth/openai/codex` subpath export exposing the OAuth client, credential storage, and authorization-flow helpers so the Codex login can be embedded in your own app or server callback route.

### Internal

- Reorganized the test suite into deterministic unit tests (`test/`) and opt-in live-provider end-to-end suites (`test/e2e/`, run via `pnpm test:e2e`), so the default `pnpm test` no longer calls paid provider APIs.
- Added offline unit coverage for streaming-JSON repair, Unicode surrogate sanitization, the event stream, context-overflow detection, usage and cost mapping, multi-model message transforms, model thinking-level resolution, and the Codex OAuth helpers.

## [@codeworksh/aikit@0.5.0]

### Added

- Added [documentation](https://codeworksh.github.io/aikit/) for the toolkit, including updated guides and examples.
- Replaced the custom LLM protocol with the Vercel AI SDK (`ai`, `@ai-sdk/*`). This serves as the new foundational layer for all model interactions, streaming, and provider routing, unlocking native support for Anthropic, Google, Google Vertex AI, OpenAI, xAI, OpenRouter, and other OpenAI-compatible APIs out of the box.

### Changed

- Standardized stream handling, tool calling, and messaging around the Vercel AI SDK primitives rather than maintaining a bespoke protocol.
- Improved test coverage across the package to ensure robust behavior with the new Vercel AI SDK integration.

### Fixed

- Addressed various TypeScript type mismatch issues regarding the model signatures and the newly integrated AI SDK objects.

### Breaking Changes

- The stateful `Agent` and higher-level agent wrapper modules have been completely removed to simplify the package's scope. The toolkit now focuses strictly on foundational AI capabilities, relying on the consumers to implement the stateful execution harness and specific agent loops.

## [@codeworksh/aikit@0.4.0]

### Added

- Added package-local build, lint, format, and test configuration for `@codeworksh/aikit` using `vite-plus`.

### Changed

- Migrated `@codeworksh/aikit` schemas and runtime validation to TypeBox 1.x.
- Replaced AJV-backed validation with TypeBox's built-in schema compiler and value parser.
- Updated message, event, model, stream, agent, and Code Mode schemas to use the TypeBox 1.x API shape.
- Updated the package export map for built ESM output, package metadata access, and local development resolution.
- Updated tests and examples to match the new TypeBox compiler behavior and dependency layout.

### Fixed

- Improved validation error formatting while preserving the received value in failure messages.
- Cached compiled validators to avoid recompiling schemas for repeated validation calls.

### Internal

- Removed direct AJV and `@sinclair/typebox` usage from `@codeworksh/aikit` in favor of `typebox`.
- Refined package metadata and release scripts for the next npm publish.

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
