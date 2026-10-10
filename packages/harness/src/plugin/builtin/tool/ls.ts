import { Effect, Layer, Schema } from "effect";
import { SandboxIO } from "../../../sandbox/io.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "../../../tool/truncate.ts";
import { posix } from "../../../util/posix.ts";
import { define } from "../../plugin.ts";

/** The built-in ls plugin: one directory through the sandbox filesystem, no binaries involved. */

const LsParams = Schema.Struct({
	path: Schema.optional(Schema.String.annotate({ description: "Directory to list (default: current directory)" })),
	limit: Schema.optional(
		Schema.Finite.annotate({ description: "Maximum number of entries to return (default: 500)" }),
	),
});

const LsDetails = Schema.Struct({
	truncation: Schema.optional(Schema.Unknown),
	entryLimitReached: Schema.optional(Schema.Finite),
});

const LsSuccess = Schema.Struct({ text: Schema.String, details: Schema.optional(LsDetails) });

class LsFailed extends Schema.TaggedError<LsFailed>()("LsFailed", { message: Schema.String }) {}

const DEFAULT_LIMIT = 500;

export const lsDef = Tool.define({
	name: "ls",
	label: "ls",
	description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	promptSnippet: "List directory contents",
	parameters: LsParams,
	constrainedSampling: { type: "json_schema", strict: "prefer" },
	success: LsSuccess,
	failure: LsFailed,
	encodeContent: (success) => [{ type: "text", text: success.text }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: (success) => success.details,
});

const fail = (message: string) => Effect.fail(new LsFailed({ message }));

export const lsHandler: Tool.Handler<
	typeof LsParams,
	typeof LsSuccess,
	typeof LsFailed,
	SandboxIO.FileSystem | SandboxIO.Current
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const sandbox = yield* SandboxIO.Current;
		const dirPath = posix.resolve(sandbox.cwd, ToolPath.normalize(params.path || "."));
		const limit = params.limit ?? DEFAULT_LIMIT;

		const stat = yield* fs.stat(dirPath).pipe(Effect.option);
		if (stat._tag === "None") return yield* fail(`Path not found: ${dirPath}`);
		if (!stat.value.isDirectory) return yield* fail(`Not a directory: ${dirPath}`);

		const read = yield* fs.readdir(dirPath).pipe(Effect.result);
		if (read._tag === "Failure") {
			const cause = read.failure.cause;
			return yield* fail(`Cannot read directory: ${cause instanceof Error ? cause.message : String(cause)}`);
		}
		const entries = [...read.success].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		const results: Array<string> = [];
		let entryLimitReached = false;
		for (const entry of entries) {
			if (results.length >= limit) {
				entryLimitReached = true;
				break;
			}
			// An entry that cannot be stat'ed (a dangling link) is left out.
			const entryStat = yield* fs.stat(posix.join(dirPath, entry)).pipe(Effect.option);
			if (entryStat._tag === "None") continue;
			results.push(entryStat.value.isDirectory ? `${entry}/` : entry);
		}

		if (results.length === 0) return { text: "(empty directory)" };

		// The entry count is already capped; only bytes remain to bound.
		const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		const notices: Array<string> = [];
		const details: { truncation?: unknown; entryLimitReached?: number } = {};
		if (entryLimitReached) {
			notices.push(`${limit} entries limit reached. Use limit=${limit * 2} for more`);
			details.entryLimitReached = limit;
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
			details.truncation = truncation;
		}
		const text = notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
		return Object.keys(details).length > 0 ? { text, details } : { text };
	});

/** The ls tool: definition + handler, wired the testable (def/exec split) way. */
export const lsTool = Tool.implement(lsDef, lsHandler);

export const lsPlugin = define({
	id: "codework.tool.ls",
	kind: "tool",
	optIn: true,
	setup: Effect.fn("LsPlugin.setup")(function* (ctx) {
		const mounted = Layer.merge(
			Layer.succeed(SandboxIO.FileSystem, yield* SandboxIO.FileSystem),
			Layer.succeed(SandboxIO.Current, yield* SandboxIO.Current),
		);
		ctx.plugin.tools.add(Tool.provide(lsTool, mounted));
	}),
});
