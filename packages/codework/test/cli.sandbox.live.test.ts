/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import "./utils/env.ts";

/**
 * A `codework run` that creates its own sandbox stops it on the way out, while the session
 * database is still open, and exits 0. The sandbox's final state is read back from that database;
 * for a remote driver that includes what the provider reported. A clean stderr also means probing
 * for instruction files the sandbox does not have stays silent.
 */

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const MODEL = { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", env: "OPENROUTER_API_KEY" } as const;

const DRIVERS = [
	{ driver: "memory", env: [] },
	{ driver: "daytona", env: ["DAYTONA_API_KEY"] },
	{ driver: "vercel", env: ["VERCEL_OIDC_TOKEN"] },
] as const;

const PROMPT = "Run this bash command: echo hi. Reply with its output and nothing else.";

describe.each(DRIVERS)("created $driver sandbox through the CLI", (live) => {
	it.skipIf([MODEL.env, ...live.env].some((name) => !process.env[name]?.trim()))(
		"stops the sandbox it created and exits 0",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "codework-cli-sandbox-"));
			try {
				const project = join(root, "project");
				mkdirSync(project);
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
						"--sandbox-driver",
						live.driver,
						"--provider",
						MODEL.provider,
						"--model",
						MODEL.id,
						PROMPT,
					],
					{
						encoding: "utf8",
						cwd: project,
						env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models },
						timeout: 240_000,
					},
				);
				expect(result.status, result.stderr).toBe(0);
				expect(result.stdout + result.stderr).not.toMatch(/ERROR|WARN/);

				const db = new DatabaseSync(database);
				try {
					const sandboxes = db
						.prepare("SELECT driver, kind, ownership, status, provider_status, last_error FROM sandbox_instance")
						.all()
						.map((row) => ({ ...row }));
					const bash = db
						.prepare("SELECT status FROM session_entry_part WHERE type = 'toolCall' AND tool_name = 'bash'")
						.all()
						.map((row) => String(row["status"]));
					expect(bash).toContain("completed");
					expect(result.stdout).toContain("hi");

					await expect(
						`${JSON.stringify({ status: result.status, bash: [...new Set(bash)], sandboxes }, null, "\t")}\n`,
					).toMatchFileSnapshot(`./__artifacts__/cli.sandbox.live.${live.driver}.json`);
				} finally {
					db.close();
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
		300_000,
	);
});
