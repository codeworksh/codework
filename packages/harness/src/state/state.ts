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
import { Context as SessionContext } from "../context/context.ts";
import { Location } from "../location/location.ts";
import { SandboxIO } from "../sandbox/io.ts";
import { bashTool } from "../tools/bash.ts";
import { make as makeRegistry, type Resolved } from "../tools/registry.ts";
import { fromSandboxShell } from "../tools/shell.ts";
import * as Tool from "../tools/tool.ts";
import type { ID as SessionId } from "../session/schema.ts";
import { SessionRuntime } from "../session/runtime.ts";
import { StatePrompt } from "./prompt.ts";

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
	/** Replaces the default foundation prose. */
	readonly promptCustom?: string;
	/** Appended after the rendered tool sections. */
	readonly promptSystemAppend?: string;
	/** Owns the final prompt outright. Sync or async. */
	readonly promptSystemOverride?: StatePrompt.PromptSystemOverride;
	/**
	 * Registered after the built-in Bash tool, so the registry's
	 * last-registration-wins rule lets a caller intentionally replace Bash by
	 * name.
	 *
	 * TODO(sanchitrk): check if our assumption is correct here? overriding with same name allowed.
	 * requires fixing if needed within tool registry
	 */
	readonly tools?: ReadonlyArray<Tool.RegisteredTool>;
	/** Built-in tool names enabled for this session. Omitted keeps the Bash default. */
	readonly builtinTools?: ReadonlyArray<"bash">;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: Model.ThinkingLevel;
	readonly toolExecution?: ToolExecutionMode;
}

/**
 * FIXME(sanchitrk): read from settings config once we set that up;
 *
 * Defaults. `maxTokens` is deliberately absent: aikit's `stream()` already calls
 * `applyDefaultMaxTokens`, which derives it from the model's own `maxTokens` and
 * `contextWindow`. Setting one here would override a model-aware value with a
 * fixed guess.
 */
export const defaults = {
	provider: "openai",
	model: "gpt-5.5",
	thinkingLevel: "medium",
	toolExecution: "sequential",
	timeoutMs: 60_000,
	maxRetries: 0,
} as const satisfies {
	readonly provider: string;
	readonly model: string;
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly toolExecution: ToolExecutionMode;
	readonly timeoutMs: number;
	readonly maxRetries: number;
};

/**
 * The prompt override threw or rejected.
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
	readonly thinkingLevel: Model.ThinkingLevel;
	readonly request: RequestOptions;
	readonly toolExecution: ToolExecutionMode;
}

export interface Interface {
	/**
	 * Capture runtime state for one exchange. Called inside a session drain,
	 * where the mount it reads is already open.
	 */
	readonly snapshot: (
		sessionId: SessionId,
	) => Effect.Effect<Snapshot, SnapshotError | SessionContext.ContextReadError, SandboxIO.Provides | Location.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@codeworksh/harness/state/state/Service") {}

/**
 * Run a caller's override, converting a synchronous throw or a rejected promise
 * into {@link SnapshotError}.
 */
const applyOverride = Effect.fn("State.applyOverride")(function* (
	sessionId: SessionId,
	override: StatePrompt.PromptSystemOverride,
	input: StatePrompt.PromptSystemOverrideInput,
) {
	const fail = (cause: unknown) =>
		new SnapshotError({
			sessionId,
			reason: "`promptSystemOverride` callback failed",
			cause,
		});
	const result = yield* Effect.try({
		try: () => override(input),
		catch: fail,
	});
	if (typeof result === "string") return result;
	return yield* Effect.tryPromise({ try: () => result, catch: fail });
});

export const layer = (options: Options = {}) => {
	return Layer.effect(
		Service,
		Effect.gen(function* () {
			const runtime = yield* SessionRuntime.Service;
			const contexts = yield* SessionContext.Service;
			return Service.of({
				snapshot: Effect.fn("State.snapshot")(function* (sessionId: SessionId) {
					const sessionOptions = Option.getOrElse(yield* runtime.get(sessionId), () => ({}));
					const durable = (yield* contexts.assemble(sessionId)).config;
					const merged = { ...options, ...sessionOptions };
					const {
						promptCustom,
						promptSystemAppend,
						promptSystemOverride,
						tools: callerTools = [],
						builtinTools = ["bash"],
						provider: runtimeProvider,
						model: runtimeModel,
						thinkingLevel: runtimeThinkingLevel,
						toolExecution = defaults.toolExecution,
						...rest
					} = merged;
					const provider = runtimeProvider ?? durable.model?.providerId ?? defaults.provider;
					const model = runtimeModel ?? durable.model?.modelId ?? defaults.model;
					const thinkingLevel = runtimeThinkingLevel ?? durable.thinkingLevel ?? defaults.thinkingLevel;
					const request: RequestOptions = {
						timeoutMs: defaults.timeoutMs,
						maxRetries: defaults.maxRetries,
						...rest,
					};
					const sandbox = yield* SandboxIO.Current;
					const location = yield* Location.Service;

					/*
					 * Bash is bound to the shell of the mount that is open right now.
					 * `ToolShell.local()` would look equivalent and be wrong: it executes on
					 * the host, bypassing whichever in-memory or remote namespace the session
					 * actually selected.
					 *
					 * Capturing the service and re-providing it keeps the binding valid for
					 * the whole exchange -- the drain owns the mount for longer than any turn
					 * inside it, so a handler captured here is still executable when a later
					 * turn calls it.
					 */
					const shell = yield* SandboxIO.Shell;
					const mountedShell = fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxIO.Shell, shell)));

					// Bash first, caller tools after: last registration wins, so a caller can
					// replace Bash by name on purpose.
					const builtins = builtinTools.includes("bash") ? [Tool.provide(bashTool, mountedShell)] : [];
					const registry = makeRegistry([...builtins, ...callerTools]);
					const resolved = registry.resolve();

					const rendered = StatePrompt.build({
						tools: resolved.defs,
						directory: location.directory,
						...(promptCustom === undefined ? {} : { promptCustom }),
						...(promptSystemAppend === undefined ? {} : { promptSystemAppend }),
					});

					const systemPrompt =
						promptSystemOverride === undefined
							? rendered
							: yield* applyOverride(sessionId, promptSystemOverride, {
									systemPrompt: rendered,
									tools: resolved.defs,
									sandbox,
									location,
									provider,
									model,
									thinkingLevel,
									toolExecution,
								});

					return {
						sessionId,
						sandbox,
						location,
						systemPrompt,
						tools: resolved,
						provider,
						model,
						thinkingLevel,
						request,
						toolExecution,
					} satisfies Snapshot;
				}),
			});
		}),
	);
};

export * as State from "./state.ts";
