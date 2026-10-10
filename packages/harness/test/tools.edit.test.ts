import "./utils/env.ts";
import { applyPatch } from "diff";
import { Deferred, Effect, Fiber, Layer } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { SandboxMutation } from "@codeworksh/plugin/sandbox/mutation";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { editPlugin, editTool } from "../src/plugin/builtin/tool/edit.ts";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import * as Executor from "../src/tool/executor.ts";
import * as Tool from "../src/tool/tool.ts";
import { gatedProvider } from "./fixtures/gated.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const sp = " ";
const gap = Array.from({ length: 600 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n") + "\n";

/**
 * Pi's edit cases, each on its own file: the file before the turn (`null` for
 * none) and the raw arguments of one `edit` call, exactly as a model sent them.
 */
const cases: ReadonlyArray<{ readonly name: string; readonly before: string | null; readonly args: unknown }> = [
	// replacement
	{ name: "single", before: "hello world\n", args: { edits: [{ oldText: "world", newText: "pi" }] } },
	{
		name: "multi-disjoint",
		before: "alpha\nbeta\ngamma\ndelta\n",
		args: {
			edits: [
				{ oldText: "alpha\n", newText: "ALPHA\n" },
				{ oldText: "gamma\n", newText: "GAMMA\n" },
			],
		},
	},
	{
		name: "multi-large-gap",
		before: gap,
		args: {
			edits: [
				{ oldText: "line 100\n", newText: "LINE 100\n" },
				{ oldText: "line 300\n", newText: "LINE 300\n" },
				{ oldText: "line 500\n", newText: "LINE 500\n" },
			],
		},
	},
	{
		name: "against-original",
		before: "foo\nbar\nbaz\n",
		args: {
			edits: [
				{ oldText: "foo\n", newText: "foo bar\n" },
				{ oldText: "bar\n", newText: "BAR\n" },
			],
		},
	},
	// rejected edits
	{ name: "empty-edits", before: "hello\nworld\n", args: { edits: [] } },
	{
		name: "overlap",
		before: "one\ntwo\nthree\n",
		args: {
			edits: [
				{ oldText: "one\ntwo\n", newText: "ONE\nTWO\n" },
				{ oldText: "two\nthree\n", newText: "TWO\nTHREE\n" },
			],
		},
	},
	{
		name: "no-partial-apply",
		before: "alpha\nbeta\ngamma\n",
		args: {
			edits: [
				{ oldText: "alpha\n", newText: "ALPHA\n" },
				{ oldText: "missing\n", newText: "MISSING\n" },
			],
		},
	},
	{ name: "not-found", before: "foo bar\n", args: { edits: [{ oldText: "baz", newText: "qux" }] } },
	{ name: "duplicate", before: "foo foo foo", args: { edits: [{ oldText: "foo", newText: "bar" }] } },
	{
		name: "duplicate-multi",
		before: "a\nfoo\nfoo\n",
		args: {
			edits: [
				{ oldText: "a\n", newText: "A\n" },
				{ oldText: "foo", newText: "bar" },
			],
		},
	},
	{ name: "empty-old-text", before: "x\n", args: { edits: [{ oldText: "", newText: "y" }] } },
	{ name: "no-change", before: "same\n", args: { edits: [{ oldText: "same", newText: "same" }] } },
	{ name: "missing-file", before: null, args: { edits: [{ oldText: "a", newText: "b" }] } },
	{ name: "read-only", before: "hello\n", args: { edits: [{ oldText: "hello", newText: "bye" }] } },
	{ name: "directory", before: null, args: { edits: [{ oldText: "a", newText: "b" }] } },
	{ name: "symlink", before: null, args: { edits: [{ oldText: "target", newText: "edited" }] } },
	// fuzzy matching
	{
		name: "fuzzy-trailing-whitespace",
		before: "line one   \nline two  \nline three\n",
		args: { edits: [{ oldText: "line one\nline two\n", newText: "replaced\n" }] },
	},
	{
		name: "fuzzy-fullwidth",
		before: "你好，世界\n你好（世界）\n",
		args: { edits: [{ oldText: "你好,世界\n你好(世界)\n", newText: "你好，pi\n你好(pi)\n" }] },
	},
	{
		name: "fuzzy-nfkc",
		before: "ＡＢＣ１２３\ncafé\n",
		args: { edits: [{ oldText: "ABC123\ncafé\n", newText: "XYZ789\ncoffee\n" }] },
	},
	{
		name: "fuzzy-smart-single",
		before: "console.log(‘hello’);\n",
		args: { edits: [{ oldText: "console.log('hello');", newText: "console.log('world');" }] },
	},
	{
		name: "fuzzy-smart-double",
		before: "const msg = “Hello World”;\n",
		args: { edits: [{ oldText: 'const msg = "Hello World";', newText: 'const msg = "Goodbye";' }] },
	},
	{
		name: "fuzzy-dashes",
		before: "range: 1–5\nbreak—here\n",
		args: { edits: [{ oldText: "range: 1-5\nbreak-here", newText: "range: 10-50\nbreak--here" }] },
	},
	{
		name: "fuzzy-nbsp",
		before: "hello world\n",
		args: { edits: [{ oldText: "hello world", newText: "hello universe" }] },
	},
	{
		name: "fuzzy-prefers-exact",
		before: "const x = 'exact';\nconst y = 'other';\n",
		args: { edits: [{ oldText: "const x = 'exact';", newText: "const x = 'changed';" }] },
	},
	{
		name: "fuzzy-not-found",
		before: "completely different content\n",
		args: { edits: [{ oldText: "this does not exist", newText: "replacement" }] },
	},
	{
		name: "fuzzy-duplicate",
		before: "hello world   \nhello world\n",
		args: { edits: [{ oldText: "hello world", newText: "replaced" }] },
	},
	{
		name: "fuzzy-multi",
		before: "console.log(‘hello’);\nhello world\n",
		args: {
			edits: [
				{ oldText: "console.log('hello');\n", newText: "console.log('world');\n" },
				{ oldText: "hello world\n", newText: "hello universe\n" },
			],
		},
	},
	{
		name: "fuzzy-preserve-duplicate-line",
		before: [`replace me${sp.repeat(3)}`, `after${sp.repeat(3)}`, ""].join("\n"),
		args: { edits: [{ oldText: "replace me\n", newText: "after\n" }] },
	},
	{
		name: "fuzzy-preserve-multi",
		before: [
			`keep before${sp.repeat(2)}`,
			`first target${sp.repeat(2)}`,
			"first after",
			`keep middle${sp.repeat(3)}`,
			`second target${sp.repeat(2)}`,
			"second after",
			`keep after${sp.repeat(2)}`,
			"",
		].join("\n"),
		args: {
			edits: [
				{ oldText: "first target\nfirst after", newText: "FIRST\nFIRST2" },
				{ oldText: "second target\nsecond after", newText: "SECOND\nSECOND2" },
			],
		},
	},
	// line endings and BOM
	{
		name: "crlf-lf-old-text",
		before: "line one\r\nline two\r\nline three\r\n",
		args: { edits: [{ oldText: "line two\n", newText: "replaced line\n" }] },
	},
	{
		name: "lf-preserved",
		before: "first\nsecond\nthird\n",
		args: { edits: [{ oldText: "second\n", newText: "REPLACED\n" }] },
	},
	{
		name: "crlf-duplicates",
		before: "hello\r\nworld\r\n---\r\nhello\nworld\n",
		args: { edits: [{ oldText: "hello\nworld\n", newText: "replaced\n" }] },
	},
	{
		name: "bom-crlf",
		before: "﻿first\r\nsecond\r\nthird\r\n",
		args: { edits: [{ oldText: "second\n", newText: "REPLACED\n" }] },
	},
	{
		name: "bom-crlf-multi",
		before: "﻿first\r\nsecond\r\nthird\r\nfourth\r\n",
		args: {
			edits: [
				{ oldText: "second\n", newText: "SECOND\n" },
				{ oldText: "fourth\n", newText: "FOURTH\n" },
			],
		},
	},
	// argument shapes models send
	{
		name: "args-json-string",
		before: "a b\n",
		args: { edits: JSON.stringify([{ oldText: "a", newText: "A" }]) },
	},
	{
		name: "args-json-string-object",
		before: "a b\n",
		args: { edits: JSON.stringify({ oldText: "a", newText: "A" }) },
	},
	{ name: "args-single-object", before: "a b\n", args: { edits: { oldText: "a", newText: "A" } } },
	{ name: "args-top-level", before: "a b\n", args: { oldText: "a", newText: "A" } },
	{
		name: "args-top-level-appended",
		before: "a b\n",
		args: { edits: [{ oldText: "a", newText: "A" }], oldText: "b", newText: "B" },
	},
	{ name: "args-invalid-json", before: "a b\n", args: { edits: "not json" } },
];

const editAll = (root: string, custom: string) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root, model: { provider: "openai", id: "gpt-5.6-luna" } });
		yield* session.run("Edit the files.");
		const path = yield* session.path();
		expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		return messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				hostCwd: root,
				userConfigDir: custom,
				database: ":memory:",
				plugins: [editPlugin, defaultPromptPlugin],
				llm: toolTurn(
					...cases.map((entry) =>
						pendingCall("edit", { path: `${entry.name}.txt`, ...(entry.args as object) }, entry.name),
					),
				),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

describe("edit plugin through the local harness", () => {
	it("replaces, matches fuzzily, keeps line endings and reports failures like Pi", () =>
		withSettings(async ({ root, custom }) => {
			const work = join(root, "work");
			await fs.mkdir(work);
			for (const { name, before } of cases) {
				if (before !== null) await fs.writeFile(join(work, `${name}.txt`), before);
			}
			await fs.chmod(join(work, "read-only.txt"), 0o444);
			await fs.mkdir(join(work, "directory.txt"));
			await fs.writeFile(join(work, "symlink-target.txt"), "target\n");
			await fs.symlink("symlink-target.txt", join(work, "symlink.txt"));

			const calls = await editAll(work, custom);
			const results: Record<string, unknown> = {};
			for (const { name, before } of cases) {
				const call = calls.find((part) => part.type === "toolCall" && part.callID === name);
				if (call?.type !== "toolCall" || (call.status !== "completed" && call.status !== "error"))
					throw new Error(`${name} was not settled`);
				const after = await fs.readFile(join(work, `${name}.txt`), "utf8").catch(() => null);
				const details = call.result.details as { patch?: string } | undefined;
				// Pi's own check: the patch turns the file as it was into the file as it is.
				if (call.status === "completed" && before !== null)
					expect(applyPatch(before.replace(/^﻿/, "").replace(/\r\n/g, "\n"), details?.patch ?? "")).toBe(
						after?.replace(/^﻿/, "").replace(/\r\n/g, "\n"),
					);
				results[name] = {
					status: call.status,
					content: call.result.content,
					...(details === undefined ? {} : { details }),
					...(before === null || after === before ? {} : { after }),
				};
			}
			// A repaired call keeps the arguments the model sent.
			const repaired = calls.find((part) => part.type === "toolCall" && part.callID === "args-json-string");
			expect(repaired?.type === "toolCall" && typeof repaired.arguments.edits).toBe("string");
			expect(await fs.readFile(join(work, "symlink-target.txt"), "utf8")).toBe("edited\n");

			const json = JSON.stringify(results, null, "\t")
				.replaceAll(await fs.realpath(work), "<root>")
				.replaceAll(work, "<root>");
			await expect(json + "\n").toMatchFileSnapshot("./__artifacts__/tools.edit.json");
		}));
});

describe("edit under cancellation", () => {
	it("keeps the file locked until an interrupted edit write settles", () =>
		Effect.gen(function* () {
			const dir = (yield* Effect.acquireRelease(Effect.promise(tmpdir), (temp) =>
				Effect.promise(() => temp[Symbol.asyncDispose]()),
			)).path;
			yield* Effect.promise(() => fs.writeFile(join(dir, "file.txt"), "base\n"));
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const gated = gatedProvider(dir, started, release);
			const filesystem = SandboxFileSystem.fromProvider(gated.provider);
			const executor = Executor.make([
				Tool.provide(
					editTool,
					Layer.merge(
						Layer.succeed(SandboxIO.FileSystem, filesystem),
						Layer.succeed(SandboxIO.Mutation, SandboxMutation.make(SandboxInstance.ID.local, "/", filesystem)),
					),
				),
			]);
			const edit = (newText: string, callID: string) =>
				executor.handle(pendingCall("edit", { path: "file.txt", edits: [{ oldText: "base", newText }] }, callID));

			const first = yield* edit("first", "first").pipe(Effect.forkChild);
			yield* Deferred.await(started);
			// Interrupting waits for the write it cannot call back, so it runs on its own fiber.
			const interrupting = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
			const second = yield* executor
				.handle(
					pendingCall("edit", { path: "file.txt", edits: [{ oldText: "first", newText: "second" }] }, "second"),
				)
				.pipe(Effect.forkChild);
			yield* Effect.sleep("30 millis");
			expect(gated.secondStarted()).toBe(false);

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(interrupting);
			// The second edit saw the first one's write: the lock held until it landed.
			expect((yield* Fiber.join(second)).status).toBe("completed");
			expect(yield* Effect.promise(() => fs.readFile(join(dir, "file.txt"), "utf8"))).toBe("second\n");
		}).pipe(Effect.scoped, Effect.runPromise));
});
