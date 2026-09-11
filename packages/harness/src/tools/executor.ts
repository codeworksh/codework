import type { ToolRegistration } from "../plugin/tool/registry.ts";
import type { HookReturn, ToolAfterResult, ToolBefore } from "../plugin/tool/schema.ts";
import { Message } from "@codeworksh/aikit";
import { Cause, Duration, Effect, Exit, Fiber, Option, Queue, Ref, Result, Schedule, Schema, Scope } from "effect";
import { ToolExecutionError } from "./error.ts";
import { ToolProgress, type ToolProgressPartial } from "./progress.ts";
import { type AnyToolDef, type ModelContent, type RegisteredTool, toAikitTool, type ToolCallContext } from "./tool.ts";

/**
 * `ToolExecutor` — the uniform pipeline run for every tool call:
 *
 *   resolve def → decode args → before → handler (scoped, exit) →
 *   encode / normalize terminal → after → apply result patch.
 *
 * Tool handlers never touch event plumbing or aikit message shapes. The executor owns
 * the whole pending → terminal value transition. Result mapping:
 *   - success            → completed   (content + encoded details)
 *   - declared failure   → error       (content + encoded details), fed to the model
 *   - interruption       → aborted
 *   - undeclared / defect → error terminal
 */

/** A complete terminal tool-call part, ready for persistence and event publication. */
export type ToolOutcome = Message.ToolCallTerminalPart;

/** One progress emission handed to an observer, including the complete running part. */
export interface ProgressEvent {
	readonly partial: ToolProgressPartial;
	readonly toolCall: Message.ToolCallRunningPart;
	readonly ctx: ToolCallContext;
}

/**
 * Per-call execution options (owned here; the registry only forwards them). Progress is
 * best-effort UI telemetry — see the `handle` progress path in {@link make}.
 */
export interface HandleOptions<RProgress = never, EProgress = never> {
	readonly sessionId?: ToolBefore["sessionId"];
	readonly messageId?: ToolBefore["messageId"];
	/** Sliding-queue capacity for best-effort progress. Bounded default (64); tunable. */
	readonly progressBuffer?: number;
	/**
	 * On NORMAL completion, how long to let the sink flush the queue backlog before the scope
	 * closes and the drain fiber stops (default 3s). Ignored on interruption — abort stays snappy.
	 */
	readonly progressDrainGrace?: Duration.Input;
	/**
	 * Best-effort progress observer, drained on a scoped background fiber — never in the tool
	 * hot path. It MAY fail and MAY require services (`RProgress`): failures are logged/dropped,
	 * and intermediate updates may be dropped under load. Not part of tool correctness.
	 */
	readonly onProgress?: (event: ProgressEvent) => Effect.Effect<void, EProgress, RProgress>;
}

export interface Executor {
	/** aikit wire view of the tool set, for the loop context (`convertTools`). */
	readonly wire: Message.Tool[];
	/**
	 * Atomically transform one complete pending tool-call part into a complete terminal
	 * part. Most failures become a terminal
	 * `ToolOutcome`; declared failures retain their encoded details, while undeclared
	 * failures/defects become error terminals.
	 *
	 * Tools enter as {@link RegisteredTool}s (capability `R` already discharged at
	 * registration), so the only requirement left in the result is a progress sink's own
	 * `RProgress`. `options.onProgress` observes live progress off the hot path.
	 */
	readonly handle: <RProgress = never, EProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress, EProgress>,
	) => Effect.Effect<ToolOutcome, never, RProgress>;
}

/** Default sliding-queue capacity for best-effort progress. */
const DEFAULT_PROGRESS_BUFFER = 64;
/** How long, on normal completion, to let a progress sink flush the backlog before teardown. */
const DEFAULT_DRAIN_GRACE: Duration.Input = Duration.seconds(3);
/** Poll interval while waiting for the progress queue to drain. */
const DRAIN_POLL: Duration.Input = Duration.millis(20);

// Erase a schema's services to `never` for decode/encode. Sound for tool schemas
// (none require services) and keeps the executor's `R` clean of schema services.
const asCodec = (schema: AnyToolDef["parameters"]): Schema.Codec<unknown, unknown> =>
	schema as unknown as Schema.Codec<unknown, unknown>;

const text = (value: string): Message.TextContent => ({ type: "text", text: value });
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const jsonText = (value: unknown): Effect.Effect<Message.TextContent> =>
	encodeUnknownJson(value).pipe(Effect.orDie, Effect.map(text));

const endTime = (call: Message.ToolCallPendingPart, now: number) => Math.max(call.time.end, now);
const result = <IsError extends boolean>(content: ModelContent, isError: IsError, details?: unknown) => ({
	content: [...content],
	...(details === undefined ? {} : { details }),
	isError,
});

const completed = (
	call: Message.ToolCallPendingPart,
	content: ModelContent,
	now: number,
	details?: unknown,
): ToolOutcome => ({
	...call,
	status: "completed",
	result: result(content, false, details),
	time: { ...call.time, end: endTime(call, now) },
});
const errored = (
	call: Message.ToolCallPendingPart,
	content: ModelContent,
	now: number,
	details?: unknown,
): ToolOutcome => ({
	...call,
	status: "error",
	result: result(content, true, details),
	time: { ...call.time, end: endTime(call, now) },
});
const aborted = (
	call: Message.ToolCallPendingPart,
	content: ModelContent,
	now: number,
	details?: unknown,
): ToolOutcome => ({
	...call,
	status: "aborted",
	result: result(content, true, details),
	time: { ...call.time, end: endTime(call, now) },
});

const running = (
	call: Message.ToolCallPendingPart,
	partial: ToolProgressPartial,
	now: number,
): Message.ToolCallRunningPart => ({
	...call,
	status: "running",
	partial: {
		...(partial.content === undefined ? {} : { content: [...partial.content] }),
		...(partial.details === undefined ? {} : { details: partial.details }),
	},
	time: { ...call.time, end: endTime(call, now) },
});

const encodeOutcome = (
	def: AnyToolDef,
	call: Message.ToolCallPendingPart,
	exit: Exit.Exit<unknown, ToolExecutionError>,
	latest: Ref.Ref<Option.Option<ToolProgressPartial>>,
): Effect.Effect<ToolOutcome> =>
	Effect.gen(function* () {
		if (Exit.isSuccess(exit)) {
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.success))(exit.value).pipe(Effect.orDie);
			const content = def.encodeContent ? def.encodeContent(exit.value) : [yield* jsonText(encoded)];
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			return completed(call, content, now, encoded);
		}

		const cause = exit.cause;
		if (Cause.hasInterrupts(cause)) {
			// Surface whatever the tool last reported via ToolProgress, so an aborted
			// streaming command still shows the output it produced before the interrupt.
			const last = yield* Ref.get(latest);
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			if (Option.isSome(last) && last.value.content !== undefined && last.value.content.length > 0) {
				return aborted(call, [...last.value.content], now, last.value.details);
			}
			return aborted(call, [text("Tool Call Aborted.")], now);
		}

		const executionError = Cause.findErrorOption(cause);
		if (Option.isSome(executionError)) {
			const failure = executionError.value.cause;
			if (def.failure === undefined || !Schema.is(asCodec(def.failure))(failure)) {
				return yield* Effect.die(failure);
			}
			// Encode declared failures as model-facing tool error results.
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.failure))(failure).pipe(Effect.orDie);
			const content = def.encodeFailureContent ? def.encodeFailureContent(failure) : [yield* jsonText(encoded)];
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			return errored(call, content, now, encoded);
		}

		// The execution boundary below normalizes undeclared failures and defects for after.
		return yield* Effect.die(Cause.squash(cause));
	});

class HookExecutionError extends Schema.TaggedError<HookExecutionError>()("HookExecutionError", {
	cause: Schema.Unknown,
}) {}

/** Invoke author callbacks only when the returned Effect runs. */
const invoke = <A>(callback: () => HookReturn<A>): Effect.Effect<A | void, HookExecutionError> =>
	Effect.suspend(() => {
		const value = callback();
		if (Effect.isEffect(value)) {
			const result: Effect.Effect<A | void, unknown> = value;
			// Normalize arbitrary plugin errors at the executor boundary.
			// @effect-diagnostics-next-line anyUnknownInErrorContext:off
			return result.pipe(Effect.mapError((cause) => new HookExecutionError({ cause })));
		}
		if (value instanceof Promise)
			return Effect.tryPromise({ try: () => value, catch: (cause) => new HookExecutionError({ cause }) });
		return Effect.succeed(value);
	});

const failureOutcome = (call: Message.ToolCallPendingPart, cause: Cause.Cause<unknown>, phase: string) =>
	Effect.map(
		Effect.clockWith((clock) => clock.currentTimeMillis),
		(now) => errored(call, [text(`${phase}: ${Cause.pretty(cause)}`)], now),
	);

const patchOutcome = (terminal: ToolOutcome, patch: ToolAfterResult | void): ToolOutcome => {
	if (!patch || (terminal.status !== "completed" && terminal.status !== "error")) return terminal;
	const isError = patch.isError ?? terminal.result.isError;
	return {
		...terminal,
		status: isError ? "error" : "completed",
		result: {
			...terminal.result,
			...(patch.content === undefined ? {} : { content: [...patch.content] }),
			...(patch.details === undefined ? {} : { details: patch.details }),
			isError,
		},
	} as ToolOutcome;
};

const ABORT_HOOK_GRACE = Duration.seconds(1);

/**
 * Build an executor over a set of {@link RegisteredTool}s — tools whose capability `R` was
 * already discharged at registration (`Tool.provide`). The executor therefore needs no tool
 * `R`; only a progress sink's `RProgress` (if any) surfaces from `handle`.
 */
export const make = (tools: ReadonlyArray<RegisteredTool | ToolRegistration>): Executor => {
	const impls = new Map<string, ToolRegistration>();
	for (const item of tools) {
		const entry = "tool" in item ? item : { tool: item, hooks: {} };
		const name = entry.tool.definition.name;
		// Fail fast: a duplicate name would expose two tools on the wire but only
		// run the last-registered handler.
		if (impls.has(name)) {
			throw new Error(`Executor.make: duplicate tool name "${name}" — tool names must be unique.`);
		}
		impls.set(name, entry);
	}

	const wire = [...impls.values()].map(({ tool }) => toAikitTool(tool.definition));

	const handle = <RProgress = never, EProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress, EProgress>,
	): Effect.Effect<ToolOutcome, never, RProgress> =>
		Effect.gen(function* () {
			const entry = impls.get(call.name);
			if (entry === undefined) {
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return errored(call, [text(`Unknown tool: ${call.name}`)], now, {
					error: "unknown_tool",
					name: call.name,
				});
			}
			const { tool: impl, hooks } = entry;
			const def = impl.definition;

			const decoded = yield* Effect.result(Schema.decodeEffect(asCodec(def.parameters))(call.arguments));
			if (Result.isFailure(decoded)) {
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return errored(call, [text(`Invalid arguments for ${call.name}: ${decoded.failure.message}`)], now, {
					error: "invalid_arguments",
					name: call.name,
				});
			}

			const ctx: ToolCallContext = { callID: call.callID, toolName: call.name, rawArgs: call.arguments };

			const hasHooks = hooks.beforeToolCall !== undefined || hooks.afterToolCall !== undefined;
			if (hasHooks && (options?.sessionId === undefined || options.messageId === undefined)) {
				return yield* Effect.die(new Error("Hooked tools require sessionId and messageId"));
			}
			const hookCall: ToolBefore | undefined =
				options?.sessionId !== undefined && options.messageId !== undefined
					? { ...ctx, sessionId: options.sessionId, messageId: options.messageId, params: decoded.success }
					: undefined;
			if (hooks.beforeToolCall && hookCall) {
				const before = yield* invoke(() => hooks.beforeToolCall!(hookCall)).pipe(Effect.exit);
				if (Exit.isFailure(before)) {
					if (Cause.hasInterrupts(before.cause))
						return yield* Effect.failCause(before.cause as Cause.Cause<never>);
					return yield* failureOutcome(call, before.cause, "beforeToolCall failed");
				}
				if (before.value?.block) {
					const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
					return errored(call, [text(before.value.reason || "Tool execution was blocked")], now);
				}
			}

			// Latest partial: captured for aborted-call output regardless of any sink.
			const latest = yield* Ref.make(Option.none<ToolProgressPartial>());
			let handlerStarted = false;
			let afterStarted = false;
			const notifyAbort = Effect.fn("ToolExecutor.notifyAbort")(function* (terminal: ToolOutcome) {
				if (!handlerStarted || afterStarted || !hooks.afterToolCall || !hookCall) return;
				afterStarted = true;
				const callback = hooks.afterToolCall;
				const fiber = yield* invoke(() => callback({ ...hookCall, terminal })).pipe(
					Effect.interruptible,
					Effect.timeout(ABORT_HOOK_GRACE),
					Effect.catchCause((cause) =>
						Effect.logWarning("afterToolCall abort notification failed", Cause.pretty(cause)),
					),
					Effect.forkChild({ startImmediately: true }),
				);
				yield* Fiber.join(fiber);
			});
			const execute = Effect.gen(function* () {
				// True while an onProgress write is in flight, so "drained" means the queue is empty
				// AND the last sink write finished — not merely dequeued.
				const activeProgress = yield* Ref.make(false);

				const onProgress = options?.onProgress;
				const progressQueue = onProgress
					? yield* Queue.sliding<ProgressEvent>(options?.progressBuffer ?? DEFAULT_PROGRESS_BUFFER)
					: undefined;

				// Best-effort delivery off the hot path: swallow (log-drop) sink failures, never fail the
				// tool. This is the only place onProgress runs, so its RProgress/error live here. Typed
				// explicitly so `RProgress` is pinned through `Effect.gen`'s requirement inference.
				const forkDrain: Effect.Effect<void, never, RProgress | Scope.Scope> =
					progressQueue && onProgress
						? Queue.take(progressQueue).pipe(
								Effect.flatMap((event) =>
									Ref.set(activeProgress, true).pipe(
										Effect.andThen(onProgress(event).pipe(Effect.ignore)),
										Effect.ensuring(Ref.set(activeProgress, false)),
									),
								),
								Effect.forever,
								Effect.forkScoped,
								Effect.asVoid,
							)
						: Effect.void;
				yield* forkDrain;

				// report is fast + infallible: set latest, then a non-blocking offer (sliding drops the
				// oldest when full). No sink latency reaches the tool.
				const report = Effect.fn("ToolExecutor.reportProgress")(function* (partial: ToolProgressPartial) {
					yield* Ref.set(latest, Option.some(partial));
					if (progressQueue === undefined) return;
					const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
					yield* Queue.offer(progressQueue, { partial, toolCall: running(call, partial, now), ctx });
				});
				const progress = ToolProgress.of({ report });

				// The handler keeps its OWN inner scope, so its resources release the moment it finishes
				// — not after the drain grace (which is bounded by the outer `Effect.scoped` below).
				handlerStarted = true;
				const exit = yield* Effect.suspend(() => impl.handler(decoded.success, ctx)).pipe(
					Effect.scoped,
					Effect.provideService(ToolProgress, progress),
					Effect.exit,
				);

				// Graceful bounded drain on NORMAL completion: wait until the queue is empty AND no sink
				// write is in flight, bounded by progressDrainGrace. Skipped on interruption (snappy abort).
				const interrupted = Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause);
				if (progressQueue && !interrupted) {
					const drained = Effect.gen(function* () {
						const size = yield* Queue.size(progressQueue);
						const active = yield* Ref.get(activeProgress);
						return size === 0 && !active;
					});
					yield* drained.pipe(
						Effect.repeat({ schedule: Schedule.spaced(DRAIN_POLL), until: (done) => done }),
						Effect.timeout(options?.progressDrainGrace ?? DEFAULT_DRAIN_GRACE),
						Effect.ignore,
					);
				}

				return yield* encodeOutcome(def, call, exit, latest).pipe(
					Effect.catchCause((cause) =>
						Cause.hasInterrupts(cause)
							? Effect.failCause(cause as Cause.Cause<never>)
							: failureOutcome(call, cause, "Tool execution failed"),
					),
				);
			}).pipe(Effect.scoped);
			return yield* execute.pipe(
				Effect.flatMap((terminal) => {
					if (terminal.status === "aborted")
						return notifyAbort(terminal).pipe(Effect.uninterruptible, Effect.as(terminal));
					if (!hooks.afterToolCall || !hookCall) return Effect.succeed(terminal);
					const callback = hooks.afterToolCall;
					return Effect.suspend(() => {
						afterStarted = true;
						return invoke(() => callback({ ...hookCall, terminal })).pipe(
							Effect.map((patch) => patchOutcome(terminal, patch)),
							Effect.catchCause((cause) =>
								Cause.hasInterrupts(cause)
									? Effect.failCause(cause as Cause.Cause<never>)
									: failureOutcome(call, cause, "afterToolCall failed"),
							),
						);
					});
				}),
				Effect.onExit((exit) =>
					Effect.gen(function* () {
						if (Exit.isSuccess(exit)) return;
						// A failing author finalizer can replace its interruption in Effect. Probe the
						// pending cancellation while cleanup coordination is protected, retaining both.
						const pending = yield* Effect.void.pipe(Effect.interruptible, Effect.exit);
						const cause = Exit.isFailure(pending) ? Cause.combine(exit.cause, pending.cause) : exit.cause;
						if (!Cause.hasInterrupts(cause)) return;
						yield* encodeOutcome(
							def,
							call,
							Exit.failCause(cause as Cause.Cause<ToolExecutionError>),
							latest,
						).pipe(Effect.flatMap(notifyAbort));
						if (!Cause.hasInterrupts(exit.cause)) return yield* Effect.failCause(cause);
					}),
				),
			);
		}).pipe(Effect.scoped);

	return { wire, handle };
};
