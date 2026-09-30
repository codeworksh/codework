import "./utils/env.ts";
import { Effect } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { readPlugin } from "../src/plugin/builtin/tool/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../src/tool/truncate.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/** One scripted `read` call through plugin setup, the local mount, and durable settlement. */
const read = (root: string, custom: string, args: Record<string, unknown>) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root });
		yield* session.run("Read the file.");
		const path = yield* session.path();
		expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		const calls = messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined || call.type !== "toolCall" || (call.status !== "completed" && call.status !== "error")) {
			throw new Error("read was not settled");
		}
		expect(call.name).toBe("read");
		return call;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				hostCwd: root,
				userConfigDir: custom,
				database: ":memory:",
				plugins: [readPlugin, defaultPromptPlugin],
				llm: toolTurn(pendingCall("read", args)),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

describe("read plugin through the local harness", () => {
	it("numbers a file in the session directory", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "hello.txt"), "alpha\nbeta\n");
			const call = await read(root, custom, { path: "hello.txt" });
			expect(call.status).toBe("completed");
			expect(call.result).toMatchObject({
				isError: false,
				content: [{ type: "text", text: "1|alpha\n2|beta" }],
				details: {
					content: "1|alpha\n2|beta",
					truncated: false,
					path: "hello.txt",
					startLine: 1,
					endLine: 2,
					totalLines: 2,
				},
			});
		}));

	it("numbers from an offset inside the file", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "hello.txt"), "one\ntwo\nthree\n");
			const call = await read(root, custom, { path: "hello.txt", offset: 2 });
			expect(call.status).toBe("completed");
			expect(call.result).toMatchObject({
				isError: false,
				details: {
					content: "2|two\n3|three",
					truncated: false,
					path: "hello.txt",
					startLine: 2,
					endLine: 3,
					totalLines: 3,
				},
			});
		}));

	it("keeps the head of a long file and names the next offset", () =>
		withSettings(async ({ root, custom }) => {
			const total = DEFAULT_MAX_LINES + 1;
			const body = Array.from({ length: total }, (_, index) => String(index + 1)).join("\n");
			await writeFile(join(root, "long.txt"), body);
			const call = await read(root, custom, { path: "long.txt" });
			expect(call.status).toBe("completed");
			const width = String(total).length;
			const numbered = Array.from({ length: DEFAULT_MAX_LINES }, (_, index) => {
				const line = index + 1;
				return `${String(line).padStart(width, " ")}|${line}`;
			}).join("\n");
			const content = `${numbered}\n\n[showing lines 1-${DEFAULT_MAX_LINES} of ${total}. Read again with offset ${DEFAULT_MAX_LINES + 1}.]`;
			expect(call.result).toMatchObject({
				isError: false,
				details: {
					content,
					truncated: true,
					path: "long.txt",
					startLine: 1,
					endLine: DEFAULT_MAX_LINES,
					totalLines: total,
				},
			});
		}));

	it("reports a missing path", () =>
		withSettings(async ({ root, custom }) => {
			const call = await read(root, custom, { path: "missing.txt" });
			expect(call.status).toBe("error");
			expect(call.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "File not found: missing.txt" }],
				details: {
					_tag: "ReadFailed",
					path: "missing.txt",
					reason: "not_found",
					message: "File not found: missing.txt",
				},
			});
		}));

	it("reports a directory", () =>
		withSettings(async ({ root, custom }) => {
			await mkdir(join(root, "folder"));
			const call = await read(root, custom, { path: "folder" });
			expect(call.status).toBe("error");
			expect(call.result).toMatchObject({
				isError: true,
				details: { _tag: "ReadFailed", path: "folder", reason: "not_a_file", message: "Not a file: folder" },
			});
		}));

	it("reports a binary file without returning its bytes", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "bin.dat"), Buffer.from([0x68, 0x00, 0x69]));
			const call = await read(root, custom, { path: "bin.dat" });
			expect(call.status).toBe("error");
			expect(call.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: "Binary file: bin.dat" }],
				details: { _tag: "ReadFailed", path: "bin.dat", reason: "binary", message: "Binary file: bin.dat" },
			});
		}));

	it("reports an offset past the end", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(root, "short.txt"), "only\n");
			const call = await read(root, custom, { path: "short.txt", offset: 3 });
			expect(call.status).toBe("error");
			expect(call.result).toMatchObject({
				isError: true,
				details: {
					_tag: "ReadFailed",
					path: "short.txt",
					reason: "offset_out_of_range",
					message: "Offset 3 is past the end of short.txt (1 line).",
				},
			});
		}));

	it("reports a line longer than the byte limit", () =>
		withSettings(async ({ root, custom }) => {
			const bytes = DEFAULT_MAX_BYTES + 1;
			await writeFile(join(root, "wide.txt"), "a".repeat(bytes));
			const call = await read(root, custom, { path: "wide.txt" });
			const message = `Line 1 is ${bytes} bytes, over the ${formatSize(DEFAULT_MAX_BYTES)} read limit.`;
			expect(call.status).toBe("error");
			expect(call.result).toMatchObject({
				isError: true,
				content: [{ type: "text", text: message }],
				details: { _tag: "ReadFailed", path: "wide.txt", reason: "line_too_long", message },
			});
		}));
});
