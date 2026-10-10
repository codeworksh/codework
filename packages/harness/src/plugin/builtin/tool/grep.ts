import { Effect, Layer, Schema } from "effect";
import type { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { quote, quoteArgv } from "../../../sandbox/shell/shell.ts";
import { Binary } from "../../../tool/binary.ts";
import { Output } from "../../../tool/output.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
} from "../../../tool/truncate.ts";
import { posix } from "../../../util/posix.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in grep plugin: ripgrep in the mounted sandbox — the host's or the
 * remote's own binary, or just-bash's built-in `rg` on a virtual mount. Only the
 * first `limit` match events leave the sandbox; context lines are read through
 * `scanLines`, so only their window crosses.
 */

const GrepParams = Schema.Struct({
	pattern: Schema.String.annotate({ description: "Search pattern (regex or literal string)" }),
	path: Schema.optional(
		Schema.String.annotate({ description: "Directory or file to search (default: current directory)" }),
	),
	glob: Schema.optional(
		Schema.String.annotate({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" }),
	),
	ignoreCase: Schema.optional(Schema.Boolean.annotate({ description: "Case-insensitive search (default: false)" })),
	literal: Schema.optional(
		Schema.Boolean.annotate({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Schema.optional(
		Schema.Finite.annotate({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Schema.optional(
		Schema.Finite.annotate({ description: "Maximum number of matches to return (default: 100)" }),
	),
});

const GrepDetails = Schema.Struct({
	truncation: Schema.optional(Schema.Unknown),
	matchLimitReached: Schema.optional(Schema.Finite),
	linesTruncated: Schema.optional(Schema.Boolean),
});

const GrepSuccess = Schema.Struct({ text: Schema.String, details: Schema.optional(GrepDetails) });

class GrepFailed extends Schema.TaggedError<GrepFailed>()("GrepFailed", { message: Schema.String }) {}

const DEFAULT_LIMIT = 100;

export const grepDef = Tool.define({
	name: "grep",
	label: "grep",
	description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	promptSnippet: "Search file contents for patterns (respects .gitignore)",
	parameters: GrepParams,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	success: GrepSuccess,
	failure: GrepFailed,
	encodeContent: (success) => [{ type: "text", text: success.text }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: (success) => success.details,
});

const fail = (message: string) => Effect.fail(new GrepFailed({ message }));

interface Match {
	readonly path: string;
	readonly line: number;
	readonly text: string;
}

/** One `--json` match event; anything else (begin/end/summary, a non-UTF-8 path) is skipped. */
const parseMatch = (line: string): Match | undefined => {
	try {
		const event = JSON.parse(line) as {
			type?: string;
			data?: { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } };
		};
		const path = event.data?.path?.text;
		const number = event.data?.line_number;
		const text = event.data?.lines?.text;
		if (event.type !== "match" || typeof path !== "string" || typeof number !== "number") return undefined;
		return { path, line: number, text: typeof text === "string" ? text : "" };
	} catch {
		return undefined;
	}
};

/**
 * The search runs as one pipeline so a broad pattern never ships its whole result:
 * only match events pass, and `head` stops ripgrep at the limit. Some backends
 * merge stderr into stdout, so nothing relies on the two staying apart: ripgrep's
 * status rides the pipe as a last event, and its stderr waits in `errors` until the
 * pipeline is done, where it can no longer land inside a match.
 */
const pipeline = (argv: ReadonlyArray<string>, limit: number, errors: string) =>
	[
		`mkdir -p ${quote(posix.dirname(errors))} 2>/dev/null`,
		// Without somewhere to hold its stderr, ripgrep would never run, and look like it found nothing.
		`{ : > ${quote(errors)}; } 2>/dev/null || { echo ${quote(`cannot write ${errors}`)} >&2; exit 2; }`,
		`{ ${quoteArgv(argv)} 2>${quote(errors)}; echo '{"type":"rc","code":'"$?"'}'; } | grep -E '^\\{"type":"(match|rc)"' | head -n ${limit}`,
		`cat ${quote(errors)} >&2 2>/dev/null`,
		`rm -f ${quote(errors)}`,
	].join("; ");

const STATUS = /^\{"type":"rc","code":(\d+)\}$/;

/** The pipeline's output: match events, ripgrep's status, and anything else, which is its stderr. */
const parse = (stdout: string, stderr: string) => {
	const matches: Array<Match> = [];
	const errors: Array<string> = [];
	let status: number | undefined;
	for (const line of stdout.split("\n")) {
		// The status is the first such line: anything after it is stderr, printed once the pipe closed.
		const rc = STATUS.exec(line);
		if (rc !== null) status ??= Number(rc[1]);
		else if (line.startsWith('{"type":"match"')) {
			const match = parseMatch(line);
			if (match !== undefined) matches.push(match);
		} else if (line.trim().length > 0) errors.push(line);
	}
	return { matches, status, errors: [stderr.trim(), ...errors].filter((text) => text.length > 0).join("\n") };
};

/** A line as shown: no line ending, cut to {@link GREP_MAX_LINE_LENGTH}. */
const shown = (line: string) => truncateLine(line.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, ""));

/**
 * The match with its context lines. The window is read in one bounded scan; a
 * line it could not fit is read on its own, and a line too long even for that is
 * marked rather than shown blank. The match line itself is ripgrep's.
 */
const contextBlock = (fs: SandboxFileSystem.Interface, match: Match, context: number, label: string) =>
	Effect.gen(function* () {
		const startLine = Math.max(0, match.line - 1 - context);
		const scan = yield* fs
			.scanLines(match.path, { startLine, endLine: match.line + context, maxBytes: DEFAULT_MAX_BYTES })
			.pipe(Effect.option);
		if (scan._tag === "None" || scan.value.totalLines === 0)
			return { lines: [`${label}:${match.line}: (unable to read file)`], truncated: false };
		const window = scan.value.lines === 0 ? [] : scan.value.text.split("\n");
		const lineAt = (index: number) =>
			index - startLine < window.length
				? Effect.succeed(window[index - startLine])
				: fs.scanLines(match.path, { startLine: index, endLine: index + 1, maxBytes: DEFAULT_MAX_BYTES }).pipe(
						Effect.map((one) => (one.lines === 1 ? one.text : undefined)),
						Effect.orElseSucceed(() => undefined),
					);
		const end = Math.min(scan.value.totalLines, match.line + context);
		const block: Array<string> = [];
		let truncated = false;
		for (let current = startLine + 1; current <= end; current++) {
			const line = current === match.line ? match.text : yield* lineAt(current - 1);
			const { text, wasTruncated } =
				line === undefined ? { text: "... [truncated]", wasTruncated: true } : shown(line);
			if (wasTruncated) truncated = true;
			block.push(current === match.line ? `${label}:${current}: ${text}` : `${label}-${current}- ${text}`);
		}
		return { lines: block, truncated };
	});

export const grepHandler: Tool.Handler<
	typeof GrepParams,
	typeof GrepSuccess,
	typeof GrepFailed,
	SandboxIO.FileSystem | SandboxIO.Shell | SandboxIO.Current | Binary.HostBin
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const shell = yield* SandboxIO.Shell;
		const sandbox = yield* SandboxIO.Current;
		const searchPath = posix.resolve(sandbox.cwd, ToolPath.normalize(params.path || "."));
		const stat = yield* fs.stat(searchPath).pipe(Effect.option);
		if (stat._tag === "None") return yield* fail(`Path not found: ${searchPath}`);
		const isDirectory = stat.value.isDirectory;

		const context = params.context && params.context > 0 ? Math.trunc(params.context) : 0;
		const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT));
		const errors = yield* Output.path(sandbox.spillPath, "codework-grep");

		const run = yield* Binary.withCommand("rg", sandbox, shell, fs, (command) =>
			Effect.gen(function* () {
				// The same flags for real ripgrep and just-bash's: `-e` instead of `--`, no
				// `--color`, and `-s` because just-bash defaults to smart case. `--sort path`
				// makes the order repeatable; ripgrep otherwise reports in thread order.
				const argv = [command, "--json", "--line-number", "--hidden", "--sort", "path"];
				argv.push(params.ignoreCase ? "--ignore-case" : "-s");
				if (params.literal) argv.push("--fixed-strings");
				if (params.glob) argv.push("--glob", params.glob);
				argv.push("-e", params.pattern, searchPath);
				const result = yield* shell.exec(pipeline(argv, limit, errors));
				const parsed = parse(result.stdout, result.stderr);
				return { ...parsed, exitCode: parsed.status ?? result.exitCode };
			}),
		);
		if ("_tag" in run) return yield* fail(run.message);

		const { matches } = run;
		const matchLimitReached = matches.length >= limit;
		// Stopped at the limit, ripgrep dies of a closed pipe; that is not a failure.
		if (!matchLimitReached && run.exitCode !== 0 && run.exitCode !== 1)
			return yield* fail(run.errors || `ripgrep exited with code ${run.exitCode}`);
		if (matches.length === 0) return { text: "No matches found" };

		const label = (path: string) => {
			if (isDirectory) {
				const relative = posix.relative(searchPath, path);
				if (relative && !relative.startsWith("..")) return relative;
			}
			return posix.basename(path);
		};

		const output: Array<string> = [];
		let linesTruncated = false;
		for (const match of matches) {
			if (context === 0) {
				const { text, wasTruncated } = shown(match.text);
				if (wasTruncated) linesTruncated = true;
				output.push(`${label(match.path)}:${match.line}: ${text}`);
			} else {
				const block = yield* contextBlock(fs, match, context, label(match.path));
				if (block.truncated) linesTruncated = true;
				output.push(...block.lines);
			}
		}

		// The match limit already capped the rows; only bytes remain to bound.
		const truncation = truncateHead(output.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const notices: Array<string> = [];
		const details: { truncation?: unknown; matchLimitReached?: number; linesTruncated?: boolean } = {};
		if (matchLimitReached) {
			notices.push(`${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern`);
			details.matchLimitReached = limit;
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			details.truncation = truncation;
		}
		if (linesTruncated) {
			notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
			details.linesTruncated = true;
		}
		const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return Object.keys(details).length > 0 ? { text, details } : { text };
	}).pipe(Effect.catchTag("ShellError", (error) => Effect.die(error)));

/** The grep tool: definition + handler, wired the testable (def/exec split) way. */
export const grepTool = Tool.implement(grepDef, grepHandler);

export const grepPlugin = define({
	id: "codework.tool.grep",
	kind: "tool",
	optIn: true,
	setup: Effect.fn("GrepPlugin.setup")(function* (ctx) {
		const mounted = Layer.mergeAll(
			Layer.succeed(SandboxIO.FileSystem, yield* SandboxIO.FileSystem),
			Layer.succeed(SandboxIO.Shell, yield* SandboxIO.Shell),
			Layer.succeed(SandboxIO.Current, yield* SandboxIO.Current),
			Layer.succeed(Binary.HostBin, ctx.paths.bin),
		);
		ctx.plugin.tools.add(Tool.provide(grepTool, mounted));
	}),
});
