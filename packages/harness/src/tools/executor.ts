import { Message } from "@codeworksh/aikit";
import { Cause, Duration, Effect, Exit, Option, Queue, Ref, Result, Schedule, Schema, Scope } from "effect";
import { ToolExecutionError } from "./error.ts";
import { ToolProgress, type ToolProgressPartial } from "./progress.ts";
import { type AnyToolDef, type ModelContent, type RegisteredTool, toAikitTool, type ToolCallContext } from "./tool.ts";

/**
 * `ToolExecutor` — the uniform pipeline run for every tool call:
 *
 *   resolve def → decode args (Effect Schema) → run handler (scoped, exit) →
 *   encode typed Success/Failure into aikit's message protocol → complete terminal part.
 *
 * Tool handlers never touch event plumbing or aikit message shapes. The executor owns
 * the whole pending → terminal value transition. Result mapping:
 *   - success            → completed   (content + encoded details)
 *   - declared failure   → error       (content + encoded details), fed to the model
 *   - interruption       → aborted
 *   - undeclared / defect → run error  (re-raised as a defect)
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
	 * `ToolOutcome`; a `failureMode: "error"` tool propagates a {@link ToolExecutionError}
	 * retaining its declared failure as `cause`, and undeclared failures/defects propagate as defects.
	 *
	 * Tools enter as {@link RegisteredTool}s (capability `R` already discharged at
	 * registration), so the only requirement left in the result is a progress sink's own
	 * `RProgress`. `options.onProgress` observes live progress off the hot path.
	 */
	readonly handle: <RProgress = never, EProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress, EProgress>,
	) => Effect.Effect<ToolOutcome, ToolExecutionError, RProgress>;
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
): Effect.Effect<ToolOutcome, ToolExecutionError> =>
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
			// A declared, expected failure. "error" opts it into the caller's error
			// channel as ToolExecutionError; "return" (default) encodes the original
			// failure into a model-facing tool error result.
			if (def.failureMode === "error") {
				return yield* executionError.value;
			}
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.failure))(failure).pipe(Effect.orDie);
			const content = def.encodeFailureContent ? def.encodeFailureContent(failure) : [yield* jsonText(encoded)];
			const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
			return errored(call, content, now, encoded);
		}

		// Undeclared failure or genuine defect → the loop is broken, not the tool.
		return yield* Effect.die(Cause.squash(cause));
	});

/**
 * Build an executor over a set of {@link RegisteredTool}s — tools whose capability `R` was
 * already discharged at registration (`Tool.provide`). The executor therefore needs no tool
 * `R`; only a progress sink's `RProgress` (if any) surfaces from `handle`.
 */
export const make = (tools: ReadonlyArray<RegisteredTool>): Executor => {
	const impls = new Map<string, RegisteredTool>();
	for (const tool of tools) {
		const name = tool.definition.name;
		// Fail fast: a duplicate name would expose two tools on the wire but only
		// run the last-registered handler.
		if (impls.has(name)) {
			throw new Error(`Executor.make: duplicate tool name "${name}" — tool names must be unique.`);
		}
		impls.set(name, tool);
	}

	const wire = tools.map((tool) => toAikitTool(tool.definition));

	const handle = <RProgress = never, EProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress, EProgress>,
	): Effect.Effect<ToolOutcome, ToolExecutionError, RProgress> =>
		Effect.gen(function* () {
			const impl = impls.get(call.name);
			if (impl === undefined) {
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return errored(call, [text(`Unknown tool: ${call.name}`)], now, {
					error: "unknown_tool",
					name: call.name,
				});
			}
			const def = impl.definition;

			const decoded = yield* Effect.result(Schema.decodeUnknownEffect(asCodec(def.parameters))(call.arguments));
			if (Result.isFailure(decoded)) {
				const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
				return errored(call, [text(`Invalid arguments for ${call.name}: ${decoded.failure.message}`)], now, {
					error: "invalid_arguments",
					name: call.name,
				});
			}

			const ctx: ToolCallContext = { callID: call.callID, toolName: call.name, rawArgs: call.arguments };

			// Latest partial: captured for aborted-call output regardless of any sink.
			const latest = yield* Ref.make(Option.none<ToolProgressPartial>());
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
			const exit = yield* impl
				.handler(decoded.success, ctx)
				.pipe(Effect.scoped, Effect.provideService(ToolProgress, progress), Effect.exit);

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

			return yield* encodeOutcome(def, call, exit, latest);
		}).pipe(Effect.scoped);

	return { wire, handle };
};
