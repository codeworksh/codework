import { Effect, Layer, Schema } from "effect";
import type { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { quoteArgv } from "../../../sandbox/shell/shell.ts";
import { Binary } from "../../../tool/binary.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../../tool/truncate.ts";
import { posix } from "../../../util/posix.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in find plugin: fd in the mounted sandbox. A virtual mount has no fd,
 * and the tool says so rather than emulating it.
 */

const FindParams = Schema.Struct({
	pattern: Schema.String.annotate({
		description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
	}),
	path: Schema.optional(
		Schema.String.annotate({ description: "Directory to search in (default: current directory)" }),
	),
	limit: Schema.optional(Schema.Finite.annotate({ description: "Maximum number of results (default: 1000)" })),
});

const FindDetails = Schema.Struct({
	truncation: Schema.optional(Schema.Unknown),
	resultLimitReached: Schema.optional(Schema.Finite),
});

const FindSuccess = Schema.Struct({ text: Schema.String, details: Schema.optional(FindDetails) });

class FindFailed extends Schema.TaggedError<FindFailed>()("FindFailed", { message: Schema.String }) {}

const DEFAULT_LIMIT = 1000;
const FD_ERROR = "[fd error]:";

export const findDef = Tool.define({
	name: "find",
	label: "find",
	description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	promptSnippet: "Find files by glob pattern (respects .gitignore)",
	parameters: FindParams,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	success: FindSuccess,
	failure: FindFailed,
	encodeContent: (success) => [{ type: "text", text: success.text }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: (success) => success.details,
});

const fail = (message: string) => Effect.fail(new FindFailed({ message }));

/** Relative to the search root, keeping a directory's trailing slash. */
const relativize = (result: string, searchPath: string) => {
	const relative = posix.isAbsolute(result) ? posix.relative(searchPath, result) : result;
	return result.endsWith("/") && !relative.endsWith("/") ? `${relative}/` : relative;
};

const insideGitRepo = (fs: SandboxFileSystem.Interface, searchPath: string) =>
	Effect.gen(function* () {
		for (let current = searchPath; ; current = posix.dirname(current)) {
			if (yield* fs.exists(posix.join(current, ".git")).pipe(Effect.orElseSucceed(() => false))) return true;
			if (posix.dirname(current) === current) return false;
		}
	});

export const findHandler: Tool.Handler<
	typeof FindParams,
	typeof FindSuccess,
	typeof FindFailed,
	SandboxIO.FileSystem | SandboxIO.Shell | SandboxIO.Current | Binary.HostBin
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const shell = yield* SandboxIO.Shell;
		const sandbox = yield* SandboxIO.Current;
		const searchPath = posix.resolve(sandbox.cwd, ToolPath.normalize(params.path || "."));
		const limit = Math.max(1, Math.trunc(params.limit ?? DEFAULT_LIMIT));
		if (!(yield* fs.exists(searchPath).pipe(Effect.orElseSucceed(() => false))))
			return yield* fail(`Path not found: ${searchPath}`);

		// fd honours .gitignore outside a repo only when told to. Inside one, its own
		// git awareness stops a parent's rules at a nested repo.
		const repo = yield* insideGitRepo(fs, searchPath);
		const argv = ["--glob", "--color=never", "--hidden", ...(repo ? [] : ["--no-require-git"])];
		argv.push("--max-results", String(limit));
		// fd matches a glob against the basename unless `--full-path`, which matches the
		// absolute path, so a pattern with a directory in it needs a leading `**/`.
		let pattern = params.pattern;
		if (pattern.includes("/")) {
			argv.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") pattern = `**/${pattern}`;
		}
		argv.push("--", pattern, searchPath);

		const run = yield* Binary.withCommand("fd", sandbox, shell, fs, (command) =>
			shell.exec(quoteArgv([command, ...argv])),
		);
		if ("_tag" in run) return yield* fail(run.message);

		// Some backends merge stderr into stdout; fd marks every error line, so they are told apart.
		const output = run.stdout
			.split("\n")
			.map((line) => line.replace(/\r$/, "").trim())
			.filter((line) => line.length > 0);
		const lines = output.filter((line) => !line.startsWith(FD_ERROR));
		const errors = [run.stderr.trim(), ...output.filter((line) => line.startsWith(FD_ERROR))]
			.filter((text) => text.length > 0)
			.join("\n");
		if (run.exitCode !== 0 && lines.length === 0) return yield* fail(errors || `fd exited with code ${run.exitCode}`);
		if (lines.length === 0) return { text: "No files found matching pattern" };

		// fd reports in thread order; sorting keeps the result repeatable.
		const results = lines.map((line) => relativize(line, searchPath)).sort();
		const resultLimitReached = results.length >= limit;
		const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const notices: Array<string> = [];
		const details: { truncation?: unknown; resultLimitReached?: number } = {};
		if (resultLimitReached) {
			notices.push(`${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`);
			details.resultLimitReached = limit;
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			details.truncation = truncation;
		}
		const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return Object.keys(details).length > 0 ? { text, details } : { text };
	}).pipe(Effect.catchTag("ShellError", (error) => Effect.die(error)));

/** The find tool: definition + handler, wired the testable (def/exec split) way. */
export const findTool = Tool.implement(findDef, findHandler);

export const findPlugin = define({
	id: "codework.tool.find",
	kind: "tool",
	optIn: true,
	setup: Effect.fn("FindPlugin.setup")(function* (ctx) {
		const mounted = Layer.mergeAll(
			Layer.succeed(SandboxIO.FileSystem, yield* SandboxIO.FileSystem),
			Layer.succeed(SandboxIO.Shell, yield* SandboxIO.Shell),
			Layer.succeed(SandboxIO.Current, yield* SandboxIO.Current),
			Layer.succeed(Binary.HostBin, ctx.paths.bin),
		);
		ctx.plugin.tools.add(Tool.provide(findTool, mounted));
	}),
});
