import { Message } from "@codeworksh/aikit";
import { Cause, Effect, Exit, Option, Ref, Result, Schema } from "effect";
import type { Static } from "typebox";
import { ToolProgress, type ToolProgressPartial } from "./progress";
import { type AnyToolDef, type AnyToolImpl, type ModelContent, toAikitTool, type ToolCallContext } from "./tool";

/**
 * `ToolExecutor` — the uniform pipeline run for every tool call:
 *
 *   resolve def → decode args (Effect Schema) → run handler (scoped, exit) →
 *   encode typed Success/Failure into aikit's message protocol → outcome.
 *
 * Tools never touch event plumbing or aikit message shapes. Result mapping:
 *   - success            → completed   (content + encoded details)
 *   - declared failure   → error       (content + encoded details), fed to the model
 *   - interruption       → aborted
 *   - undeclared / defect → run error  (re-raised as a defect)
 */

/** A terminal tool outcome in aikit's status-tagged shape. */
export type ToolOutcome =
	| Static<typeof Message.ToolCompletedSchema>
	| Static<typeof Message.ToolErrorSchema>
	| Static<typeof Message.ToolAbortedSchema>;

export interface Executor<R> {
	/** aikit wire view of the tool set, for the loop context (`convertTools`). */
	readonly wire: Message.Tool[];
	/**
	 * Run one tool call to a terminal outcome. Most failures become a terminal
	 * `ToolOutcome`; a `failureMode: "error"` tool propagates its declared failure
	 * through the error channel, and undeclared failures/defects propagate as defects.
	 */
	readonly handle: (call: Message.ToolCallInFlight) => Effect.Effect<ToolOutcome, unknown, R>;
}

// Erase a schema's services to `never` for decode/encode. Sound for tool schemas
// (none require services) and keeps the executor's `R` clean of schema services.
const asCodec = (schema: AnyToolDef["parameters"]): Schema.Codec<unknown, unknown> =>
	schema as unknown as Schema.Codec<unknown, unknown>;

const text = (value: string): Message.TextContent => ({ type: "text", text: value });
const jsonText = (value: unknown): Message.TextContent => ({ type: "text", text: JSON.stringify(value) });

const completed = (content: ModelContent, details: unknown): ToolOutcome => ({
	status: "completed",
	result: { content: [...content], details, isError: false },
});
const errored = (content: ModelContent, details: unknown): ToolOutcome => ({
	status: "error",
	result: { content: [...content], details, isError: true },
});
const aborted = (content: ModelContent, details?: unknown): ToolOutcome => ({
	status: "aborted",
	result: { content: [...content], details, isError: true },
});

const encodeOutcome = (
	def: AnyToolDef,
	exit: Exit.Exit<unknown, unknown>,
	latest: Ref.Ref<Option.Option<ToolProgressPartial>>,
): Effect.Effect<ToolOutcome, unknown> =>
	Effect.gen(function* () {
		if (Exit.isSuccess(exit)) {
			const encoded = yield* Schema.encodeUnknownEffect(asCodec(def.success))(exit.value).pipe(Effect.orDie);
			const content = def.encodeContent ? def.encodeContent(exit.value) : [jsonText(encoded)];
			return completed(content, encoded);
		}

		const cause = exit.cause;
		if (Cause.hasInterrupts(cause)) {
			// Surface whatever the tool last reported via ToolProgress, so an aborted
			// streaming command still shows the output it produced before the interrupt.
			const last = yield* Ref.get(latest);
			if (Option.isSome(last) && last.value.content !== undefined && last.value.content.length > 0) {
				return aborted([...last.value.content], last.value.details);
			}
			return aborted([text("Tool Call Aborted.")]);
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
			return errored(content, encoded);
		}

		// Undeclared failure or genuine defect → the loop is broken, not the tool.
		return yield* Effect.die(Cause.squash(cause));
	});

/**
 * Build an executor over a set of tool implementations. `R` is the union of the
 * handlers' capability requirements (e.g. `ToolShell`), satisfied where the
 * runtime is assembled.
 */
export const make = <R>(tools: ReadonlyArray<AnyToolImpl<R | ToolProgress>>): Executor<R> => {
	const impls = new Map<string, AnyToolImpl<R | ToolProgress>>();
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

	const handle = (call: Message.ToolCallInFlight): Effect.Effect<ToolOutcome, unknown, R> =>
		Effect.gen(function* () {
			const impl = impls.get(call.name);
			if (impl === undefined) {
				return errored([text(`Unknown tool: ${call.name}`)], { error: "unknown_tool", name: call.name });
			}
			const def = impl.definition;

			const decoded = yield* Effect.result(Schema.decodeUnknownEffect(asCodec(def.parameters))(call.rawArgs));
			if (Result.isFailure(decoded)) {
				return errored([text(`Invalid arguments for ${call.name}: ${decoded.failure.message}`)], {
					error: "invalid_arguments",
					name: call.name,
				});
			}

			const ctx: ToolCallContext = { callID: call.callID, toolName: call.name, rawArgs: call.rawArgs };

			// Call-scoped progress: capture the latest partial so an aborted call can
			// still report the output produced so far. (This is also the seam a live
			// event sink plugs into later.)
			const latest = yield* Ref.make(Option.none<ToolProgressPartial>());
			const progress = ToolProgress.of({ report: (partial) => Ref.set(latest, Option.some(partial)) });

			const exit = yield* impl
				.handler(decoded.success, ctx)
				.pipe(Effect.scoped, Effect.provideService(ToolProgress, progress), Effect.exit);
			return yield* encodeOutcome(def, exit, latest);
		});

	return { wire, handle };
};
