import { Duration, Effect, Option, Ref, Schema, Stream } from "effect";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accumulator, type OutputSnapshot } from "./accumulator";
import { ToolProgress } from "./progress";
import { type IToolShell, ToolShell } from "./shell";
import * as Tool from "./tool";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, type TruncationResult } from "./truncate";

/**
 * The bash tool — the worked example of the design. The definition is pure data;
 * the handler depends only on {@link ToolShell} / {@link ToolProgress}, never
 * `sandbox/Shell`, so the backend (local OS / just-bash / remote provider) is
 * swapped by changing the provided Layer with no change to the tool.
 *
 * Two execution paths, picked by capability:
 *   - **variant A (buffered)** otherwise: `ToolShell.exec` returns the full output,
 *     truncated once after completion.
 *   - **variant B (streaming)** when the backend offers `ToolShell.stream`: output
 *     flows through an {@link Accumulator} (bounded memory + temp-file spill)
 *     and is reported live via {@link ToolProgress}; on timeout the partial output
 *     produced so far is preserved.
 *
 * Success and failure carry the *same* structured shape (`output`, `exitCode`,
 * `truncated`, `fullOutputPath`) — a non-zero exit is just `exitCode !== 0`, not a
 * different kind of result. See `notes/agent-tools-arch.md`.
 */

const BashParams = Schema.Struct({
	command: Schema.String.annotate({ description: "The bash command to execute." }),
	timeout: Schema.optional(
		Schema.Finite.check(Schema.isGreaterThan(0)).annotate({
			description: "Optional timeout in seconds (must be greater than 0).",
		}),
	),
});

// Shared structured fields, so a programmatic consumer reads truncation / the
// full-output path the same way whether the command succeeded or failed.
const outputFields = {
	/** Combined stdout + stderr, truncated for display (full output is on disk when `truncated`). */
	output: Schema.String,
	truncated: Schema.Boolean,
	fullOutputPath: Schema.optional(Schema.String),
};

const BashSuccess = Schema.Struct({ ...outputFields, exitCode: Schema.Number });

/** Non-zero exit — expected, model-visible. Carries the same shape as success. */
class BashFailed extends Schema.TaggedErrorClass<BashFailed>()("BashFailed", {
	...outputFields,
	exitCode: Schema.Number,
}) {}

/** Deadline exceeded — expected, model-visible. Carries the partial output produced so far. */
class BashTimedOut extends Schema.TaggedErrorClass<BashTimedOut>()("BashTimedOut", {
	...outputFields,
	timeoutSeconds: Schema.Number,
}) {}

const BashFailure = Schema.Union([BashFailed, BashTimedOut]);
type BashFailureError = BashFailed | BashTimedOut;

export const bashDef = Tool.define({
	name: "bash",
	label: "bash",
	promptSnippet: "Execute bash commands (ls, grep, find, etc.).",
	description:
		"Execute a bash command in the working directory and return its combined stdout/stderr output. " +
		`Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES}KB (whichever is hit first); when truncated, the full ` +
		"output is saved to a temp file. A non-zero exit code is reported as an error carrying the captured output.",
	parameters: BashParams,
	success: BashSuccess,
	failure: BashFailure,
	failureMode: "return",
	// The model reads just the command output, not the JSON envelope.
	encodeContent: (success) => [{ type: "text", text: success.output }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.output }],
});

/** The structured, model-facing shape of a presented result (ready to spread). */
interface Presented {
	readonly output: string;
	readonly truncated: boolean;
	readonly fullOutputPath?: string;
}

/** Combine stdout and stderr into one stream of text, stderr after stdout. */
const combineOutput = (stdout: string, stderr: string): string => {
	if (stderr.length === 0) return stdout;
	if (stdout.length === 0) return stderr;
	return `${stdout}\n${stderr}`;
};

/** One-line footer appended to truncated, model-facing output. */
const footer = (t: TruncationResult, fullOutputPath: string | undefined, lastLineBytes?: number): string => {
	const where = fullOutputPath ? ` Full output: ${fullOutputPath}` : "";
	const startLine = t.totalLines - t.outputLines + 1;
	if (t.lastLinePartial) {
		const lineSize = lastLineBytes !== undefined ? ` (line is ${formatSize(lastLineBytes)})` : "";
		return `\n\n[showing last ${formatSize(t.outputBytes)} of line ${t.totalLines}${lineSize}.${where}]`;
	}
	if (t.truncatedBy === "lines") {
		return `\n\n[showing lines ${startLine}-${t.totalLines} of ${t.totalLines}.${where}]`;
	}
	return `\n\n[showing lines ${startLine}-${t.totalLines} of ${t.totalLines} (${formatSize(t.maxBytes)} limit).${where}]`;
};

/** Write full output to a host temp file (best-effort; undefined on failure). */
const spillToTempFile = (content: string): Effect.Effect<string | undefined> =>
	Effect.tryPromise(async () => {
		const path = join(tmpdir(), `codework-bash-${randomBytes(6).toString("hex")}.log`);
		await writeFile(path, content, "utf-8");
		return path;
	}).pipe(Effect.orElseSucceed(() => undefined));

/** Variant A: truncate the buffered output once, spilling the full output if truncated. */
const presentBuffered = (combined: string): Effect.Effect<Presented> =>
	Effect.gen(function* () {
		const t = truncateTail(combined);
		if (!t.truncated) return { output: t.content, truncated: false };
		const fullOutputPath = yield* spillToTempFile(combined);
		return {
			output: t.content + footer(t, fullOutputPath),
			truncated: true,
			...(fullOutputPath !== undefined ? { fullOutputPath } : {}),
		};
	});

/** Variant B: present an accumulator snapshot (the temp file is spilled incrementally). */
const presentSnapshot = (snap: OutputSnapshot, lastLineBytes: number): Presented => {
	if (!snap.truncation.truncated) return { output: snap.content, truncated: false };
	return {
		output: snap.content + footer(snap.truncation, snap.fullOutputPath, lastLineBytes),
		truncated: true,
		...(snap.fullOutputPath !== undefined ? { fullOutputPath: snap.fullOutputPath } : {}),
	};
};

/** Variant A — buffered: one `exec`, truncate after completion. No live progress. */
const runBuffered = (
	shell: IToolShell,
	params: typeof BashParams.Type,
): Effect.Effect<typeof BashSuccess.Type, BashFailureError> =>
	Effect.gen(function* () {
		const result = yield* shell
			.exec(params.command, params.timeout !== undefined ? { timeout: Duration.seconds(params.timeout) } : undefined)
			.pipe(
				// A deadline becomes a model-visible BashTimedOut (no partial output is
				// available from a buffered exec); an infra/spawn failure is not
				// model-actionable, so it becomes a defect (run error).
				Effect.catchTag("ToolShellTimeout", (timeout) =>
					Effect.fail(
						new BashTimedOut({ timeoutSeconds: timeout.timeoutMillis / 1000, output: "", truncated: false }),
					),
				),
				Effect.catchTag("ToolShellError", (cause) => Effect.die(cause)),
			);

		const present = yield* presentBuffered(combineOutput(result.stdout, result.stderr));
		if (result.exitCode !== 0) {
			return yield* new BashFailed({ exitCode: result.exitCode, ...present });
		}
		return { exitCode: result.exitCode, ...present } satisfies typeof BashSuccess.Type;
	});

/** Variant B — streaming: accumulate output, report progress, keep partial output on timeout. */
const runStreaming = (
	stream: NonNullable<IToolShell["stream"]>,
	params: typeof BashParams.Type,
): Effect.Effect<typeof BashSuccess.Type, BashFailureError, ToolProgress> =>
	Effect.acquireUseRelease(
		// The accumulator's temp file is closed on success, failure, OR interrupt.
		Effect.sync(() => new Accumulator({ tempFilePrefix: "codework-bash" })),
		(acc) =>
			Effect.gen(function* () {
				const progress = yield* ToolProgress;
				const exitCode = yield* Ref.make<number | null>(null);
				// executes command and streams output
				const consume = stream(params.command).pipe(
					Stream.runForEach((event) =>
						event._tag === "Exit"
							? Ref.set(exitCode, event.exitCode)
							: // `gen` so the snapshot is read *after* the append runs (not eagerly
								// at pipeline-construction time, which would lag a chunk behind).
								Effect.gen(function* () {
									yield* Effect.sync(() => acc.append(Buffer.from(event.bytes)));
									yield* progress.report({ content: [{ type: "text", text: acc.snapshot().content }] });
								}),
					),
					// Infra/spawn failure → defect (run error), like variant A.
					Effect.catchTag("ToolShellError", (cause) => Effect.die(cause)),
				);

				// Consume with the deadline; on timeout the accumulator keeps what arrived.
				let timedOutAfter: number | undefined;
				if (params.timeout !== undefined) {
					const finished = yield* consume.pipe(Effect.timeoutOption(Duration.seconds(params.timeout)));
					if (Option.isNone(finished)) timedOutAfter = params.timeout;
				} else {
					yield* consume;
				}

				yield* Effect.sync(() => acc.finish());
				const present = presentSnapshot(acc.snapshot({ persistIfTruncated: true }), acc.getLastLineBytes());

				if (timedOutAfter !== undefined) {
					return yield* new BashTimedOut({ timeoutSeconds: timedOutAfter, ...present });
				}
				const code = yield* Ref.get(exitCode);
				// No Exit event (e.g. killed before reporting one) → treat as a failure.
				if (code === null || code !== 0) {
					return yield* new BashFailed({ exitCode: code ?? -1, ...present });
				}
				return { exitCode: code, ...present } satisfies typeof BashSuccess.Type;
			}),
		(acc) => Effect.promise(() => acc.closeTempFile().catch(() => {})),
	);

export const bashHandler: Tool.Handler<
	typeof BashParams,
	typeof BashSuccess,
	typeof BashFailure,
	ToolShell | ToolProgress
> = (params) =>
	Effect.gen(function* () {
		const shell = yield* ToolShell;
		// Prefer streaming when the backend supports it; fall back to buffered exec.
		return shell.stream !== undefined ? yield* runStreaming(shell.stream, params) : yield* runBuffered(shell, params);
	});

/** The bash tool: definition + handler, wired the testable (def/exec split) way. */
export const bashTool = Tool.implement(bashDef, bashHandler);
