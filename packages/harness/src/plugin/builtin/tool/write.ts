import { Effect, Layer, Schema } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in write plugin. The whole write holds the file's mutation lock, so
 * it never interleaves with an `edit` of the same file; the filesystem creates
 * missing parent directories on every backend.
 */

const WriteParams = Schema.Struct({
	path: Schema.String.annotate({ description: "Path to the file to write (relative or absolute)" }),
	content: Schema.String.annotate({ description: "Content to write to the file" }),
});

class WriteFailed extends Schema.TaggedError<WriteFailed>()("WriteFailed", { message: Schema.String }) {}

export const writeDef = Tool.define({
	name: "write",
	label: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	promptSnippet: "Create or overwrite files",
	promptGuidelines: ["Use write only for new files or complete rewrites."],
	parameters: WriteParams,
	success: Schema.Struct({ path: Schema.String }),
	failure: WriteFailed,
	encodeContent: (success) => [{ type: "text", text: `Successfully wrote to ${success.path}` }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: () => undefined,
});

/** Filesystem failures are the model's to see, as the backend reported them. */
const fsFailure = (path: string) => (error: SandboxFileSystem.FileSystemError) =>
	Effect.fail(
		new WriteFailed({
			message: error.cause instanceof Error ? error.cause.message : `Could not write file: ${path}`,
		}),
	);

export const writeHandler: Tool.Handler<
	typeof WriteParams,
	typeof writeDef.success,
	typeof WriteFailed,
	SandboxIO.FileSystem | SandboxIO.Mutation
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const mutation = yield* SandboxIO.Mutation;
		const path = ToolPath.normalize(params.path);
		yield* mutation.withFile(path, fs.writeFile(path, params.content));
		return { path: params.path };
	}).pipe(Effect.catchTag("SandboxFileSystemError", fsFailure(params.path)));

/** The write tool: definition + handler, wired the testable (def/exec split) way. */
export const writeTool = Tool.implement(writeDef, writeHandler);

export const writePlugin = define({
	id: "codework.tool.write",
	kind: "tool",
	setup: Effect.fn("WritePlugin.setup")(function* (ctx) {
		const mounted = Layer.merge(
			Layer.succeed(SandboxIO.FileSystem, yield* SandboxIO.FileSystem),
			Layer.succeed(SandboxIO.Mutation, yield* SandboxIO.Mutation),
		);
		ctx.plugin.tools.add(Tool.provide(writeTool, mounted));
	}),
});
