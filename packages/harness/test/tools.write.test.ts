import "./utils/env.ts";
import { Deferred, Effect, Fiber, Layer } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { writePlugin, writeTool } from "../src/plugin/builtin/tool/write.ts";
import { SandboxFileSystem } from "../src/sandbox/fs/filesystem.ts";
import { SandboxIO } from "../src/sandbox/io.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { SandboxMutation } from "@codeworksh/plugin/sandbox/mutation";
import * as Executor from "../src/tool/executor.ts";
import * as Tool from "../src/tool/tool.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

/** Each case: files that exist before the turn, and the arguments of one `write` call. */
const cases: ReadonlyArray<{
	readonly name: string;
	readonly before?: readonly [string, string];
	readonly args: Record<string, unknown>;
}> = [
	{ name: "new", args: { path: "new.txt", content: "hello\n" } },
	{ name: "parents", args: { path: "nested/dir/file.txt", content: "deep\n" } },
	{ name: "overwrite", before: ["existing.txt", "old content\n"], args: { path: "existing.txt", content: "new\n" } },
	{ name: "empty", before: ["cleared.txt", "something\n"], args: { path: "cleared.txt", content: "" } },
	{ name: "unicode", args: { path: "unicode.txt", content: "héllo wörld 🚀\r\nline two" } },
	{ name: "at-prefix", args: { path: "@mention.txt", content: "via mention\n" } },
	{ name: "unicode-space", args: { path: "two words.txt", content: "spaced\n" } },
	{ name: "parent-is-file", before: ["blocker", "a file\n"], args: { path: "blocker/child.txt", content: "x" } },
	{ name: "directory", before: ["dir/inside.txt", "x"], args: { path: "dir", content: "x" } },
	{ name: "invalid-arguments", args: { path: "missing-content.txt" } },
];

const writeAll = (root: string, custom: string) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root, model: { provider: "openai", id: "gpt-5.6-luna" } });
		yield* session.run("Write the files.");
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
				plugins: [writePlugin, defaultPromptPlugin],
				llm: toolTurn(...cases.map((entry) => pendingCall("write", entry.args, entry.name))),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

/** Every regular file under `dir`, relative path → content. */
const tree = async (dir: string, prefix = ""): Promise<Record<string, string>> => {
	const out: Record<string, string> = {};
	for (const entry of (await fs.readdir(join(dir, prefix), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const relative = join(prefix, entry.name);
		if (entry.isDirectory()) Object.assign(out, await tree(dir, relative));
		else out[relative] = await fs.readFile(join(dir, relative), "utf8");
	}
	return out;
};

describe("write plugin through the local harness", () => {
	it("creates, overwrites and reports failures like Pi", () =>
		withSettings(async ({ root, custom }) => {
			const work = join(root, "work");
			await fs.mkdir(work);
			for (const { before } of cases) {
				if (before === undefined) continue;
				await fs.mkdir(join(work, before[0], ".."), { recursive: true });
				await fs.writeFile(join(work, before[0]), before[1]);
			}

			const calls = await writeAll(work, custom);
			const results = Object.fromEntries(
				cases.map(({ name }) => {
					const call = calls.find((part) => part.type === "toolCall" && part.callID === name);
					if (call?.type !== "toolCall" || (call.status !== "completed" && call.status !== "error"))
						throw new Error(`${name} was not settled`);
					return [
						name,
						{
							status: call.status,
							content: call.result.content,
							...(call.result.details === undefined ? {} : { details: call.result.details }),
						},
					];
				}),
			);
			const report = { results, files: await tree(work) };
			// Errors name absolute paths; the artifact names them under `<root>`.
			const json = JSON.stringify(report, null, "\t")
				.replaceAll(await fs.realpath(work), "<root>")
				.replaceAll(work, "<root>");
			await expect(json + "\n").toMatchFileSnapshot("./__artifacts__/tools.write.json");
		}));
});

/**
 * A host-directory provider whose first write blocks until released: a write in
 * flight that an interrupt cannot call back.
 */
const gatedProvider = (dir: string, started: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => {
	let writes = 0;
	const at = (path: string) => join(dir, path);
	return {
		secondStarted: () => writes > 1,
		provider: {
			readFile: (path) => fs.readFile(at(path), "utf8"),
			readFileBuffer: async (path) => new Uint8Array(await fs.readFile(at(path))),
			readBytes: () => Promise.reject(new Error("unused")),
			writeFile: async (path, content) => {
				writes++;
				if (writes === 1) {
					Deferred.doneUnsafe(started, Effect.void);
					await Effect.runPromise(Deferred.await(release));
				}
				await fs.writeFile(at(path), content);
			},
			stat: async (path) => {
				const stat = await fs.stat(at(path));
				return { isFile: stat.isFile(), isDirectory: stat.isDirectory() };
			},
			readdir: (path) => fs.readdir(at(path)),
			exists: (path) =>
				fs.stat(at(path)).then(
					() => true,
					() => false,
				),
			mkdir: async (path, options) => {
				await fs.mkdir(at(path), options);
			},
			rm: (path, options) => fs.rm(at(path), options),
			realpath: (path) => fs.realpath(at(path)),
			scanLines: () => Promise.reject(new Error("unused")),
		} satisfies SandboxFileSystem.Provider,
	};
};

describe("write under cancellation", () => {
	it("keeps the file locked until an interrupted write settles", () =>
		Effect.gen(function* () {
			const dir = (yield* Effect.acquireRelease(Effect.promise(tmpdir), (temp) =>
				Effect.promise(() => temp[Symbol.asyncDispose]()),
			)).path;
			const started = yield* Deferred.make<void>();
			const release = yield* Deferred.make<void>();
			const gated = gatedProvider(dir, started, release);
			const filesystem = SandboxFileSystem.fromProvider(gated.provider);
			const executor = Executor.make([
				Tool.provide(
					writeTool,
					Layer.merge(
						Layer.succeed(SandboxIO.FileSystem, filesystem),
						Layer.succeed(SandboxIO.Mutation, SandboxMutation.make(SandboxInstance.ID.local, "/", filesystem)),
					),
				),
			]);

			const first = yield* executor
				.handle(pendingCall("write", { path: "file.txt", content: "first\n" }, "first"))
				.pipe(Effect.forkChild);
			yield* Deferred.await(started);
			// Interrupting waits for the write it cannot call back, so it runs on its own fiber.
			const interrupting = yield* Fiber.interrupt(first).pipe(Effect.forkChild);
			const second = yield* executor
				.handle(pendingCall("write", { path: "file.txt", content: "second\n" }, "second"))
				.pipe(Effect.forkChild);
			yield* Effect.sleep("30 millis");
			expect(gated.secondStarted()).toBe(false);

			yield* Deferred.succeed(release, undefined);
			yield* Fiber.join(interrupting);
			const outcome = yield* Fiber.join(second);
			expect(outcome.status).toBe("completed");
			expect(yield* Effect.promise(() => fs.readFile(join(dir, "file.txt"), "utf8"))).toBe("second\n");
		}).pipe(Effect.scoped, Effect.runPromise));
});
