import { Effect, Layer, Schema } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { Image } from "../../../tool/image/index.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "../../../tool/truncate.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in read plugin. Text is read through `scanLines`, so only the shown
 * window crosses from the sandbox; images, told apart by their bytes, go to the
 * model as attachments. Continuation notices are part of the text the model
 * reads; `details` keeps only how the text was cut.
 */

const ReadParams = Schema.Struct({
	path: Schema.String.annotate({ description: "Path to the file to read (relative or absolute)" }),
	offset: Schema.optional(Schema.Finite.annotate({ description: "Line number to start reading from (1-indexed)" })),
	limit: Schema.optional(Schema.Finite.annotate({ description: "Maximum number of lines to read" })),
});

/** How the shown text was cut. */
const Truncation = Schema.Struct({
	truncated: Schema.Boolean,
	truncatedBy: Schema.NullOr(Schema.Literals(["lines", "bytes"])),
	/** Lines selected by `offset`/`limit`, before the limits. */
	totalLines: Schema.Finite,
	outputLines: Schema.Finite,
	outputBytes: Schema.Finite,
	firstLineExceedsLimit: Schema.Boolean,
	maxLines: Schema.Finite,
	maxBytes: Schema.Finite,
});

const ReadText = Schema.Struct({
	type: Schema.Literal("text"),
	text: Schema.String,
	truncation: Schema.optional(Truncation),
});

const ReadImage = Schema.Struct({
	type: Schema.Literal("image"),
	/** What the model reads with the image: its type and any conversion/resize hints. */
	note: Schema.String,
	image: Schema.optional(Schema.Struct({ data: Schema.String, mimeType: Schema.String })),
});

const ReadSuccess = Schema.Union([ReadText, ReadImage]);

class ReadFailed extends Schema.TaggedError<ReadFailed>()("ReadFailed", { message: Schema.String }) {}

const BINARY_PROBE_BYTES = 8000;

export const readDef = Tool.define({
	name: "read",
	label: "read",
	description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
	promptSnippet: "Read file contents",
	promptGuidelines: ["Use read to examine files instead of cat or sed."],
	parameters: ReadParams,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	success: ReadSuccess,
	failure: ReadFailed,
	encodeContent: (success) =>
		success.type === "text"
			? [{ type: "text", text: success.text }]
			: [
					{ type: "text", text: success.note },
					...(success.image === undefined ? [] : [{ type: "image" as const, ...success.image }]),
				],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	// The image travels in the content; storing it again in details would double the record.
	encodeDetails: (success) =>
		success.type === "text" && success.truncation !== undefined ? { truncation: success.truncation } : undefined,
});

const fail = (message: string) => Effect.fail(new ReadFailed({ message }));

/**
 * Filesystem failures are the model's to see, as Pi shows them: a missing path in
 * one wording on every backend, anything else (EACCES, …) as the backend reported it.
 */
const fsFailure = (path: string) => (error: SandboxFileSystem.FileSystemError) =>
	fail(
		SandboxFileSystem.isNotFoundError(error.cause)
			? `ENOENT: no such file or directory, open '${path}'`
			: error.cause instanceof Error
				? error.cause.message
				: `Could not read file: ${path}`,
	);

const readImage = (fs: SandboxFileSystem.Interface, resolved: string, mimeType: string) =>
	Effect.gen(function* () {
		const bytes = yield* fs.readFileBuffer(resolved);
		const inline: Image.Inline = yield* Image.inline(bytes, mimeType);
		if (!inline.ok) return { type: "image" as const, note: `Read image file [${mimeType}]\n${inline.message}` };
		return {
			type: "image" as const,
			note: [`Read image file [${inline.mimeType}]`, ...inline.hints].join("\n"),
			image: { data: inline.data, mimeType: inline.mimeType },
		};
	});

const readText = (
	fs: SandboxFileSystem.Interface,
	resolved: string,
	params: typeof ReadParams.Type,
): Effect.Effect<typeof ReadText.Type, ReadFailed | SandboxFileSystem.FileSystemError> =>
	Effect.gen(function* () {
		const { path, offset } = params;
		const startLine = offset ? Math.max(0, Math.trunc(offset) - 1) : 0;
		const limit = params.limit === undefined ? undefined : Math.max(1, Math.trunc(params.limit));
		const endLine = startLine + Math.min(limit ?? DEFAULT_MAX_LINES, DEFAULT_MAX_LINES);
		// A start no file reaches only needs the line count, for the error below.
		const scan = yield* fs.scanLines(
			resolved,
			Number.isSafeInteger(endLine)
				? { startLine, endLine, maxBytes: DEFAULT_MAX_BYTES }
				: { startLine: 0, endLine: 1, maxBytes: DEFAULT_MAX_BYTES },
		);
		// An empty file still has a line 1 to read, as an editor shows it.
		if (startLine >= Math.max(scan.totalLines, 1)) {
			return yield* fail(`Offset ${offset} is beyond end of file (${scan.totalLines} lines total)`);
		}

		// The scan bounds raw bytes; invalid UTF-8 grows when decoded (one byte becomes a
		// three-byte U+FFFD), so the decoded text is bounded again.
		const grown = Buffer.byteLength(scan.text, "utf8") > DEFAULT_MAX_BYTES ? truncateHead(scan.text) : undefined;
		const firstLineBytes = grown?.firstLineExceedsLimit
			? Buffer.byteLength(scan.text.split("\n", 1)[0] ?? "", "utf8")
			: scan.firstLineBytes;
		const shown = grown === undefined ? scan : { text: grown.content, lines: grown.outputLines };

		const first = startLine + 1;
		const selected = Math.min(scan.totalLines, limit === undefined ? Infinity : startLine + limit) - startLine;
		const truncation = (truncatedBy: "lines" | "bytes" | null, firstLineExceedsLimit: boolean) => ({
			truncated: true,
			truncatedBy,
			totalLines: selected,
			outputLines: shown.lines,
			outputBytes: Buffer.byteLength(shown.text, "utf8"),
			firstLineExceedsLimit,
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});

		if (firstLineBytes > DEFAULT_MAX_BYTES) {
			return {
				type: "text" as const,
				text: `[Line ${first} is ${formatSize(firstLineBytes)}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${first}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`,
				truncation: { ...truncation("bytes", true), outputLines: 0, outputBytes: 0 },
			};
		}
		if (shown.lines < selected) {
			const last = startLine + shown.lines;
			const truncatedBy = shown.lines < Math.min(selected, DEFAULT_MAX_LINES) ? "bytes" : "lines";
			const limitText = truncatedBy === "bytes" ? ` (${formatSize(DEFAULT_MAX_BYTES)} limit)` : "";
			return {
				type: "text" as const,
				text: `${shown.text}\n\n[Showing lines ${first}-${last} of ${scan.totalLines}${limitText}. Use offset=${last + 1} to continue.]`,
				truncation: truncation(truncatedBy, false),
			};
		}
		if (limit !== undefined && startLine + limit < scan.totalLines) {
			const remaining = scan.totalLines - (startLine + limit);
			return {
				type: "text" as const,
				text: `${shown.text}\n\n[${remaining} more lines in file. Use offset=${startLine + limit + 1} to continue.]`,
			};
		}
		return { type: "text" as const, text: shown.text };
	});

export const readHandler: Tool.Handler<
	typeof ReadParams,
	typeof ReadSuccess,
	typeof ReadFailed,
	SandboxIO.FileSystem
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const resolved = yield* ToolPath.resolveRead(fs, params.path);
		const stat = yield* fs.stat(resolved);
		if (stat.isDirectory) return yield* fail("EISDIR: illegal operation on a directory, read");
		if (!stat.isFile) return yield* fail("Not a regular file");

		// One read serves the image sniff and the binary probe; only a PNG's chunk walk reads further.
		const head = yield* fs.readBytes(resolved, 0, BINARY_PROBE_BYTES);
		const mimeType = yield* Image.detectOf({
			// Unknown size: the chunk walk stops at the first short read instead.
			size: stat.size ?? Infinity,
			read: (offset, length) =>
				offset + length <= head.length
					? Effect.succeed(head.subarray(offset, offset + length))
					: fs.readBytes(resolved, offset, length),
		});
		if (mimeType !== undefined) return yield* readImage(fs, resolved, mimeType);
		if (head.includes(0)) return yield* fail(`Unsupported read ${params.path}: binary file.`);
		return yield* readText(fs, resolved, params);
	}).pipe(Effect.catchTag("SandboxFileSystemError", fsFailure(params.path)));

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
