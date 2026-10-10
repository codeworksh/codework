import { Effect, Layer, Schema } from "effect";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import { EditDiff } from "../../../tool/diff.ts";
import { ToolPath } from "../../../tool/path.ts";
import * as Tool from "../../../tool/tool.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in edit plugin: exact-text replacements, all matched against the
 * original file, under the file's mutation lock for the whole read → match →
 * write. The model reads a one-line summary; `details` carries the diff.
 */

const ReplaceEdit = Schema.Struct({
	oldText: Schema.String.annotate({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Schema.String.annotate({ description: "Replacement text for this targeted edit." }),
});

const EditParams = Schema.Struct({
	path: Schema.String.annotate({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Schema.Array(ReplaceEdit).annotate({
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

const EditSuccess = Schema.Struct({
	path: Schema.String,
	replaced: Schema.Finite,
	diff: Schema.String,
	patch: Schema.String,
	firstChangedLine: Schema.optional(Schema.Finite),
});

class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", { message: Schema.String }) {}

const isSingleEdit = (value: unknown): value is typeof ReplaceEdit.Type => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
};

/**
 * Repair shapes models commonly send: `edits` as a JSON string or as a single
 * edit object, and a top-level `oldText`/`newText` pair. Works on a copy; the
 * call's arguments stay unchanged.
 */
export const prepareEditArguments = (input: unknown): unknown => {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input;
	const args: Record<string, unknown> = { ...input };
	if (typeof args.edits === "string") {
		try {
			const parsed: unknown = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isSingleEdit(parsed)) args.edits = [parsed];
		} catch {}
	} else if (isSingleEdit(args.edits)) {
		args.edits = [args.edits];
	}

	if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
	const edits = Array.isArray(args.edits) ? [...args.edits] : [];
	edits.push({ oldText: args.oldText, newText: args.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = args;
	return { ...rest, edits };
};

export const editDef = Tool.define({
	name: "edit",
	label: "edit",
	description:
		"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
	promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	promptGuidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
	prepareArguments: prepareEditArguments,
	parameters: EditParams,
	success: EditSuccess,
	failure: EditFailed,
	encodeContent: (success) => [
		{ type: "text", text: `Successfully replaced ${success.replaced} block(s) in ${success.path}.` },
	],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
	encodeDetails: ({ diff, patch, firstChangedLine }) => ({
		diff,
		patch,
		...(firstChangedLine === undefined ? {} : { firstChangedLine }),
	}),
});

const fail = (message: string) => Effect.fail(new EditFailed({ message }));

/** Filesystem failures name the backend's error code, as Pi's do. */
const accessFailure = (path: string) => (error: SandboxFileSystem.FileSystemError) => {
	const code = (error.cause as { code?: unknown } | undefined)?.code;
	return fail(`Could not edit file: ${path}. Error code: ${typeof code === "string" ? code : "unknown"}.`);
};

export const editHandler: Tool.Handler<
	typeof EditParams,
	typeof EditSuccess,
	typeof EditFailed,
	SandboxIO.FileSystem | SandboxIO.Mutation
> = (params) =>
	Effect.gen(function* () {
		const { path, edits } = params;
		if (edits.length === 0) {
			return yield* fail("Edit tool input is invalid. edits must contain at least one replacement.");
		}
		const fs = yield* SandboxIO.FileSystem;
		const mutation = yield* SandboxIO.Mutation;
		const resolved = ToolPath.normalize(path);
		return yield* mutation.withFile(
			resolved,
			Effect.gen(function* () {
				const stat = yield* fs.stat(resolved);
				if (!stat.isFile) return yield* fail(`Could not edit file: ${path}. Path is not a file.`);

				const { bom, text: content } = EditDiff.stripBom(yield* fs.readFile(resolved));
				const originalEnding = EditDiff.detectLineEnding(content);
				const { baseContent, newContent } = yield* Effect.try({
					try: () => EditDiff.applyEditsToNormalizedContent(EditDiff.normalizeToLF(content), edits, path),
					catch: (cause) => new EditFailed({ message: cause instanceof Error ? cause.message : String(cause) }),
				});
				yield* fs.writeFile(resolved, bom + EditDiff.restoreLineEndings(newContent, originalEnding));

				const { diff, firstChangedLine } = EditDiff.generateDiffString(baseContent, newContent);
				return {
					path,
					replaced: edits.length,
					diff,
					patch: EditDiff.generateUnifiedPatch(path, baseContent, newContent),
					...(firstChangedLine === undefined ? {} : { firstChangedLine }),
				};
			}),
		);
	}).pipe(Effect.catchTag("SandboxFileSystemError", accessFailure(params.path)));

/** The edit tool: definition + handler, wired the testable (def/exec split) way. */
export const editTool = Tool.implement(editDef, editHandler);

export const editPlugin = define({
	id: "codework.tool.edit",
	kind: "tool",
	setup: Effect.fn("EditPlugin.setup")(function* (ctx) {
		const mounted = Layer.merge(
			Layer.succeed(SandboxIO.FileSystem, yield* SandboxIO.FileSystem),
			Layer.succeed(SandboxIO.Mutation, yield* SandboxIO.Mutation),
		);
		ctx.plugin.tools.add(Tool.provide(editTool, mounted));
	}),
});
