import { Effect, Layer, Option, Schema, Semaphore } from "effect";
import { createTwoFilesPatch, diffLines, FILE_HEADERS_ONLY } from "diff";
import { NonNegativeInt } from "../../../schema.ts";
import { SandboxFileSystem } from "../../../sandbox/fs/filesystem.ts";
import { SandboxIO } from "../../../sandbox/io.ts";
import * as Tool from "../../../tool/tool.ts";
import { posix } from "../../../util/posix.ts";
import { define } from "../../plugin.ts";

/**
 * The built-in edit plugin — precise, surgical file changes by exact text
 * replacement, in the shape PI uses: one call carries one or more `edits[]`,
 * and every `oldText` is matched against the **original** file, never
 * incrementally against the result of an earlier edit.
 *
 * Exact-only is deliberate. A failed match is a loud, typed error the model
 * retries; a fuzzy fallback could silently change the wrong region, which is a
 * worse failure. BOM and line endings are preserved (matching happens on
 * LF-normalized text, the file is written back in its original convention).
 *
 * A missing file is created by a single edit with an empty `oldText` (the same
 * escape hatch opencode offers for full-file content). Existing files always
 * require a non-empty, unique, non-overlapping `oldText`.
 *
 * Edits are serialized per resolved path: tool calls can run in parallel, so two
 * edits to one file must not interleave their read-modify-write.
 */

const ReplacePatch = Schema.Struct({
	oldText: Schema.String.annotate({
		description:
			"Exact text for one targeted replacement. It must match a unique, non-overlapping region of the original file and must not overlap any other edits[].oldText in the same call.",
	}),
	newText: Schema.String.annotate({ description: "Replacement text for this targeted edit." }),
});

const EditParams = Schema.Struct({
	path: Schema.String.annotate({
		description: "File to edit. Relative paths resolve against the working directory.",
	}),
	edits: Schema.Array(ReplacePatch).annotate({
		description:
			"One or more targeted replacements, each matched against the original file (not incrementally). Merge nearby changes into one edit instead of emitting overlapping edits. To create a new file, pass exactly one edit with an empty oldText.",
	}),
});

const EditSuccess = Schema.Struct({
	/** Model-facing summary. */
	content: Schema.String,
	path: Schema.String,
	editsApplied: NonNegativeInt,
	created: Schema.Boolean,
	/** Standard unified patch of the change (for UI rendering). */
	patch: Schema.String,
	/** 1-based line of the first change in the new file, for editor navigation. */
	firstChangedLine: Schema.optional(NonNegativeInt),
});

const EditReason = Schema.Literals([
	"no_edits",
	"empty_old_text",
	"create_needs_single_empty_edit",
	"no_match",
	"ambiguous_match",
	"overlapping_edits",
	"is_directory",
	"no_change",
	"read_failed",
	"write_failed",
]);

class EditFailed extends Schema.TaggedError<EditFailed>()("EditFailed", {
	path: Schema.String,
	reason: EditReason,
	message: Schema.String,
}) {}

const EditFailure = Schema.Union([EditFailed]);

export const editDef = Tool.define({
	name: "edit",
	label: "edit",
	promptSnippet: "Make precise file edits with exact text replacement.",
	promptGuidelines: [
		"Use edit for precise changes; every edits[].oldText must match exactly, including whitespace.",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple calls.",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits; merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still unique in the file. To create a new file, pass a single edit with an empty oldText.",
	],
	description:
		"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file; a match that is missing, duplicated, or overlapping is an error and the file is left unchanged. " +
		"Line endings and a UTF-8 BOM are preserved. " +
		"To create a file that does not exist, pass exactly one edit whose oldText is empty.",
	parameters: EditParams,
	success: EditSuccess,
	failure: EditFailure,
	encodeContent: (success) => [{ type: "text", text: success.content }],
	encodeFailureContent: (failure) => [{ type: "text", text: failure.message }],
});

// ── Text helpers ────────────────────────────────────────────────────────────

const BOM = "\uFEFF";

const splitBom = (text: string): { readonly bom: boolean; readonly text: string } =>
	text.startsWith(BOM) ? { bom: true, text: text.slice(1) } : { bom: false, text };

const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n");

const toLf = (text: string): string => text.replace(/\r\n/g, "\n");

const restoreLineEnding = (text: string, ending: "\n" | "\r\n"): string =>
	ending === "\n" ? text : text.replace(/\n/g, "\r\n");

interface Replacement {
	readonly start: number;
	readonly end: number;
	readonly newText: string;
}

/** A unified patch of one file's change, without the `Index:`/`===` banner. */
const patchOf = (path: string, before: string, after: string): string =>
	createTwoFilesPatch(path, path, before, after, undefined, undefined, {
		context: 3,
		headerOptions: FILE_HEADERS_ONLY,
	});

const firstChangedLine = (before: string, after: string): number | undefined => {
	let line = 1;
	for (const change of diffLines(before, after)) {
		if (change.added || change.removed) return line;
		line += change.count ?? 0;
	}
	return undefined;
};

// ── Per-file serialization ──────────────────────────────────────────────────

/**
 * One lock per resolved path, so two edits to the same file cannot interleave
 * their read-modify-write when tool calls execute in parallel. Keyed by sandbox
 * identity + resolved path so two mounts do not share a lock. The map grows one
 * entry per distinct edited path for the life of the process, as in opencode.
 */
const locks = new Map<string, Semaphore.Semaphore>();

const lockFor = (key: string): Semaphore.Semaphore => {
	const hit = locks.get(key);
	if (hit !== undefined) return hit;
	const next = Semaphore.makeUnsafe(1);
	locks.set(key, next);
	return next;
};

// ── Handler ─────────────────────────────────────────────────────────────────

const fail = (path: string, reason: typeof EditReason.Type, message: string) =>
	new EditFailed({ path, reason, message });

const editFile = (
	fs: SandboxFileSystem.Interface,
	params: typeof EditParams.Type,
): Effect.Effect<typeof EditSuccess.Type, EditFailed> =>
	Effect.gen(function* () {
		const path = params.path;
		if (params.edits.length === 0) {
			return yield* fail(path, "no_edits", "edits must contain at least one replacement.");
		}

		// A genuinely missing file is the create path; any other stat failure (a
		// permission error, a dropped connection) is reported instead of being
		// mistaken for absence.
		const existing = yield* fs.stat(path).pipe(
			Effect.asSome,
			Effect.catchTag("SandboxFileSystemError", (error) =>
				SandboxFileSystem.isNotFoundError(error.cause)
					? Effect.succeed(Option.none<SandboxFileSystem.FileStat>())
					: Effect.fail(fail(path, "read_failed", `Could not inspect ${path}.`)),
			),
		);

		// Create: a missing file needs exactly one edit with an empty oldText.
		if (Option.isNone(existing)) {
			const only = params.edits[0];
			if (params.edits.length !== 1 || only === undefined || only.oldText !== "") {
				return yield* fail(
					path,
					"create_needs_single_empty_edit",
					`File not found: ${path}. To create it, provide exactly one edit with an empty oldText.`,
				);
			}
			const content = toLf(only.newText);
			yield* fs
				.writeFile(path, content)
				.pipe(Effect.mapError(() => fail(path, "write_failed", `Could not write ${path}.`)));
			const patch = patchOf(path, "", content);
			return {
				content: `Created ${path} (${content.length} bytes).`,
				path,
				editsApplied: 1,
				created: true,
				patch,
				...(content === "" ? {} : { firstChangedLine: 1 }),
			} satisfies typeof EditSuccess.Type;
		}

		const stat = existing.value;
		if (stat.isDirectory) {
			return yield* fail(path, "is_directory", `Not a file: ${path}`);
		}

		const raw = yield* fs
			.readFile(path)
			.pipe(Effect.mapError(() => fail(path, "read_failed", `Could not read ${path}.`)));
		const { bom, text } = splitBom(raw);
		const ending = detectLineEnding(text);
		const original = toLf(text);

		const replacements: Replacement[] = [];
		for (const [index, edit] of params.edits.entries()) {
			if (edit.oldText === "") {
				return yield* fail(
					path,
					"empty_old_text",
					`edit ${index + 1}: oldText is empty; replacing a whole existing file is not supported. Provide exact text to replace.`,
				);
			}
			const needle = toLf(edit.oldText);
			const start = original.indexOf(needle);
			if (start === -1) {
				return yield* fail(path, "no_match", `edit ${index + 1}: oldText was not found in ${path}.`);
			}
			// `lastIndexOf` rather than a count: it also rejects an overlapping second
			// match (e.g. "aa" inside "aaa"), which a non-overlapping search would miss.
			if (original.lastIndexOf(needle) !== start) {
				return yield* fail(
					path,
					"ambiguous_match",
					`edit ${index + 1}: oldText is not unique in ${path}; include more surrounding text to make it unique.`,
				);
			}
			replacements.push({ start, end: start + needle.length, newText: toLf(edit.newText) });
		}

		replacements.sort((a, b) => a.start - b.start);
		for (let i = 1; i < replacements.length; i++) {
			const previous = replacements[i - 1];
			const current = replacements[i];
			if (previous !== undefined && current !== undefined && current.start < previous.end) {
				return yield* fail(path, "overlapping_edits", `edits overlap in ${path}; merge them into one edit.`);
			}
		}

		let updated = "";
		let cursor = 0;
		for (const replacement of replacements) {
			updated += original.slice(cursor, replacement.start) + replacement.newText;
			cursor = replacement.end;
		}
		updated += original.slice(cursor);

		if (updated === original) {
			return yield* fail(path, "no_change", `No change: the replacements leave ${path} unchanged.`);
		}

		yield* fs
			.writeFile(path, `${bom ? BOM : ""}${restoreLineEnding(updated, ending)}`)
			.pipe(Effect.mapError(() => fail(path, "write_failed", `Could not write ${path}.`)));

		const patch = patchOf(path, original, updated);
		const changedLine = firstChangedLine(original, updated);
		const count = replacements.length;
		return {
			content: `Edited ${path} (${count} ${count === 1 ? "replacement" : "replacements"}).`,
			path,
			editsApplied: count,
			created: false,
			patch,
			...(changedLine === undefined ? {} : { firstChangedLine: changedLine }),
		} satisfies typeof EditSuccess.Type;
	});

export const editHandler: Tool.Handler<
	typeof EditParams,
	typeof EditSuccess,
	typeof EditFailure,
	SandboxIO.FileSystem | SandboxIO.Current
> = (params) =>
	Effect.gen(function* () {
		const fs = yield* SandboxIO.FileSystem;
		const current = yield* SandboxIO.Current;
		const key = `${current.id}:${posix.resolve(current.cwd, params.path)}`;
		return yield* lockFor(key).withPermits(1)(editFile(fs, params));
	});

export const editTool = Tool.implement(editDef, editHandler);

export const editPlugin = define({
	id: "codework.tool.edit",
	kind: "tool",
	setup: Effect.fn("EditPlugin.setup")(function* (ctx) {
		const fs = yield* SandboxIO.FileSystem;
		const current = yield* SandboxIO.Current;
		ctx.plugin.tools.add(
			Tool.provide(
				editTool,
				Layer.merge(Layer.succeed(SandboxIO.FileSystem, fs), Layer.succeed(SandboxIO.Current, current)),
			),
		);
	}),
});
