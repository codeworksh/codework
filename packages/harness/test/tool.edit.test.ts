import "./utils/env.ts";
import { Effect } from "effect";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { editPlugin } from "../src/plugin/builtin/tool/edit.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/** One scripted `edit` turn through plugin setup, the local mount, and durable settlement. */
const runEdits = (root: string, custom: string, args: ReadonlyArray<Record<string, unknown>>) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root });
		yield* session.run("Edit the file.");
		const path = yield* session.path();
		expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		const parts = messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
		expect(parts).toHaveLength(args.length);
		return parts.map((part, index) => {
			if (part.type !== "toolCall" || (part.status !== "completed" && part.status !== "error")) {
				throw new Error(`edit ${index} was not settled`);
			}
			expect(part.name).toBe("edit");
			return part;
		});
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				hostCwd: root,
				userConfigDir: custom,
				database: ":memory:",
				plugins: [editPlugin, defaultPromptPlugin],
				llm: toolTurn(...args.map((call, index) => pendingCall("edit", call, `call-${index}`))),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

const runEdit = async (root: string, custom: string, args: Record<string, unknown>) => {
	const calls = await runEdits(root, custom, [args]);
	const call = calls[0];
	if (call === undefined) throw new Error("edit call missing");
	return call;
};

interface EditDetails {
	readonly content: string;
	readonly path: string;
	readonly editsApplied: number;
	readonly created: boolean;
	readonly patch: string;
	readonly firstChangedLine?: number;
}

const detailsOf = (call: { result: unknown }): EditDetails => {
	const result = call.result as { details?: EditDetails } | undefined;
	if (result?.details === undefined) throw new Error("edit call has no details");
	return result.details;
};

const errorDetailsOf = (call: { result: unknown }): { _tag: string; path: string; reason: string; message: string } => {
	const result = call.result as
		| { isError?: boolean; details?: { _tag: string; path: string; reason: string; message: string } }
		| undefined;
	if (result?.details === undefined) throw new Error("edit call has no details");
	return result.details;
};

const SOURCE = "const one = 1;\nconst two = 2;\nconst three = 3;\n";

const seed = async (root: string) => {
	await writeFile(join(root, "sample.ts"), SOURCE);
};

const read = (root: string, name: string) => readFile(join(root, name), "utf8");

describe("edit plugin through the local harness", () => {
	it("replaces one unique region and reports the change", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [{ oldText: "const two = 2;", newText: "const two = 22;" }],
			});
			expect(call.status).toBe("completed");
			expect(call.result).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "Edited sample.ts (1 replacement)." }],
				details: {
					content: "Edited sample.ts (1 replacement).",
					path: "sample.ts",
					editsApplied: 1,
					created: false,
					firstChangedLine: 2,
				},
			});
			expect(detailsOf(call).patch).toContain("-const two = 2;");
			expect(detailsOf(call).patch).toContain("+const two = 22;");
			expect(await read(root, "sample.ts")).toBe("const one = 1;\nconst two = 22;\nconst three = 3;\n");
		}));

	it("applies several non-overlapping edits from one call", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [
					{ oldText: "const one = 1;", newText: "const one = 100;" },
					{ oldText: "const three = 3;", newText: "const three = 300;" },
				],
			});
			expect(call.status).toBe("completed");
			expect(detailsOf(call)).toMatchObject({ editsApplied: 2, created: false, firstChangedLine: 1 });
			expect(await read(root, "sample.ts")).toBe("const one = 100;\nconst two = 2;\nconst three = 300;\n");
		}));

	it("matches every oldText against the original file, not incrementally", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "chain.txt"), "AAA\n");
			const call = await runEdit(root, custom, {
				path: "chain.txt",
				edits: [
					{ oldText: "AAA", newText: "BBB" },
					{ oldText: "BBB", newText: "CCC" },
				],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("no_match");
			// The failed call leaves the file untouched.
			expect(await read(root, "chain.txt")).toBe("AAA\n");
		}));

	it("creates a missing file from a single empty oldText", () =>
		withSettings(async ({ root, custom }) => {
			const call = await runEdit(root, custom, {
				path: "nested/new.txt",
				edits: [{ oldText: "", newText: "hello\nworld\n" }],
			});
			expect(call.status).toBe("completed");
			expect(detailsOf(call)).toMatchObject({
				path: "nested/new.txt",
				editsApplied: 1,
				created: true,
				firstChangedLine: 1,
			});
			expect(await read(root, "nested/new.txt")).toBe("hello\nworld\n");
		}));

	it("refuses to invent a file from a non-empty oldText", () =>
		withSettings(async ({ root, custom }) => {
			const call = await runEdit(root, custom, {
				path: "new.txt",
				edits: [{ oldText: "anything", newText: "something" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("create_needs_single_empty_edit");
			await expect(read(root, "new.txt")).rejects.toThrow();
		}));

	it("refuses to overwrite an existing file with an empty oldText", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [{ oldText: "", newText: "whole new file" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("empty_old_text");
			expect(await read(root, "sample.ts")).toBe(SOURCE);
		}));

	it("reports an oldText that is not present", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [{ oldText: "const four = 4;", newText: "const four = 44;" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call)).toMatchObject({
				_tag: "EditFailed",
				reason: "no_match",
				message: "edit 1: oldText was not found in sample.ts.",
			});
			expect(await read(root, "sample.ts")).toBe(SOURCE);
		}));

	it("reports an oldText that is not unique", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "dup.ts"), "const a = 1;\nconst a = 1;\n");
			const call = await runEdit(root, custom, {
				path: "dup.ts",
				edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call)).toMatchObject({
				reason: "ambiguous_match",
				message: "edit 1: oldText is not unique in dup.ts; include more surrounding text to make it unique.",
			});
		}));

	it("reports an oldText that only matches as an overlapping repeat", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "overlap.txt"), "aaa\n");
			const call = await runEdit(root, custom, {
				path: "overlap.txt",
				// "aa" occurs at 0 and 1; a non-overlapping count would call this unique.
				edits: [{ oldText: "aa", newText: "b" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("ambiguous_match");
			expect(await read(root, "overlap.txt")).toBe("aaa\n");
		}));

	it("reports overlapping edits", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [
					{ oldText: "const one = 1;\nconst two = 2;", newText: "X" },
					{ oldText: "const two = 2;\nconst three = 3;", newText: "Y" },
				],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("overlapping_edits");
			expect(await read(root, "sample.ts")).toBe(SOURCE);
		}));

	it("reports a replacement that leaves the file unchanged", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, {
				path: "sample.ts",
				edits: [{ oldText: "const one = 1;", newText: "const one = 1;" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("no_change");
		}));

	it("reports an empty edits array", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runEdit(root, custom, { path: "sample.ts", edits: [] });
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call).reason).toBe("no_edits");
		}));

	it("reports a directory", () =>
		withSettings(async ({ root, custom }) => {
			await mkdir(join(root, "folder"));
			const call = await runEdit(root, custom, {
				path: "folder",
				edits: [{ oldText: "a", newText: "b" }],
			});
			expect(call.status).toBe("error");
			expect(errorDetailsOf(call)).toMatchObject({ reason: "is_directory", message: "Not a file: folder" });
		}));

	it("preserves CRLF line endings", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n");
			const call = await runEdit(root, custom, {
				path: "crlf.txt",
				// oldText may be written with LF; matching happens on normalized text.
				edits: [{ oldText: "beta\ngamma", newText: "BETA\nGAMMA" }],
			});
			expect(call.status).toBe("completed");
			expect(await read(root, "crlf.txt")).toBe("alpha\r\nBETA\r\nGAMMA\r\n");
		}));

	it("preserves a UTF-8 BOM", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "bom.txt"), "\uFEFFalpha\nbeta\n");
			const call = await runEdit(root, custom, {
				path: "bom.txt",
				edits: [{ oldText: "beta", newText: "BETA" }],
			});
			expect(call.status).toBe("completed");
			expect(await read(root, "bom.txt")).toBe("\uFEFFalpha\nBETA\n");
		}));

	it("serializes concurrent edits to the same file", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const calls = await runEdits(root, custom, [
				{ path: "sample.ts", edits: [{ oldText: "const one = 1;", newText: "const one = 100;" }] },
				{ path: "sample.ts", edits: [{ oldText: "const one = 1;", newText: "const one = 200;" }] },
			]);
			expect(calls.map((call) => call.status).sort()).toEqual(["completed", "error"]);
			const failed = calls.find((call) => call.status === "error");
			if (failed === undefined) throw new Error("expected one failed edit");
			expect(errorDetailsOf(failed).reason).toBe("no_match");
			// Exactly one writer won; the lock prevented a lost update.
			const file = await read(root, "sample.ts");
			expect(["const one = 100;", "const one = 200;"].filter((line) => file.includes(line))).toHaveLength(1);
		}));
});

/**
 * The verifiable artifact: every edit outcome on a fixed fixture, including the
 * resulting file where the call wrote one. Regenerate with `-u` on drift.
 */
describe("edit artifact", () => {
	it("produces the edit report artifact", () =>
		withSettings(async ({ root, custom }) => {
			const scenarios: ReadonlyArray<[string, Record<string, unknown>, string?]> = [
				[
					"single",
					{ path: "sample.ts", edits: [{ oldText: "const two = 2;", newText: "const two = 22;" }] },
					"sample.ts",
				],
				[
					"multi",
					{
						path: "sample.ts",
						edits: [
							{ oldText: "const one = 1;", newText: "const one = 100;" },
							{ oldText: "const three = 3;", newText: "const three = 300;" },
						],
					},
					"sample.ts",
				],
				["create", { path: "made.txt", edits: [{ oldText: "", newText: "made\n" }] }, "made.txt"],
				["no-match", { path: "sample.ts", edits: [{ oldText: "absent", newText: "present" }] }, "sample.ts"],
				["ambiguous", { path: "dup.ts", edits: [{ oldText: "const a = 1;", newText: "const a = 2;" }] }, "dup.ts"],
				[
					"overlap",
					{
						path: "sample.ts",
						edits: [
							{ oldText: "const one = 1;\nconst two = 2;", newText: "X" },
							{ oldText: "const two = 2;\nconst three = 3;", newText: "Y" },
						],
					},
					"sample.ts",
				],
				[
					"no-change",
					{ path: "sample.ts", edits: [{ oldText: "const one = 1;", newText: "const one = 1;" }] },
					"sample.ts",
				],
				["no-edits", { path: "sample.ts", edits: [] }, "sample.ts"],
				["create-rejected", { path: "made.txt", edits: [{ oldText: "x", newText: "y" }] }],
				["empty-old-text", { path: "sample.ts", edits: [{ oldText: "", newText: "replaced" }] }, "sample.ts"],
			];

			const report = [];
			for (const [name, args, after] of scenarios) {
				// Each scenario starts from the same fixture, so the `create` case does
				// not leak a `made.txt` into the `create-rejected` case.
				await rm(join(root, "made.txt"), { force: true });
				await seed(root);
				await writeFile(join(root, "dup.ts"), "const a = 1;\nconst a = 1;\n");
				const call = await runEdit(root, custom, args);
				const details = call.result as { details?: Record<string, unknown> } | undefined;
				if (details?.details === undefined) throw new Error(`${name}: edit call has no details`);
				report.push({
					name,
					status: call.status,
					details: details.details,
					...(after === undefined ? {} : { file: await read(root, after) }),
				});
			}
			await expect(report).toMatchFileSnapshot("./__artifacts__/tool.edit.json");
		}));
});
