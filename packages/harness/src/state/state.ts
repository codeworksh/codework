/*
 * @file Runtime state snapshot for one exchange.
 *
 * State.Snapshot answers "what is this agent, right now": its system prompt, its tool
 * set, and the provider options a request is built from. It is captured once per
 * exchange and pinned for every turn inside it, so a turn's continuations all
 * see the same prompt and the same tools.
 *
 * State.Snapshot should read the mount; it never acquires one. `snapshot` therefore declares
 * `SandboxIO.Provides | Location.Service` in its requirements, which makes
 * "mount first" a type-level fact: the method cannot be called outside a session
 * drain.
 */

import type { Model, Protocol } from "@codeworksh/aikit";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { Event } from "../event/event.ts";
import { makeEvents, type PromptResolver } from "../plugin/context.ts";
import { run as setup } from "../plugin/host.ts";
import type { Plugin } from "../plugin/plugin.ts";
import { LLM } from "../runner/llm.ts";
import type { Runner } from "../runner/run.ts";
import { Location } from "../location/location.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { SessionRuntime } from "../session/runtime.ts";
import type { ID as SessionId } from "../session/schema.ts";
import { merge } from "../settings/merge.ts";
import { compose, resolveOptions } from "../settings/resolve.ts";
import type { Block } from "../settings/schema.ts";
import { Settings } from "../settings/settings.ts";
import type { Resolved } from "../tools/registry.ts";

/**
 * How a turn's tool calls are scheduled once the array has been re-read.
 *
 * Pinned in the snapshot so a configuration change cannot switch scheduling
 * halfway through an exchange. State supplies the value; Loop implements it.
 */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Everything a caller may legally inject into aikit's
 * `stream(model, context, options)`.
 *
 * aikit's bag is generic per protocol (`Protocol.OptionsFor<TProtocol>`); this is
 * the erased form, the same move the tool registry makes when it discharges a
 * tool's capability `R`. Four fields are excluded:
 *
 * - `signal` -- `LLM.run` binds it to the scope that aborts the transport on
 *   interruption. A caller value would silently break cancellation.
 * - `sessionId` -- Loop owns it.
 * - `reasoning` -- this *is* the thinking level. Exposing it alongside
 *   `thinkingLevel` would be two spellings of one value, free to drift.
 * - `modelId` -- duplicates {@link Options.model}.
 *
 * Note: keep options in sync with aikit see @codeworksh/aikit
 */
export type RequestOptions = Omit<Protocol.CommonOptions, "signal" | "sessionId" | "reasoning"> & {
	readonly baseURL?: string;
	readonly method?: Model.APIMethodEnum;
	readonly toolChoice?: unknown;
	readonly activeTools?: ReadonlyArray<string>;
	readonly factoryOptions?: Record<string, unknown>;
	readonly providerOptions?: Record<string, Record<string, unknown>>;
};

export interface Options extends RequestOptions {
	/** Optional caller inputs interpreted by prompt plugins. */
	readonly promptCustom?: string | PromptResolver;
	readonly promptSystemAppend?: string | PromptResolver;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly toolExecution?: ToolExecutionMode;
}

/**
 * Exchange plugin setup failed.
 *
 * Typed rather than a defect: a caller's callback failing is a caller bug, but it
 * is one the session should report and survive rather than crash on. The turn
 * fails before any provider request goes out.
 */
export class SnapshotError extends Schema.TaggedError<SnapshotError>()("State.SnapshotError", {
	sessionId: Schema.String,
	reason: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * Immutable runtime state for one exchange.
 *
 * `tools.handle` is executable, and that is deliberate: the definitions the model
 * is shown, the wire schemas it is given, and the handlers that run all come from
 * one resolved registry. Splitting them would let the advertised set drift from
 * the executed one.
 *
 * Not durable and not serializable. It holds no mutable refs and owns no
 * lifecycle -- the mount it reads outlives it.
 */
export interface Snapshot {
	readonly sessionId: SessionId;
	readonly sandbox: SandboxIO.Identity;
	readonly location: Location.Info;
	readonly systemPrompt: string;
	readonly tools: Resolved;
	readonly provider: string;
	readonly model: string;
	readonly resolvedModel: Model.Info;
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly request: RequestOptions;
	/** Matched file attributes used to construct provider requests. */
	readonly settings: Block;
	readonly toolExecution: ToolExecutionMode;
}

export interface Interface {
	/**
	 * Capture runtime state for one exchange. Called inside a session drain,
	 * where the mount it reads is already open.
	 */
	readonly snapshot: (
		sessionId: SessionId,
	) => Effect.Effect<
		Snapshot,
		SnapshotError | Runner.ModelCatalogError | Runner.ModelNotFoundError | Runner.ProviderError,
		SandboxIO.Provides | Location.Service
	>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/state/state/Service") {}

const resolver = (input: string | PromptResolver): PromptResolver => (typeof input === "string" ? () => input : input);

/**
 * `plugins` is the prepared, ordered list — resolved once during harness construction
 * (`plugin/catalog.ts`). State runs it as given: no insertion, reordering, or rerun, and no
 * default of its own.
 */
export const layer = (options: Options, plugins: ReadonlyArray<Plugin>) => {
	return Layer.effect(
		Service,
		Effect.gen(function* () {
			const runtime = yield* SessionRuntime.Service;
			const settings = yield* Settings.Service;
			const events = makeEvents(yield* Event.Service);
			return Service.of({
				snapshot: Effect.fn("State.snapshot")(function* (sessionId: SessionId) {
					const sessionOptions = Option.getOrElse(yield* runtime.get(sessionId), () => ({}));
					const loadedSettings = yield* settings.load;
					const configured = compose(loadedSettings, options, sessionOptions);
					const {
						promptCustom,
						promptSystemAppend,
						provider: _provider,
						model: _model,
						thinkingLevel: _thinkingLevel,
						toolExecution: _toolExecution,
						...rest
					} = configured.runtime;
					const { provider, model, thinkingLevel, toolExecution } = configured;
					const request = merge(resolveOptions(configured.block), rest);
					const sandbox = yield* SandboxIO.Current;
					const location = yield* Location.Service;

					const resolvedModel = yield* LLM.resolve({ provider, model, settings: configured.block });
					const contributions = yield* setup(plugins, {
						sessionId,
						sandbox,
						location,
						settings: loadedSettings,
						model: resolvedModel,
						events,
						config: {
							...(promptCustom === undefined ? {} : { promptCustom: resolver(promptCustom) }),
							...(promptSystemAppend === undefined ? {} : { promptSystemAppend: resolver(promptSystemAppend) }),
						},
					}).pipe(Effect.mapError((cause) => new SnapshotError({ sessionId, reason: cause.message, cause })));

					return {
						sessionId,
						sandbox,
						location,
						...contributions,
						provider,
						model,
						resolvedModel,
						thinkingLevel,
						request,
						settings: configured.block,
						toolExecution,
					} satisfies Snapshot;
				}),
			});
		}),
	);
};

export * as State from "./state.ts";
