/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import "./utils/env.ts";

/**
 * The search tools through the real CLI and a real model: off by default, as Pi ships them, and
 * on once a project's settings enable them. What the model called is read back from the session
 * database the CLI wrote.
 */

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const LIVE = [
	{ name: "openai", provider: "openai", id: "gpt-5.6-luna", env: "OPENAI_API_KEY" },
	{ name: "anthropic", provider: "anthropic", id: "claude-sonnet-5-5", env: "ANTHROPIC_API_KEY" },
] as const;

const files: Record<string, string> = {
	"src/nested/deep.spec.ts": "describe('needle', () => {});\n",
	"src/util.ts": "// helpers\nexport const needle = 'NEEDLE';\nexport const other = 2;\n",
	"a/.gitignore": "ignored.txt\n",
	"a/ignored.txt": "",
	"a/kept.txt": "",
	"a/deep/.gitignore": "secret.txt\n",
	"a/deep/kept.txt": "",
};

const optIn = {
	plugins: ["grep", "find", "ls"].map((tool) => ({ plugin: `codework.tool.${tool}`, enabled: true })),
};

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

const SEARCH = new Set(["grep", "find", "ls"]);

/** One `codework run` in a fresh project, returning its output and the tools it completed. */
const run = (live: (typeof LIVE)[number], settings: object | undefined) => {
	const root = mkdtempSync(join(tmpdir(), "codework-cli-search-"));
	try {
		const project = join(root, "project");
		for (const [path, content] of Object.entries(files)) {
			mkdirSync(dirname(join(project, path)), { recursive: true });
			writeFileSync(join(project, path), content);
		}
		if (settings !== undefined) {
			mkdirSync(join(project, ".codework"));
			writeFileSync(join(project, ".codework", "settings.jsonc"), JSON.stringify(settings));
		}
		const home = join(root, "home");
		const database = join(root, "session.sqlite");
		const result = spawnSync(
			process.execPath,
			[
				"--conditions=development",
				cli,
				"--home",
				home,
				"--database",
				database,
				"run",
				"--provider",
				live.provider,
				"--model",
				live.id,
				PROMPT,
			],
			{
				encoding: "utf8",
				cwd: project,
				// HOME too, so nothing outside the temp root is read.
				env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models },
				timeout: 240_000,
			},
		);
		const db = new DatabaseSync(database);
		try {
			const rows = db
				.prepare("SELECT tool_name, status FROM session_entry_part WHERE type = 'toolCall'")
				.all()
				.map((row) => ({ tool_name: String(row["tool_name"]), status: String(row["status"]) }));
			return {
				status: result.status,
				stdout: result.stdout,
				stderr: result.stderr,
				completed: [...new Set(rows.filter((row) => row.status === "completed").map((row) => row.tool_name))],
			};
		} finally {
			db.close();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};

describe.each(LIVE)("search tools through the CLI against live $name", (live) => {
	it.skipIf(!process.env[live.env]?.trim())(
		"offers them only once settings enable them, then answers from them",
		async () => {
			const off = run(live, undefined);
			expect(off.status, off.stderr).toBe(0);
			const offSearch = off.completed.filter((tool) => SEARCH.has(tool));
			expect(offSearch).toEqual([]);

			const on = run(live, optIn);
			expect(on.status, on.stderr).toBe(0);
			for (const tool of SEARCH) expect(on.completed, `${live.name} used ${tool}`).toContain(tool);
			const lines = on.stdout
				.split("\n")
				.map((line) => line.trim().replace(/^`|`$/g, "").replace(/,\s*/g, ", "))
				.filter((line) => /^(spec|other|a):/.test(line));
			expect(lines).toEqual(EXPECTED);

			await expect(`${JSON.stringify({ off: offSearch, on: lines }, null, "\t")}\n`).toMatchFileSnapshot(
				`./__artifacts__/cli.search.live.${live.name}.json`,
			);
		},
		600_000,
	);
});
