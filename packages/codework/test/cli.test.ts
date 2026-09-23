/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
/* @effect-diagnostics cryptoRandomUUID:off -- fixtures only need a distinct temp path. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

/**
 * The CLI discovers project settings from the directory it runs in, and searches upward, so a
 * child spawned in this repository would read the repository's own file. Every spawn below runs
 * in a temp directory instead, which is what "isolated" has to mean once discovery walks up.
 */
const run = (...args: ReadonlyArray<string>) => {
	const cwd = mkdtempSync(join(tmpdir(), "codework-cli-cwd-"));
	try {
		return spawnSync(process.execPath, ["--conditions=development", cli, ...args], { encoding: "utf8", cwd });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
};

const runIsolated = (env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>) => {
	const home = mkdtempSync(join(tmpdir(), "codework-cli-"));
	try {
		return runIn(home, env, ...args);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
};

/** `runIsolated` against a home the caller owns, for commands whose effect outlives one spawn. */
const runIn = (home: string, env: NodeJS.ProcessEnv, ...args: ReadonlyArray<string>) => {
	{
		// HOME too: provider SDKs cache credentials under it (e.g. Vercel's OIDC
		// token in ~/Library/Application Support), so "isolated" must hide them.
		// The catalog is pinned to the workspace's unless a case says otherwise, so no
		// spawn downloads one into its throwaway home.
		const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models, ...env };
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete childEnv[key];
		}
		return spawnSync(
			process.execPath,
			["--conditions=development", cli, "--home", home, "--database", ":memory:", ...args],
			{
				encoding: "utf8",
				env: childEnv,
				cwd: home,
				timeout: 20_000,
			},
		);
	}
};

describe("codework CLI", () => {
	it("reads custom settings from --user-config-dir without requiring model flags", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-cli-settings-"));
		try {
			writeFileSync(
				join(dir, "settings.jsonc"),
				JSON.stringify({ model: { provider: "settings-test-provider", id: "settings-test-model" } }),
			);
			const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "--user-config-dir", dir, "run", "test");
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("settings-test-provider");
			expect(result.stderr).toContain("settings-test-model");
			expect(result.stderr).toContain("error[model-not-found-error]");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rereads --user-config-dir settings on every invocation, including a revert", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-cli-settings-cycle-"));
		const write = (settings: object) => writeFileSync(join(dir, "settings.jsonc"), JSON.stringify(settings));
		const select = (stderr: string) => [/provider[^a-z0-9]+([a-z0-9-]+)/i.exec(stderr)?.[1] ?? "", stderr];
		try {
			// A: a selection plus a key that only A carries.
			write({ model: { provider: "cycle-a-provider", id: "cycle-a-model", options: { maxRetries: 7 } } });
			const first = runIsolated({ CODEWORK_MODELS_FILE: models }, "--user-config-dir", dir, "run", "test");
			expect(first.stderr).toContain("cycle-a-provider");
			expect(first.stderr).toContain("cycle-a-model");

			// B: a different selection, and A's extra key is absent from the file.
			write({ model: { provider: "cycle-b-provider", id: "cycle-b-model" } });
			const second = runIsolated({ CODEWORK_MODELS_FILE: models }, "--user-config-dir", dir, "run", "test");
			expect(second.stderr).toContain("cycle-b-provider");
			expect(second.stderr).toContain("cycle-b-model");
			expect(second.stderr).not.toContain("cycle-a-model");

			// Back to A: the earlier selection returns rather than sticking on B.
			write({ model: { provider: "cycle-a-provider", id: "cycle-a-model", options: { maxRetries: 7 } } });
			const third = runIsolated({ CODEWORK_MODELS_FILE: models }, "--user-config-dir", dir, "run", "test");
			expect(third.stderr).toContain("cycle-a-provider");
			expect(third.stderr).toContain("cycle-a-model");
			expect(third.stderr).not.toContain("cycle-b-model");
			expect(select(third.stderr)[0]).toBe(select(first.stderr)[0]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("documents local as the default and exposes remote sandbox flags", () => {
		const result = run("run", "--help");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--sandbox-driver string");
		expect(result.stdout).toContain("default: local");
		expect(result.stdout).toContain("Sandbox driver for a new session");
		expect(result.stdout).toContain("--sandbox-provider-id string");
	});

	it("validates sandbox names against the harness registry", () => {
		const result = runIsolated({}, "run", "--sandbox-driver", "missing", "test");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('sandbox driver "missing" is not registered');
		expect(result.stderr).toContain("available: local, daytona, memory, sqldb, vercel");
	});

	it("requires a provider sandbox ID to name its driver", () => {
		const result = run("run", "--sandbox-provider-id", "existing-id", "test");

		expect(result.status).toBe(1);
		expect(result.stdout).toContain("--sandbox-provider-id requires a remote --sandbox-driver");
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
		expect(result.stderr).toContain("error[model-catalog-missing]: model catalog not found");
		expect(result.stderr).toContain("hint: run `codework models refresh`");
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
		expect(result.stderr).toContain("error[provider-authentication-error]");
		expect(result.stderr).toContain("openrouter API key is missing");
		expect(result.stderr).toContain("hint: set OPENROUTER_API_KEY and retry");
		expect(result.stderr).not.toContain("Runner.TurnError");
		expect(result.stderr).not.toContain("at Loop.runTurn");
		expect(result.stderr).not.toContain("requestBodyValues");
		expect(result.stderr).not.toContain("AI_LoadAPIKeyError");
	});

	it("reports the sanitized remote sandbox provider failure", () => {
		const result = runIsolated({ VERCEL_OIDC_TOKEN: undefined }, "run", "--sandbox-driver", "vercel", "test");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error: SandboxProviderError - Could not get credentials from OIDC context.");
		expect(result.stderr).toContain("driver: vercel");
		expect(result.stderr).toContain("operation: create");
		expect(result.stderr).toContain("traceback:\nSandboxProviderError\n");
	});

	it("documents remote runs and rejects server-owned flags on the client", () => {
		expect(run("run", "--help").stdout).toContain("--server");
		const result = run("run", "--server", "ws://127.0.0.1:1/rpc", "--database", ":memory:", "hello");
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("belong on codework serve");
	});

	it("rejects out-of-range listening ports", () => {
		const result = run("serve", "--port", "65536");
		expect(result.status).toBe(1);
	});

	it("documents serve --host and --port", () => {
		const result = run("serve", "--help");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--host");
		expect(result.stdout).toContain("--port");
	});

	it("documents models --provider and subcommands", () => {
		const result = run("models", "--help");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("--provider");
		expect(result.stdout).toContain("Model catalog provider ID");
		expect(result.stdout).toContain("providers");
		expect(result.stdout).toContain("refresh");
	});

	it("documents OAuth management as subcommands", () => {
		const result = run("auth", "--help");

		expect(result.status).toBe(0);
		for (const command of ["login", "status", "refresh", "logout"]) {
			expect(result.stdout).toContain(command);
		}

		const login = run("auth", "login", "--help");
		expect(login.stdout).toContain("--openai-codex");
		expect(login.stdout).toContain("--github-copilot");
		expect(login.stdout).toContain("--device");

		// Login-only options stay off the read commands.
		const status = run("auth", "status", "--help");
		expect(status.stdout).not.toContain("--device");
		expect(status.stdout).not.toContain("--enable-models");
	});

	it("requires exactly one auth provider", () => {
		expect(run("auth", "login").status).toBe(1);
		expect(run("auth", "login", "--openai-codex", "--github-copilot").stderr).toContain(
			"choose exactly one provider",
		);
	});

	it("rejects Copilot-only flags on the Codex login", () => {
		const result = run("auth", "login", "--openai-codex", "--enterprise", "github.acme.com");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("only apply to --github-copilot");
	});

	it("reads GitHub Copilot status without exposing the token", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-auth-copilot-"));
		const authFile = join(dir, "auth.json");
		try {
			writeFileSync(
				authFile,
				JSON.stringify({
					"github-copilot": {
						access: "ghu_secret",
						refresh: "ghu_secret",
						expires: 0,
						apiEndpoint: "https://api.individual.githubcopilot.com",
						availableModelIds: ["gpt-5.4", "claude-opus-5"],
					},
				}),
			);

			const result = run("auth", "status", "--github-copilot", "--auth-file", authFile);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("API endpoint: https://api.individual.githubcopilot.com");
			expect(result.stdout).toContain("Available models: 2");
			expect(result.stdout).toContain("Expires: never");
			expect(result.stdout).not.toContain("ghu_secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reads an expired login without refreshing it", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-auth-expired-"));
		const authFile = join(dir, "auth.json");
		try {
			writeFileSync(
				authFile,
				JSON.stringify({
					"openai-codex": {
						access: "stale-access",
						refresh: "stale-refresh",
						expires: 1,
						accountId: "acct_stale",
					},
				}),
			);

			// --status is a read: it must not reach the network to renew this.
			const result = run("auth", "status", "--openai-codex", "--auth-file", authFile);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Account: acct_stale");
			expect(result.stdout).not.toContain("stale-access");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps --json stdout parseable", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-auth-json-"));
		const authFile = join(dir, "auth.json");
		try {
			writeFileSync(
				authFile,
				JSON.stringify({
					"github-copilot": {
						access: "ghu_secret",
						refresh: "ghu_secret",
						expires: 0,
						apiEndpoint: "https://api.individual.githubcopilot.com",
					},
				}),
			);

			const result = run("auth", "status", "--github-copilot", "--json", "--auth-file", authFile);

			expect(result.status).toBe(0);
			expect(JSON.parse(result.stdout)).toMatchObject({
				provider: "github-copilot",
				apiEndpoint: "https://api.individual.githubcopilot.com",
			});
			expect(result.stdout).not.toContain("ghu_secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("offers a device-code login for Codex only", () => {
		// Copilot has no other flow, so the flag would be meaningless there.
		const result = run("auth", "login", "--github-copilot", "--device");
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("always uses the device-code flow");
	});

	it("has no refresh path for GitHub Copilot", () => {
		const result = run("auth", "refresh", "--github-copilot");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("do not expire");
	});

	it("reads OAuth status without exposing stored tokens", () => {
		const dir = mkdtempSync(join(tmpdir(), "codework-auth-"));
		const authFile = join(dir, "auth.json");
		try {
			writeFileSync(
				authFile,
				JSON.stringify({
					"openai-codex": {
						access: "access-secret",
						refresh: "refresh-secret",
						expires: 4_102_444_800_000,
						accountId: "acct_cli",
					},
				}),
			);

			const result = run("auth", "status", "--openai-codex", "--auth-file", authFile);

			expect(result.status).toBe(0);
			expect(result.stdout).toContain("Account: acct_cli");
			expect(result.stdout).not.toContain("access-secret");
			expect(result.stdout).not.toContain("refresh-secret");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports the selected home when OAuth credentials are missing", () => {
		const home = mkdtempSync(join(tmpdir(), "codework-auth-home-"));
		try {
			const result = run("--home", home, "auth", "status", "--openai-codex");

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`no OpenAI Codex credentials found at ${join(home, "aikit/auth.json")}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("lists all models with models command", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai/gpt-4o\n");
		expect(result.stdout).toContain("anthropic/claude-sonnet-4-5\n");
	});

	it("filters models by provider with models --provider", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models", "--provider", "openai");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai/gpt-4o\n");
		expect(result.stdout).not.toContain("anthropic/");
	});

	it("lists available model providers with models providers", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models", "providers");

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("openai\n");
		expect(result.stdout).toContain("anthropic\n");
		expect(result.stdout).toContain("openrouter\n");
	});

	it("rejects an unknown models --provider", () => {
		const result = runIsolated({ CODEWORK_MODELS_FILE: models }, "models", "--provider", "not-a-provider");

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('provider "not-a-provider" is not in the catalog');
		expect(result.stderr).toContain("hint: run `codework models providers`");
	});

	it("reports a missing model catalog from models without an Effect stack", () => {
		const result = runIsolated(
			{ CODEWORK_MODELS_FILE: join(tmpdir(), `missing-models-${crypto.randomUUID()}.json`) },
			"models",
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error[model-catalog-missing]: model catalog not found");
		expect(result.stderr).toContain("hint: run `codework models refresh`");
		expect(result.stderr).not.toContain("Runner.TurnError");
		expect(result.stderr).not.toContain("at Loop.runTurn");
	});

	it("refreshes the catalog in the home only when it is stale or forced", () => {
		const home = mkdtempSync(join(tmpdir(), "codework-refresh-"));
		const snapshot = join(home, "modelsdev.json");
		const catalog = join(home, "models.gen.json");
		const env = { CODEWORK_MODELS_FILE: undefined, OPENCODE_MODELS_DEV_FILE: snapshot };
		writeFileSync(snapshot, JSON.stringify({}));
		try {
			const first = runIn(home, env, "models", "refresh");
			expect(first.status).toBe(0);
			expect(first.stdout).toBe(`${catalog}\n`);
			expect(first.stderr).toContain(`Refreshed model catalog at ${catalog}`);
			expect(existsSync(catalog)).toBe(true);

			const second = runIn(home, env, "models", "refresh");
			expect(second.status).toBe(0);
			expect(second.stderr).toContain("is fresh; pass --force");

			const forced = runIn(home, env, "models", "refresh", "--force");
			expect(forced.status).toBe(0);
			expect(forced.stderr).toContain(`Refreshed model catalog at ${catalog}`);

			const listed = runIn(home, env, "models", "providers");
			expect(listed.status).toBe(0);
			expect(listed.stdout).toContain("openai-codex\n");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("reports a failed refresh", () => {
		const result = runIsolated(
			{ CODEWORK_MODELS_FILE: undefined, OPENCODE_MODELS_URL: "http://127.0.0.1:1" },
			"models",
			"refresh",
		);

		expect(result.status).toBe(1);
		expect(result.stderr).toContain("error[catalog-refresh-failed]: failed to refresh the model catalog at");
		expect(result.stderr).toContain("hint: check the network connection and retry");
	});
});
