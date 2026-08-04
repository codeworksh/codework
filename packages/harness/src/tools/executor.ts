import { Message } from "@codeworksh/aikit";
import { Cause, Duration, Effect, Exit, Option, Queue, Ref, Result, Schedule, Schema, Scope } from "effect";
import { ToolProgress, type ToolProgressPartial } from "./progress";
import { type AnyToolDef, type ModelContent, type RegisteredTool, toAikitTool, type ToolCallContext } from "./tool";

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
export interface HandleOptions<RProgress = never> {
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
	readonly onProgress?: (event: ProgressEvent) => Effect.Effect<void, unknown, RProgress>;
}

export interface Executor {
	/** aikit wire view of the tool set, for the loop context (`convertTools`). */
	readonly wire: Message.Tool[];
	/**
	 * Atomically transform one complete pending tool-call part into a complete terminal
	 * part. Most failures become a terminal
	 * `ToolOutcome`; a `failureMode: "error"` tool propagates its declared failure
	 * through the error channel, and undeclared failures/defects propagate as defects.
	 *
	 * Tools enter as {@link RegisteredTool}s (capability `R` already discharged at
	 * registration), so the only requirement left in the result is a progress sink's own
	 * `RProgress`. `options.onProgress` observes live progress off the hot path.
	 */
	readonly handle: <RProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress>,
	) => Effect.Effect<ToolOutcome, unknown, RProgress>;
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
const jsonText = (value: unknown): Message.TextContent => ({ type: "text", text: JSON.stringify(value) });

const completed = (call: Message.ToolCallPendingPart, content: ModelContent, details: unknown): ToolOutcome => ({
	...call,
	status: "completed",
	result: { content: [...content], details, isError: false },
	time: { ...call.time, end: Math.max(call.time.end, Date.now()) },
});
const errored = (call: Message.ToolCallPendingPart, content: ModelContent, details: unknown): ToolOutcome => ({
	...call,
	status: "error",
	result: { content: [...content], details, isError: true },
	time: { ...call.time, end: Math.max(call.time.end, Date.now()) },
});
const aborted = (call: Message.ToolCallPendingPart, content: ModelContent, details?: unknown): ToolOutcome => ({
	...call,
	status: "aborted",
	result: { content: [...content], details, isError: true },
	time: { ...call.time, end: Math.max(call.time.end, Date.now()) },
});

const running = (call: Message.ToolCallPendingPart, partial: ToolProgressPartial): Message.ToolCallRunningPart => ({
	...call,
	status: "running",
	partial: {
		...(partial.content === undefined ? {} : { content: [...partial.content] }),
		...(partial.details === undefined ? {} : { details: partial.details }),
	},
	time: { ...call.time, end: Math.max(call.time.end, Date.now()) },
});

const encodeOutcome = (
	def: AnyToolDef,
	call: Message.ToolCallPendingPart,
	exit: Exit.Exit<unknown, unknown>,
	latest: Ref.Ref<Option.Option<ToolProgressPartial>>,
): Effect.Effect<ToolOutcome, unknown> =>
	Effect.gen(function* () {
		if (Exit.isSuccess(exit)) {
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.success))(exit.value).pipe(Effect.orDie);
			const content = def.encodeContent ? def.encodeContent(exit.value) : [jsonText(encoded)];
			return completed(call, content, encoded);
		}

		const cause = exit.cause;
		if (Cause.hasInterrupts(cause)) {
			// Surface whatever the tool last reported via ToolProgress, so an aborted
			// streaming command still shows the output it produced before the interrupt.
			const last = yield* Ref.get(latest);
			if (Option.isSome(last) && last.value.content !== undefined && last.value.content.length > 0) {
				return aborted(call, [...last.value.content], last.value.details);
			}
			return aborted(call, [text("Tool Call Aborted.")]);
		}

		const failure = Cause.findErrorOption(cause);
		if (Option.isSome(failure) && def.failure !== undefined && Schema.is(asCodec(def.failure))(failure.value)) {
			// A declared, expected failure. "error" opts it into the caller's error
			// channel (the typed failure is preserved); "return" (default) encodes it
			// into a model-facing tool error result.
			if (def.failureMode === "error") {
				return yield* Effect.failCause(cause);
			}
			const value = failure.value;
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.failure))(value).pipe(Effect.orDie);
			const content = def.encodeFailureContent ? def.encodeFailureContent(value) : [jsonText(encoded)];
			return errored(call, content, encoded);
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

	const handle = <RProgress = never>(
		call: Message.ToolCallPendingPart,
		options?: HandleOptions<RProgress>,
	): Effect.Effect<ToolOutcome, unknown, RProgress> =>
		Effect.gen(function* () {
			const impl = impls.get(call.name);
			if (impl === undefined) {
				return errored(call, [text(`Unknown tool: ${call.name}`)], { error: "unknown_tool", name: call.name });
			}
			const def = impl.definition;

			const decoded = yield* Effect.result(Schema.decodeUnknownEffect(asCodec(def.parameters))(call.arguments));
			if (Result.isFailure(decoded)) {
				return errored(call, [text(`Invalid arguments for ${call.name}: ${decoded.failure.message}`)], {
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
			const progress = ToolProgress.of({
				report: (partial) =>
					Ref.set(latest, Option.some(partial)).pipe(
						Effect.andThen(
							progressQueue
								? Queue.offer(progressQueue, { partial, toolCall: running(call, partial), ctx }).pipe(
										Effect.asVoid,
									)
								: Effect.void,
						),
					),
			});

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
