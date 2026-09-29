import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { OAuthCommand } from "../src/cli/oauth.ts";
import { JsonGitHubCopilotAuthStorage } from "../src/oauth/github/copilot.ts";
import { JsonOpenAICodexAuthStorage, type OpenAICodexOAuthCredentials } from "../src/oauth/openai/codex.ts";

type OAuthHandlerArgs = Parameters<typeof OAuthCommand.handler>[0];

function makeJwt(accountId: string): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})}.signature`;
}

function makeCredentials(overrides: Partial<OpenAICodexOAuthCredentials> = {}): OpenAICodexOAuthCredentials {
	return {
		access: "access-secret",
		refresh: "refresh-secret",
		expires: Date.now() + 60 * 60 * 1000,
		accountId: "acct_cli",
		...overrides,
	};
}

function args(path: string, overrides: Partial<OAuthHandlerArgs>): OAuthHandlerArgs {
	return {
		_: ["auth"],
		$0: "aikit",
		openaiCodex: true,
		authFile: path,
		browser: false,
		status: false,
		refresh: false,
		logout: false,
		json: false,
		...overrides,
	};
}

describe("OAuthCommand", () => {
	let dir: string;
	let path: string;
	let storage: JsonOpenAICodexAuthStorage;
	let previousExitCode: typeof process.exitCode;
	// The summary is the command's result and goes to stdout; notices are
	// progress and go to stderr, so `--json` stdout stays parseable.
	let out: string[];
	let notices: string[];
	const stdout = () => out.join("");
	const stderr = () => notices.join("\n");

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "aikit-oauth-cli-test-"));
		path = join(dir, "auth.json");
		storage = new JsonOpenAICodexAuthStorage({ path });
		previousExitCode = process.exitCode;
		process.exitCode = undefined;
		out = [];
		notices = [];
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			out.push(String(chunk));
			return true;
		});
		vi.spyOn(console, "warn").mockImplementation((...parts: unknown[]) => notices.push(parts.join(" ")));
		vi.spyOn(console, "error").mockImplementation((...parts: unknown[]) => notices.push(parts.join(" ")));
	});

	afterEach(async () => {
		process.exitCode = previousExitCode;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		await rm(dir, { recursive: true, force: true });
	});

	it("prints status metadata without exposing stored tokens", async () => {
		await storage.set(makeCredentials());

		await OAuthCommand.handler(args(path, { status: true }));

		expect(stdout()).toContain("Provider: OpenAI Codex");
		expect(stdout()).toContain("Account: acct_cli");
		expect(stdout()).not.toContain("access-secret");
		expect(stdout()).not.toContain("refresh-secret");
	});

	it("refreshes expired credentials and persists the replacement", async () => {
		await storage.set(makeCredentials({ expires: Date.now() - 1_000 }));
		const access = makeJwt("acct_refreshed_cli");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ access_token: access, refresh_token: "new-refresh-secret", expires_in: 3600 }),
			),
		);

		await OAuthCommand.handler(args(path, { refresh: true }));

		await expect(storage.get()).resolves.toMatchObject({
			access,
			refresh: "new-refresh-secret",
			accountId: "acct_refreshed_cli",
		});
		expect(stderr()).toContain("Refreshed OpenAI Codex credentials");
	});

	it("prints Copilot status without exposing stored tokens", async () => {
		const copilotStorage = new JsonGitHubCopilotAuthStorage({ path });
		await copilotStorage.set({
			access: "ghu_secret",
			refresh: "ghu_secret",
			expires: 0,
			apiEndpoint: "https://api.individual.githubcopilot.com",
			availableModelIds: ["gpt-4.1", "gpt-5.4"],
		});

		await OAuthCommand.handler(args(path, { openaiCodex: false, githubCopilot: true, status: true }));

		expect(stdout()).toContain("Provider: GitHub Copilot");
		expect(stdout()).toContain("api.individual.githubcopilot.com");
		expect(stdout()).toContain("Available models: 2");
		expect(stdout()).not.toContain("ghu_secret");
	});
});
