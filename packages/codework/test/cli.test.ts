/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
/* @effect-diagnostics cryptoRandomUUID:off -- fixtures only need a distinct temp path. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../models.gen.json", import.meta.url));

const run = (...args: ReadonlyArray<string>) =>
	spawnSync(process.execPath, ["--conditions=development", cli, ...args], { encoding: "utf8" });

const runIsolated = (env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>) => {
	const home = mkdtempSync(join(tmpdir(), "codework-cli-"));
	try {
		const childEnv = { ...process.env, ...env };
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete childEnv[key];
		}
		return spawnSync(
			process.execPath,
			["--conditions=development", cli, "--home", home, "--database", ":memory:", ...args],
			{
				encoding: "utf8",
				env: childEnv,
				timeout: 20_000,
			},
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
};

describe("codework CLI", () => {
	it("documents local as the default and exposes remote sandbox flags", () => {
		const result = run("run", "--help");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--sandbox string");
		expect(result.stdout).toContain("default: local");
		expect(result.stdout).toContain("Registered sandbox driver");
		expect(result.stdout).toContain("--sandbox-provider-id string");
	});

	it("validates sandbox names against the harness registry", () => {
		const result = runIsolated({}, "run", "--sandbox", "missing", "test");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('sandbox driver "missing" is not registered');
		expect(result.stderr).toContain("available: local, daytona, memory, sqldb, vercel");
	});

	it("requires a provider sandbox ID to name its driver", () => {
		const result = run("run", "--sandbox-provider-id", "existing-id", "test");

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("--sandbox-provider-id requires a remote --sandbox");
	});

	it("reports a missing model catalog without an Effect stack", () => {
		const result = runIsolated(
			{ CODEWORK_MODELS_FILE: join(tmpdir(), `missing-models-${crypto.randomUUID()}.json`) },
			"run",
			"--provider",
			"openrouter",
			"--model",
			"stealth/ox-alpha",
			"test",
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error[model_catalog]: model catalog not found");
		expect(result.stderr).toContain("hint: run `codework modelgen`");
		expect(result.stderr).not.toContain("Runner.TurnError");
		expect(result.stderr).not.toContain("at Loop.runTurn");
	});

	it("reports a missing provider API key with its taxonomy and remedy", () => {
		const result = runIsolated(
			{ CODEWORK_MODELS_FILE: models, OPENROUTER_API_KEY: undefined },
			"run",
			"--provider",
			"openrouter",
			"--model",
			"z-ai/glm-5.3-flash",
			"test",
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error[authentication]");
		expect(result.stderr).toContain("openrouter API key is missing");
		expect(result.stderr).toContain("hint: set OPENROUTER_API_KEY and retry");
		expect(result.stderr).not.toContain("Runner.TurnError");
		expect(result.stderr).not.toContain("at Loop.runTurn");
		expect(result.stderr).not.toContain("requestBodyValues");
		expect(result.stderr).not.toContain("AI_LoadAPIKeyError");
	});

	it("reports the sanitized remote sandbox provider failure", () => {
		const result = runIsolated({ VERCEL_OIDC_TOKEN: undefined }, "run", "--sandbox", "vercel", "test");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error: SandboxProviderError - Could not get credentials from OIDC context.");
		expect(result.stderr).toContain("driver: vercel");
		expect(result.stderr).toContain("operation: create");
		expect(result.stderr).toContain("traceback:\nSandboxProviderError\n");
	});

	it("lists available model providers with models provider", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models", "provider");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai\n");
		expect(result.stdout).toContain("anthropic\n");
		expect(result.stdout).toContain("openrouter\n");
	});

	it("lists all models with models command", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai/gpt-4o\n");
		expect(result.stdout).toContain("anthropic/claude-sonnet-4-5\n");
	});

	it("filters models by provider with models <provider>", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models", "openai");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai/gpt-4o\n");
		expect(result.stdout).not.toContain("anthropic/");
	});

	it("generates model catalog to specified path with models generate", () => {
		const targetDir = mkdtempSync(join(tmpdir(), "codework-gen-"));
		const targetFile = join(targetDir, "custom-models.json");
		try {
			const result = runIsolated({}, "models", "generate", targetFile);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`Generated model catalog at ${targetFile}`);
		} finally {
			rmSync(targetDir, { recursive: true, force: true });
		}
	});

	it("resolves directory target with models generate <dir>", () => {
		const targetDir = mkdtempSync(join(tmpdir(), "codework-gen-"));
		try {
			const result = runIsolated({}, "models", "generate", targetDir);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`Generated model catalog at ${join(targetDir, "models.gen.json")}`);
		} finally {
			rmSync(targetDir, { recursive: true, force: true });
		}
	});
});
