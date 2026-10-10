import { Duration, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect";
import { SandboxIO } from "../../../sandbox/io.ts";
import { Accumulator, type OutputSnapshot } from "../../../tool/accumulator.ts";
import { Output } from "../../../tool/output.ts";
import { ToolProgress } from "../../../tool/progress.ts";
import { fromSandboxShell, type IToolShell, ToolShell } from "../../../tool/shell.ts";
import * as Tool from "../../../tool/tool.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "../../../tool/truncate.ts";
import { define } from "../../plugin.ts";

/**
 * The self-contained bash plugin — a worked example for tool plugins. The definition is pure data;
 * the handler depends only on {@link ToolShell} / {@link ToolProgress} and the mount's
 * {@link SandboxIO.Current}, never `sandbox/Shell`, so the backend (host / just-bash / remote
 * provider) is swapped by changing the provided Layer with no change to the tool.
 *
 * The command runs wrapped (`Output`) so its full output is written to a file inside the sandbox,
 * kept only when it exceeds the display limits. Two paths, picked by capability:
 *   - **variant A (buffered)** otherwise: the sandbox returns only the tail of the output with its
 *     size, so a huge output never crosses to the harness.
 *   - **variant B (streaming)** when the backend offers `ToolShell.stream`: output flows through
 *     an {@link Accumulator} (bounded memory) and is reported live via {@link ToolProgress}; on
 *     timeout the partial output produced so far is preserved.
 *
 * Success and failure carry the *same* structured shape
 * (`output`, `exitCode`, `truncated`, `fullOutputPath`)
 * — a non-zero exit is just `exitCode !== 0`, not a different kind of result.
 */

const limits: Output.Limits = { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES };

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
	/** Combined stdout + stderr, truncated for display (full output is in the sandbox when `truncated`). */
	output: Schema.String,
	truncated: Schema.Boolean,
	fullOutputPath: Schema.optional(Schema.String),
};

const BashSuccess = Schema.Struct({ ...outputFields, exitCode: Schema.Finite });

/** Non-zero exit — expected, model-visible. Carries the same shape as success. */
class BashFailed extends Schema.TaggedError<BashFailed>()("BashFailed", {
	...outputFields,
	exitCode: Schema.Finite,
}) {}

/** Deadline exceeded — expected, model-visible. Carries the partial output produced so far. */
class BashTimedOut extends Schema.TaggedError<BashTimedOut>()("BashTimedOut", {
	...outputFields,
	timeoutSeconds: Schema.Finite,
}) {}

const BashFailure = Schema.Union([BashFailed, BashTimedOut]);
type BashFailureError = BashFailed | BashTimedOut;

/** The reason for a failure, after any output: the model sees nothing else of `details`. */
const withStatus = (failure: BashFailureError): string => {
	const status =
		failure._tag === "BashTimedOut"
			? `Command timed out after ${failure.timeoutSeconds} seconds`
			: failure.exitCode === -1
				? "Command terminated without an exit code"
				: `Command exited with code ${failure.exitCode}`;
	return failure.output ? `${failure.output.replace(/\n$/, "")}\n\n${status}` : status;
};

export const bashDef = Tool.define({
	name: "bash",
	label: "bash",
	promptSnippet: "Execute bash commands (ls, grep, find, etc.).",
	description:
		"Execute a bash command in the working directory and return its combined stdout/stderr output. " +
		`Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first); when truncated, a ` +
		"note says which lines are shown and gives the path of a file holding the full output when one was saved. " +
		"A non-zero exit code is reported as an error carrying the captured output.",
	parameters: BashParams,
	success: BashSuccess,
	failure: BashFailure,
	// The model reads the command output, not the JSON envelope — and, on failure, why it failed.
	encodeContent: (success) => [{ type: "text", text: success.output || "(no output)" }],
	encodeFailureContent: (failure) => [{ type: "text", text: withStatus(failure) }],
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

/** Present a snapshot; `saved` is the output file, when the sandbox kept one. */
const present = (snap: OutputSnapshot, lastLineBytes: number, saved: string | undefined): Presented => {
	if (!snap.truncation.truncated) return { output: snap.content, truncated: false };
	return {
		// A tail that fit the limits on its own still ends with its newline; the footer brings its own.
		output: snap.content.replace(/\n$/, "") + footer(snap.truncation, saved, lastLineBytes),
		truncated: true,
		...(saved !== undefined ? { fullOutputPath: saved } : {}),
	};
};

const utf8 = new TextEncoder();

/**
 * A command cut off by its deadline never reached the wrapper's own cleanup: kill
 * what is left of it and remove its side files, keeping the output file only when
 * the result points at it.
 */
const cleanUp = (shell: IToolShell, file: string, presented: Presented) =>
	sweep(shell, Output.cleanup(file, presented.fullOutputPath !== undefined));

/** Best-effort housekeeping script: bounded, and never a failure of the tool. */
const sweep = (shell: IToolShell, script: string) =>
	shell.exec(script, { timeout: Duration.seconds(5) }).pipe(Effect.ignore);

/** Variant A — buffered: one `exec` that returns the tail of the output and its size. No live progress. */
const runBuffered = (
	shell: IToolShell,
	params: typeof BashParams.Type,
	file: string,
): Effect.Effect<typeof BashSuccess.Type, BashFailureError> =>
	Effect.gen(function* () {
		const result = yield* shell
			.exec(
				Output.buffered(params.command, file, limits),
				params.timeout !== undefined ? { timeout: Duration.seconds(params.timeout) } : undefined,
			)
			.pipe(
				// A deadline becomes a model-visible BashTimedOut (no partial output is
				// available from a buffered exec); an infra/spawn failure is not
				// model-actionable, so it becomes a defect (run error).
				Effect.catchTags({
					ToolShellTimeout: (timeout) =>
						cleanUp(shell, file, { output: "", truncated: false }).pipe(
							Effect.andThen(
								Effect.fail(
									new BashTimedOut({
										timeoutSeconds: timeout.timeoutMillis / 1000,
										output: "",
										truncated: false,
									}),
								),
							),
						),
					ToolShellError: (cause) => Effect.die(cause),
				}),
			);

		const acc = new Accumulator(limits);
		const combined = combineOutput(result.stdout, result.stderr);
		const window = Output.window(combined);
		if (window === undefined) acc.append(utf8.encode(combined));
		else {
			// Below the byte cap, the window is whole lines from `tail -n`.
			acc.skip(
				window.bytes - window.textBytes,
				window.newlines - countNewlines(window.text),
				window.textBytes < Output.windowBytes(limits),
			);
			acc.append(utf8.encode(window.text), window.textBytes);
		}
		acc.finish();
		const presented = present(acc.snapshot(), acc.getLastLineBytes(), window?.kept === true ? file : undefined);
		if (result.exitCode !== 0) {
			return yield* new BashFailed({ exitCode: result.exitCode, ...presented });
		}
		return { exitCode: result.exitCode, ...presented } satisfies typeof BashSuccess.Type;
	});

const countNewlines = (text: string): number => {
	let count = 0;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
};

/** Variant B — streaming: accumulate output, report progress, keep partial output on timeout. */
const runStreaming = (
	shell: IToolShell,
	stream: NonNullable<IToolShell["stream"]>,
	params: typeof BashParams.Type,
	file: string,
): Effect.Effect<typeof BashSuccess.Type, BashFailureError, ToolProgress> =>
	Effect.gen(function* () {
		const acc = new Accumulator(limits);
		const progress = yield* ToolProgress;
		const exitCode = yield* Ref.make<number | null>(null);
		// The first output tells whether the sandbox could create the output file.
		const notice = Output.unsaved(file);
		let head = "";
		// The wrapper's own channel: its report, once the command is done.
		const control = new TextDecoder();
		let said = "";
		const consume = stream(Output.streaming(params.command, file, limits)).pipe(
			Stream.runForEach((event) =>
				event._tag === "Exit"
					? Ref.set(exitCode, event.exitCode)
					: event.channel === "stderr"
						? Effect.sync(() => {
								said += control.decode(event.bytes, { stream: true });
							})
						: Effect.gen(function* () {
								if (head.length < notice.length)
									head += new TextDecoder().decode(event.bytes.slice(0, notice.length));
								acc.append(event.bytes);
								yield* progress.report({ content: [{ type: "text", text: acc.snapshot().content }] });
							}),
			),
			// Infra/spawn failure → defect (run error), like variant A.
			Effect.catchTag("ToolShellError", (cause) => Effect.die(cause)),
		);

		// Consume with the deadline; on timeout the accumulator keeps what arrived.
		let timedOutAfter: number | undefined;
		if (params.timeout !== undefined) {
			const fiber = yield* Effect.forkChild(consume);
			const finished = yield* Fiber.await(fiber).pipe(Effect.timeoutOption(Duration.seconds(params.timeout)));
			if (Option.isSome(finished)) yield* Fiber.join(fiber);
			else {
				timedOutAfter = params.timeout;
				// Kill while the stream still holds the wrapper: interrupting it first can
				// kill the wrapper alone, orphaning the command outside the tree cleanup walks.
				yield* sweep(shell, Output.cleanup(file, true));
				yield* Fiber.interrupt(fiber);
			}
		} else {
			yield* consume;
		}

		const { report, rest } = Output.report(said + control.decode());
		if (rest.length > 0) acc.append(utf8.encode(rest));
		acc.finish();
		const snapshot = acc.snapshot();
		// The sandbox decided on its raw bytes. Cut off before it reported, the file
		// is still there when it was created, so the harness's own count applies.
		const kept = report !== undefined ? report.kept : snapshot.beyondLimits && !head.startsWith(notice);
		const presented = present(snapshot, acc.getLastLineBytes(), kept ? file : undefined);

		if (timedOutAfter !== undefined) {
			if (!kept) yield* sweep(shell, Output.remove(file));
			return yield* new BashTimedOut({ timeoutSeconds: timedOutAfter, ...presented });
		}
		const code = yield* Ref.get(exitCode);
		// No Exit event (e.g. killed before reporting one) → treat as a failure.
		if (code === null || code !== 0) {
			return yield* new BashFailed({ exitCode: code ?? -1, ...presented });
		}
		return { exitCode: code, ...presented } satisfies typeof BashSuccess.Type;
	});

export const bashHandler: Tool.Handler<
	typeof BashParams,
	typeof BashSuccess,
	typeof BashFailure,
	ToolShell | ToolProgress | SandboxIO.Current
> = (params) =>
	Effect.gen(function* () {
		const shell = yield* ToolShell;
		const file = yield* Output.path((yield* SandboxIO.Current).spillPath, "codework-bash");
		// Prefer streaming when the backend supports it; fall back to buffered exec.
		// Cancelled from outside, the wrapper never reaches its own cleanup either.
		return yield* (
			shell.stream !== undefined ? runStreaming(shell, shell.stream, params, file) : runBuffered(shell, params, file)
		).pipe(Effect.onInterrupt(() => cleanUp(shell, file, { output: "", truncated: false })));
	});

/** The bash tool: definition + handler, wired the testable (def/exec split) way. */
export const bashTool = Tool.implement(bashDef, bashHandler);

export const bashPlugin = define({
	id: "codework.tool.bash",
	kind: "tool",
	setup: Effect.fn("BashPlugin.setup")(function* (ctx) {
		const shell = yield* SandboxIO.Shell;
		const current = yield* SandboxIO.Current;
		const mounted = Layer.merge(
			fromSandboxShell.pipe(Layer.provide(Layer.succeed(SandboxIO.Shell, shell))),
			Layer.succeed(SandboxIO.Current, current),
		);
		ctx.plugin.tools.add(Tool.provide(bashTool, mounted));
	}),
});
