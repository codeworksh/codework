import { Effect, Layer, Schema } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { NonNegativeInt, PositiveInt } from "../../../schema.ts";
import * as Tool from "../../../tool/tool.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../../tool/truncate.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in read plugin. The definition is pure data; the handler depends only on
 * {@link SandboxIO.FileSystem}, so the backend (local OS / in-memory / remote provider)
 * is whatever the mount provides. Output keeps the head of the file
 * ({@link truncateHead}); the file itself is the full copy, and a truncated read
 * tells the model the next `offset`.
 */

const ReadParams = Schema.Struct({
	path: Schema.String.annotate({
		description: "File to read. Relative paths resolve against the working directory.",
	}),
	offset: Schema.optional(
		PositiveInt.annotate({
			description: "1-based line to start from. Defaults to 1.",
		}),
	),
	limit: Schema.optional(
		PositiveInt.annotate({
			description: `Maximum number of lines to return. Defaults to ${DEFAULT_MAX_LINES}, and still capped at ${formatSize(DEFAULT_MAX_BYTES)}.`,
		}),
	),
});

const ReadSuccess = Schema.Struct({
	/** Numbered lines, plus a footer when `truncated` or when caller limit leaves lines remaining. */
	content: Schema.String,
	truncated: Schema.Boolean,
	truncatedBy: Schema.optional(Schema.Literals(["lines", "bytes"])),
	path: Schema.String,
	startLine: NonNegativeInt,
	endLine: NonNegativeInt,
	totalLines: NonNegativeInt,
});

const ReadReason = Schema.Literals(["not_found", "not_a_file", "binary", "offset_out_of_range", "line_too_long"]);

class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", {
	path: Schema.String,
	reason: ReadReason,
	message: Schema.String,
}) {}

const ReadFailure = Schema.Union([ReadFailed]);

export const readDef = Tool.define({
	name: "read",
	label: "read",
	promptSnippet: "Read a text file, optionally from a line offset.",
	promptGuidelines: ["Use read to examine files instead of cat or sed."],
	description:
		"Read a text file and return its contents with 1-based line numbers. " +
		`Output is truncated to the first ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)} (whichever is hit first). ` +
		"When truncated, call again with offset set to the next line. " +
		"A missing path, a directory, a binary file, a line longer than the byte limit, or an offset past the end is an error.",
	parameters: ReadParams,
	success: ReadSuccess,
	failure: ReadFailure,
	encodeContent: (success) => [{ type: "text", text: success.content }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
});

const failed = (path: string, reason: typeof ReadReason.Type, message: string) =>
	new ReadFailed({ path, reason, message });

/** Lines of `content`, without a trailing empty line from a final newline. */
const linesOf = (content: string): string[] => {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
};

const numberLines = (lines: ReadonlyArray<string>, startLine: number, totalLines: number): string => {
	const width = String(Math.max(totalLines, 1)).length;
	return lines.map((line, index) => `${String(startLine + index).padStart(width, " ")}|${line}`).join("\n");
};

const footer = (start: number, end: number, total: number, reason: "lines" | "bytes"): string => {
	if (reason === "bytes") {
		return `\n\n[showing lines ${start}-${end} of ${total} (${formatSize(DEFAULT_MAX_BYTES)} limit). Read again with offset ${end + 1}.]`;
	}
	return `\n\n[showing lines ${start}-${end} of ${total}. Read again with offset ${end + 1}.]`;
};

const linesLabel = (count: number): string => `${count} ${count === 1 ? "line" : "lines"}`;

/** Missing path is model-visible; every other filesystem failure is a defect. */
const absentOrDie = (path: string) => (error: SandboxFileSystem.FileSystemError) => {
	if (SandboxFileSystem.isNotFoundError(error.cause)) {
		return Effect.fail(failed(path, "not_found", `File not found: ${path}`));
	}
	return Effect.die(error);
};

export const readHandler: Tool.Handler<
	typeof ReadParams,
	typeof ReadSuccess,
	typeof ReadFailure,
	SandboxIO.FileSystem
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const offset = params.offset ?? 1;
		const stat = yield* fs
			.stat(params.path)
			.pipe(Effect.catchTag("SandboxFileSystemError", absentOrDie(params.path)));
		if (!stat.isFile) {
			return yield* failed(params.path, "not_a_file", `Not a file: ${params.path}`);
		}

		const text = yield* fs
			.readFile(params.path)
			.pipe(Effect.catchTag("SandboxFileSystemError", absentOrDie(params.path)));
		if (text.includes("\0")) {
			return yield* failed(params.path, "binary", `Binary file: ${params.path}`);
		}

		const lines = linesOf(text);
		// An empty file read from the start is a successful empty result, not a bad offset.
		if (offset > lines.length && !(lines.length === 0 && offset === 1)) {
			return yield* failed(
				params.path,
				"offset_out_of_range",
				`Offset ${offset} is past the end of ${params.path} (${linesLabel(lines.length)}).`,
			);
		}

		const hasCallerLimit = params.limit !== undefined && params.limit < DEFAULT_MAX_LINES;
		const maxLines = params.limit ?? DEFAULT_MAX_LINES;
		const selected = lines.slice(offset - 1);
		const truncated = truncateHead(selected.join("\n"), { maxLines });
		if (truncated.firstLineExceedsLimit) {
			const bytes = Buffer.byteLength(selected[0] ?? "", "utf8");
			return yield* failed(
				params.path,
				"line_too_long",
				`Line ${offset} is ${bytes} bytes, over the ${formatSize(DEFAULT_MAX_BYTES)} read limit. ` +
					`Use bash to inspect: sed -n '${offset}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}`,
			);
		}

		const kept = selected.slice(0, truncated.outputLines);
		const endLine = kept.length === 0 ? 0 : offset + kept.length - 1;
		const body = numberLines(kept, offset, lines.length);

		// If caller explicitly requested a limit and it was satisfied without hitting the byte limit,
		// it is an intentional paged window, not a system truncation.
		const isSystemTruncated = truncated.truncatedBy === "bytes" || (truncated.truncated && !hasCallerLimit);
		const truncatedBy = isSystemTruncated ? (truncated.truncatedBy ?? undefined) : undefined;
		const hasMoreLines = endLine < lines.length;

		let content = body;
		if (truncated.truncatedBy === "bytes") {
			content += footer(offset, endLine, lines.length, "bytes");
		} else if (isSystemTruncated && truncated.truncated) {
			content += footer(offset, endLine, lines.length, "lines");
		} else if (hasCallerLimit && hasMoreLines) {
			const remaining = lines.length - endLine;
			content += `\n\n[${remaining} more ${remaining === 1 ? "line" : "lines"} in file. Read again with offset ${endLine + 1}.]`;
		}

		return {
			content,
			truncated: isSystemTruncated,
			...(truncatedBy === undefined ? {} : { truncatedBy }),
			path: params.path,
			startLine: offset,
			endLine,
			totalLines: lines.length,
		} satisfies typeof ReadSuccess.Type;
	});

/** The read tool: definition + handler, wired the testable (def/exec split) way. */
export const readTool = Tool.implement(readDef, readHandler);

export const readPlugin = define({
	id: "codework.tool.read",
	kind: "tool",
	setup: Effect.fn("ReadPlugin.setup")(function* (ctx) {
		const fs = yield* SandboxIO.FileSystem;
		ctx.plugin.tools.add(Tool.provide(readTool, Layer.succeed(SandboxIO.FileSystem, fs)));
	}),
});
