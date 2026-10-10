import { Effect } from "effect";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { findPlugin } from "../src/plugin/builtin/tool/find.ts";
import { grepPlugin } from "../src/plugin/builtin/tool/grep.ts";
import { lsPlugin } from "../src/plugin/builtin/tool/ls.ts";
import { readPlugin } from "../src/plugin/builtin/tool/read.ts";
import { files } from "./fixtures/search.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { available, LIVE } from "./utils/live.ts";

/**
 * A real model, through the real harness on the host sandbox, answering from the
 * search tools alone. The question has one right answer, and each part needs a
 * different tool, so the answer is only right if all three worked.
 */

const PROMPT = [
	"Use only your tools; do not guess. Do all three:",
	"1. Use find to locate the spec file (pattern *.spec.ts).",
	"2. Use grep to find where `export const other` is defined.",
	"3. Use ls on the directory `a`.",
	"Then reply with exactly three lines and nothing else:",
	"spec: <path of the spec file, relative to the project root>",
	"other: <path relative to the project root>:<line number>",
	"a: <the entries ls printed, comma-separated, in the order printed>",
].join("\n");

const EXPECTED = [
	"spec: src/nested/deep.spec.ts",
	"other: src/util.ts:3",
	"a: .gitignore, deep/, ignored.txt, kept.txt",
];

// Direct provider APIs only.
const direct = LIVE.filter((live) => live.provider === "openai" || live.provider === "anthropic");

describe.each(direct)("search tools against live $name", (live) => {
	it.skipIf(!available(live))(
		"answers from find, grep and ls",
		async () => {
			await using temp = await tmpdir();
			const root = await fs.realpath(temp.path);
			const work = join(root, "work");
			for (const [path, content] of Object.entries(files)) {
				await fs.mkdir(dirname(join(work, path)), { recursive: true });
				await fs.writeFile(join(work, path), content);
			}

			const { calls, reply } = await Effect.gen(function* () {
				const session = yield* Session.create({ directory: work, model: { provider: live.provider, id: live.id } });
				yield* session.run(PROMPT);
				const path = yield* session.path();
				const messages = yield* Effect.forEach(path, ContextCodec.decodeMessage);
				const parts = messages.flatMap((message) => message.parts);
				const last = messages.findLast((message) => message.parts.some((part) => part.type === "text"));
				return {
					calls: parts.flatMap((part) => (part.type === "toolCall" ? [part] : [])),
					reply: (last?.parts ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
				};
			}).pipe(
				Effect.provide(
					Harness.layer({
						home: join(root, "home"),
						hostCwd: root,
						database: ":memory:",
						plugins: [
							readPlugin,
							grepPlugin,
							findPlugin,
							lsPlugin,
							defaultPromptPlugin,
							// Opt-in tools: selected above, turned on here.
							{ plugin: grepPlugin.id, enabled: true },
							{ plugin: findPlugin.id, enabled: true },
							{ plugin: lsPlugin.id, enabled: true },
						],
					}),
				),
				Effect.scoped,
				Effect.timeout("240 seconds"),
				Effect.runPromise,
			);

			const used = new Set(calls.filter((call) => call.status === "completed").map((call) => call.name));
			for (const tool of ["find", "grep", "ls"]) expect(used, `${live.name} used ${tool}`).toContain(tool);
			const lines = reply
				.split("\n")
				.map((line) => line.trim().replace(/^`|`$/g, "").replace(/,\s*/g, ", "))
				.filter((line) => /^(spec|other|a):/.test(line));
			expect(lines).toEqual(EXPECTED);

			await expect(`${JSON.stringify(lines, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/tools.search.live.${live.name}.json`,
			);
		},
		300_000,
	);
});
