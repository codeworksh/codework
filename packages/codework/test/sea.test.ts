/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the standalone binary as a child process. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import pkg from "../package.json" with { type: "json" };
import "./utils/env.ts";

/**
 * The standalone binary as a user without Node runs it: `PATH` holds only the system directories.
 * It must unpack its assets, give an installed plugin the CLI's own `effect` (the plugin has no
 * dependencies, so nothing else could resolve its imports), and run just-bash's sqlite3, zstd and
 * xz from the unpacked files. Build it first with `vp run bundle && vp run sea`.
 */

const binary = fileURLToPath(new URL("../dist/sea/codework", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const LIVE = [
	{ name: "openai", provider: "openai", id: "gpt-5.6-luna", env: "OPENAI_API_KEY" },
	{ name: "openrouter", provider: "openrouter", id: "meta/muse-spark-1.3-contributor", env: "OPENROUTER_API_KEY" },
] as const;

const PLUGIN = `import { Plugin, Tool } from "@codeworksh/plugin";
import { Effect, Schema } from "effect";

export default Plugin.define({
	id: "acme.tool.finite",
	kind: "tool",
	setup(ctx) {
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "finite",
					description: "Return a finite number for a label.",
					parameters: Schema.Struct({ label: Schema.String }),
					success: Schema.Finite,
					handler: () => Effect.succeed(22800),
				}),
			),
		);
	},
});
`;

const BASH =
	"sqlite3 :memory: 'select 40 + 2;' && mkdir d && echo hi > d/a && tar --zstd -cf a.tzst d && tar -cJf a.txz d" +
	" && rm -r d && tar --zstd -xf a.tzst && cat d/a && rm -r d && tar -xJf a.txz && cat d/a";

const PROMPT = [
	"Use only your tools; do not guess. Do both:",
	'1. Call the finite tool with the label "sea".',
	`2. Run exactly this bash command: ${BASH}`,
	"Then reply with exactly two lines and nothing else:",
	"finite: <the number the finite tool returned>",
	"bash: <the lines the command printed, comma-separated>",
].join("\n");

const root = mkdtempSync(join(tmpdir(), "codework-sea-"));
const home = join(root, "home");
const temp = join(root, "tmp");
const project = join(root, "project");
const plugin = join(root, "plugin");
mkdirSync(temp);
mkdirSync(project);
mkdirSync(plugin);
writeFileSync(
	join(plugin, "package.json"),
	JSON.stringify({ name: "acme-finite", version: "1.0.0", type: "module", exports: { ".": "./index.mjs" } }),
);
writeFileSync(join(plugin, "index.mjs"), PLUGIN);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The binary, or a shell command, with nothing of this machine's Node in reach. */
const spawn = (command: string, args: ReadonlyArray<string>, env: Record<string, string> = {}, cwd = project) =>
	spawnSync(command, args, {
		encoding: "utf8",
		cwd,
		env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: temp, CODEWORK_MODELS_FILE: models, ...env },
		timeout: 240_000,
	});

describe.skipIf(!existsSync(binary))("the standalone binary", () => {
	// Every case runs with the plugin installed, whichever of them runs.
	let added: ReturnType<typeof spawn>;
	beforeAll(() => {
		added = spawn(binary, ["plugin", "add", plugin]);
	});

	it("runs without Node, unpacks its assets privately, and loads a plugin through its own effect", async () => {
		expect(spawn("/bin/sh", ["-c", "command -v node"]).status, "node is on the test PATH").not.toBe(0);

		const version = spawn(binary, ["--version"]);
		expect(version.status, version.stderr).toBe(0);
		// A canary or dev release builds in the version it publishes under (scripts/version.mjs).
		expect(version.stdout.trim()).toBe(`codework v${process.env["CODEWORK_VERSION"] ?? pkg.version}`);

		expect(added.status, added.stderr).toBe(0);
		const listed = spawn(binary, ["plugin", "list"]);
		expect(listed.status, listed.stderr).toBe(0);
		expect(listed.stdout).toContain("acme.tool.finite");

		const cache = join(temp, `codework-node-${process.getuid?.() ?? "user"}`);
		expect(statSync(cache).mode & 0o777).toBe(0o700);
		const [unpacked, ...others] = readdirSync(cache);
		expect(others).toEqual([]);
		const assets = join(cache, unpacked!);
		expect(statSync(join(assets, "codework-tui")).mode & 0o111).not.toBe(0);

		expect(unpacked).toMatch(new RegExp(`^[0-9a-f]{16}-${process.platform}-${process.arch}$`));

		// One artifact for every platform: what is unpacked does not depend on it.
		await expect(
			`${JSON.stringify(
				{ assets: readdirSync(assets).sort(), packages: readdirSync(join(assets, "node_modules")).sort() },
				null,
				"\t",
			)}\n`,
		).toMatchFileSnapshot("./__artifacts__/sea.json");
	});

	describe.each(LIVE)("against live $name", (live) => {
		it.skipIf(!process.env[live.env]?.trim())(
			"calls the plugin's tool and runs sqlite3, zstd and xz in the virtual shell",
			async () => {
				const database = join(root, `${live.name}.sqlite`);
				const result = spawn(
					binary,
					[
						"--database",
						database,
						"run",
						"--sandbox-driver",
						"memory",
						"--provider",
						live.provider,
						"--model",
						live.id,
						PROMPT,
					],
					{ [live.env]: process.env[live.env]! },
				);
				const db = new DatabaseSync(database);
				const completed = db
					.prepare("SELECT tool_name FROM part WHERE type = 'toolCall' AND status = 'completed'")
					.all()
					.map((row) => String(row["tool_name"]));
				db.close();
				expect(completed).toEqual(expect.arrayContaining(["finite", "bash"]));

				// Some models run their preamble into the first answer line.
				const lines = result.stdout
					.split("\n")
					.flatMap((line) => line.match(/(?:finite|bash):.*/) ?? [])
					.map((line) => line.trim().replace(/`$/, "").replace(/,\s*/g, ", "));
				expect(lines).toEqual(["finite: 22800", "bash: 42, hi, hi"]);
				expect(result.status, result.stderr).toBe(0);

				await expect(`${JSON.stringify({ lines }, null, "\t")}\n`).toMatchFileSnapshot(
					`./__artifacts__/sea.live.${live.name}.json`,
				);
			},
			600_000,
		);
	});

	// Both repositories are private, so like plugin.git.live.test.ts this needs git credentials that
	// can read them: opt in with CODEWORK_PLUGIN_LIVE=1. git reaches them through the real HOME's ssh
	// setup, while `--home` keeps CodeWork's own state in the temp root.
	it.skipIf(process.env["CODEWORK_PLUGIN_LIVE"] !== "1" || !process.env["OPENAI_API_KEY"]?.trim())(
		"installs plugins from git and the npm registry, then runs them",
		async () => {
			const remote = join(root, "remote");
			mkdirSync(remote);
			const git = {
				HOME: process.env["HOME"]!,
				...(process.env["SSH_AUTH_SOCK"] === undefined ? {} : { SSH_AUTH_SOCK: process.env["SSH_AUTH_SOCK"] }),
			};
			const add = (spec: string) =>
				spawn(binary, ["--home", join(root, "remote-home"), "plugin", "add", spec], git, remote);

			// Arborist fetches and installs from the registry inside the binary; the loader then
			// rejects the package for not being a plugin.
			const npm = add("is-number@7.0.0");
			expect(npm.status).not.toBe(0);
			expect(npm.stderr).toContain("error[plugin-invalid-definition]");

			for (const spec of [
				"github:codeworksh/codework-tool-spacex#v0.5.0",
				"github:codeworksh/codework-prompt-musk#v0.4.0",
			]) {
				const added = add(spec);
				expect(added.status, added.stderr).toBe(0);
			}

			const database = join(root, "remote.sqlite");
			const result = spawn(
				binary,
				[
					"--home",
					join(root, "remote-home"),
					"--database",
					database,
					"run",
					"--provider",
					"openai",
					"--model",
					"gpt-5.6-luna",
					[
						"Use the spacex_launch_manifest tool to list the vehicles that lift at least 50000 kg.",
						"Then reply with exactly one line and nothing else:",
						"heaviest: <the name of the heaviest vehicle>",
					].join("\n"),
				],
				{ ...git, OPENAI_API_KEY: process.env["OPENAI_API_KEY"]! },
				remote,
			);
			const db = new DatabaseSync(database);
			const completed = db
				.prepare("SELECT tool_name FROM part WHERE type = 'toolCall' AND status = 'completed'")
				.all()
				.map((row) => String(row["tool_name"]));
			db.close();
			expect(completed).toContain("spacex_launch_manifest");
			const lines = result.stdout.split("\n").flatMap((line) => line.match(/heaviest:.*/) ?? []);
			expect(lines).toEqual(["heaviest: Starship V3"]);
			expect(result.status, result.stderr).toBe(0);

			await expect(`${JSON.stringify({ lines }, null, "\t")}\n`).toMatchFileSnapshot(
				"./__artifacts__/sea.plugins.json",
			);
		},
		600_000,
	);
});
