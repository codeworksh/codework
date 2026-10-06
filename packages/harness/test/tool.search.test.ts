import "./utils/env.ts";
import { Effect, Layer } from "effect";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { searchHandler, searchPlugin } from "../src/plugin/builtin/tool/search.ts";
import { Sandbox } from "../src/sandbox/sandbox.ts";
import { type IToolShell, ToolShell } from "../src/tool/shell.ts";
import * as Tool from "../src/tool/tool.ts";
import { toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/** One scripted `search` call through plugin setup, the local mount, and durable settlement. */
const runSearch = (root: string, custom: string, args: Record<string, unknown>) =>
	Effect.gen(function* () {
		const session = yield* Session.create({ directory: root });
		yield* session.run("Search.");
		const path = yield* session.path();
		expect(path.every((entry) => entry.entry.state === "committed")).toBe(true);
		const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
		const calls = messages.flatMap((message) => message.parts.filter((part) => part.type === "toolCall"));
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined || call.type !== "toolCall" || (call.status !== "completed" && call.status !== "error")) {
			throw new Error("search was not settled");
		}
		expect(call.name).toBe("search");
		return call;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(root, "home"),
				hostCwd: root,
				userConfigDir: custom,
				database: ":memory:",
				plugins: [searchPlugin, defaultPromptPlugin],
				llm: toolTurn(pendingCall("search", args)),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

interface SearchDetails {
	readonly content: string;
	readonly matches: number;
	readonly files: number;
	readonly truncated: boolean;
	readonly hasMore: boolean;
	readonly backend: string;
}

const detailsOf = (call: { result: unknown }): SearchDetails => {
	const result = call.result as { details?: SearchDetails } | undefined;
	if (result?.details === undefined) throw new Error("search call has no details");
	return result.details;
};

const errorDetailsOf = (call: { result: unknown }): { _tag: string; reason: string; message: string } => {
	const result = call.result as
		| { isError?: boolean; details?: { _tag: string; reason: string; message: string } }
		| undefined;
	if (result?.details === undefined) throw new Error("search call has no details");
	return result.details;
};

/**
 * A small repository whose every file exercises one selection rule: tracked
 * source, a docs file, a binary, a gitignored log, and an ignored dependency
 * tree. Shared by the focused cases and the artifact case so both read the same
 * fixture.
 */
const seed = async (root: string) => {
	await mkdir(join(root, "src"), { recursive: true });
	await mkdir(join(root, "docs"), { recursive: true });
	await mkdir(join(root, "node_modules/pkg"), { recursive: true });
	await writeFile(
		join(root, "src/auth.ts"),
		'import { db } from "./db";\nexport function authenticate(user: User) {\n  return db.find(user);\n}\n// TODO: add rate limiting\n',
	);
	await writeFile(join(root, "src/utils.ts"), 'export const VERSION = "1.0.0";\n');
	await writeFile(join(root, "docs/guide.md"), "# Authentication guide\nCall authenticate() to log in.\n");
	await writeFile(join(root, "node_modules/pkg/index.js"), "export const authenticate = () => {};\n");
	await writeFile(join(root, "debug.log"), "authenticate called\n");
	await writeFile(join(root, "image.bin"), Buffer.from([0x00, 0x61, 0x75, 0x74, 0x68, 0x00]));
	await writeFile(join(root, ".gitignore"), "node_modules\n*.log\n");
};

describe("search plugin through the local harness", () => {
	it("groups content matches by file and skips gitignored, hidden, and binary files", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runSearch(root, custom, { query: "authenticate" });
			expect(call.status).toBe("completed");
			const details = detailsOf(call);
			expect(details).toMatchObject({ matches: 2, files: 2, truncated: false, hasMore: false });
			expect(details.content).toContain("docs/guide.md:");
			expect(details.content).toContain("  2: Call authenticate() to log in.");
			expect(details.content).toContain("src/auth.ts:");
			expect(details.content).toContain("  2: export function authenticate(user: User) {");
			// node_modules is ignored, debug.log is gitignored, image.bin is binary.
			expect(details.content).not.toContain("node_modules");
			expect(details.content).not.toContain("debug.log");
			expect(details.content).not.toContain("image.bin");
		}));

	it("restricts content search with an include glob", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const details = detailsOf(await runSearch(root, custom, { query: "authenticate", include: "*.md" }));
			expect(details).toMatchObject({ matches: 1, files: 1 });
			expect(details.content).toContain("docs/guide.md:");
			expect(details.content).not.toContain("src/auth.ts");
		}));

	it("treats the query as a literal string when literal is set", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const details = detailsOf(await runSearch(root, custom, { query: "db.find", literal: true }));
			expect(details).toMatchObject({ matches: 1, files: 1 });
			expect(details.content).toContain("  3:   return db.find(user);");
		}));

	it("shows context lines around a match", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const details = detailsOf(await runSearch(root, custom, { query: "rate limiting", context: 1 }));
			expect(details.matches).toBe(1);
			expect(details.content).toContain("  4- }");
			expect(details.content).toContain("  5: // TODO: add rate limiting");
		}));

	it("includes gitignored and hidden files when noIgnore is set", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const details = detailsOf(await runSearch(root, custom, { query: "authenticate", noIgnore: true }));
			expect(details).toMatchObject({ matches: 4, files: 4 });
			expect(details.content).toContain("node_modules/pkg/index.js:");
			expect(details.content).toContain("debug.log:");
			expect(details.content).not.toContain("image.bin"); // still binary
		}));

	it("paginates matches with limit and offset", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const first = detailsOf(await runSearch(root, custom, { query: "authenticate", limit: 1 }));
			expect(first).toMatchObject({ matches: 1, hasMore: true, truncated: true });
			expect(first.content).toContain("continue with offset 1");
			const second = detailsOf(await runSearch(root, custom, { query: "authenticate", offset: 1, limit: 1 }));
			expect(second.matches).toBe(1);
			expect(second.content).toContain("src/auth.ts:");
		}));

	it("finds files by glob and by plain path fragment", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const globbed = detailsOf(await runSearch(root, custom, { mode: "files", query: "*.ts" }));
			expect(globbed).toMatchObject({ matches: 2, files: 2 });
			expect(globbed.content).toContain("src/auth.ts");
			expect(globbed.content).toContain("src/utils.ts");
			expect(globbed.content).not.toContain("node_modules");

			const needle = detailsOf(await runSearch(root, custom, { mode: "files", query: "auth" }));
			expect(needle).toMatchObject({ matches: 1, files: 1 });
			expect(needle.content).toContain("src/auth.ts");
		}));

	it("reports an invalid regular expression", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runSearch(root, custom, { query: "[" });
			expect(call.status).toBe("error");
			expect((call.result as { isError: boolean }).isError).toBe(true);
			const details = errorDetailsOf(call);
			expect(details._tag).toBe("SearchFailed");
			expect(details.reason).toBe("invalid_pattern");
		}));

	it("reports a missing path", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const call = await runSearch(root, custom, { query: "anything", path: "does-not-exist" });
			expect(call.status).toBe("error");
			const details = errorDetailsOf(call);
			expect(details._tag).toBe("SearchFailed");
			expect(details.reason).toBe("path_not_found");
		}));
});

/**
 * The ripgrep backend is chosen by probing the shell, then parsed from rg's
 * JSON-lines wire format. This is the one part of the tool a host E2E cannot
 * pin (the backend depends on whether `rg` is installed), and it is exactly the
 * wire-parsing class of bug worth an isolated test.
 */
describe("search ripgrep backend (wire parsing)", () => {
	it("parses rg --json matches and context into grouped output", async () => {
		const argvCalls: string[][] = [];
		const json = [
			{ type: "begin", data: { path: { text: "src/a.ts" } } },
			{ type: "context", data: { path: { text: "src/a.ts" }, lines: { text: "before line\n" }, line_number: 2 } },
			{
				type: "match",
				data: { path: { text: "src/a.ts" }, lines: { text: "authenticate here\n" }, line_number: 3 },
			},
			{ type: "context", data: { path: { text: "src/a.ts" }, lines: { text: "after line\n" }, line_number: 4 } },
			{
				type: "match",
				data: { path: { text: "src/a.ts" }, lines: { text: "authenticate again\n" }, line_number: 5 },
			},
			{ type: "context", data: { path: { text: "src/a.ts" }, lines: { text: "tail line\n" }, line_number: 6 } },
			{ type: "begin", data: { path: { text: "b.ts" } } },
			{ type: "match", data: { path: { text: "b.ts" }, lines: { text: "authenticate\n" }, line_number: 1 } },
			{ type: "summary", data: {} },
		]
			.map((event) => JSON.stringify(event))
			.join("\n");

		const shell: IToolShell = {
			exec: () => Effect.die(new Error("exec is unused in ripgrep mode")),
			execArgv: (argv) => {
				argvCalls.push([...argv]);
				return Effect.succeed(
					argv[0] === "rg" && argv[1] === "--version"
						? { stdout: "ripgrep 14.1.0\n", stderr: "", exitCode: 0 }
						: { stdout: json, stderr: "", exitCode: 0 },
				);
			},
		};
		const context: Tool.ToolCallContext = { callID: "c1", toolName: "search", rawArgs: {} };

		const result = await Effect.runPromise(
			searchHandler({ query: "authenticate", context: 1 }, context).pipe(
				Effect.provide(Layer.merge(Sandbox.memory(), Layer.succeed(ToolShell, shell))),
			),
		);

		expect(result.backend).toBe("ripgrep");
		expect(result).toMatchObject({ matches: 3, files: 2, truncated: false, hasMore: false });
		expect(result.content).toContain("src/a.ts:");
		expect(result.content).toContain("  2- before line");
		expect(result.content).toContain("  3: authenticate here");
		expect(result.content).toContain("  4- after line");
		expect(result.content).toContain("  5: authenticate again");
		expect(result.content).toContain("  6- tail line");
		expect(result.content).toContain("b.ts:");

		const searchArgv = argvCalls.find((argv) => argv.includes("--json"));
		expect(searchArgv).toBeDefined();
		expect(searchArgv).toContain("-C");
		expect(searchArgv).toContain("1");
	});
});

/**
 * The verifiable artifact: the same fixture queried in every mode, with the
 * backend label normalised so the snapshot is identical whether the machine's
 * ripgrep backend or the in-process walk ran. Regenerate with `-u` on drift.
 */
describe("search artifact", () => {
	it("produces the search report artifact", () =>
		withSettings(async ({ root, custom }) => {
			await seed(root);
			const args: ReadonlyArray<[string, Record<string, unknown>]> = [
				["content-default", { query: "authenticate" }],
				["content-include-md", { query: "authenticate", include: "*.md" }],
				["content-literal", { query: "db.find", literal: true }],
				["content-context", { query: "rate limiting", context: 1 }],
				["content-no-ignore", { query: "authenticate", noIgnore: true }],
				["content-limit", { query: "authenticate", limit: 1 }],
				["content-offset", { query: "authenticate", offset: 1, limit: 1 }],
				["files-glob", { mode: "files", query: "*.ts" }],
				["files-needle", { mode: "files", query: "auth" }],
			];
			const report = [];
			for (const [name, params] of args) {
				const details = detailsOf(await runSearch(root, custom, params));
				report.push({
					name,
					content: details.content.replace(/\((ripgrep|walk)\)\s*$/, "(backend)"),
					matches: details.matches,
					files: details.files,
					truncated: details.truncated,
					hasMore: details.hasMore,
				});
			}
			await expect(report).toMatchFileSnapshot("./__artifacts__/tool.search.json");
		}));
});
