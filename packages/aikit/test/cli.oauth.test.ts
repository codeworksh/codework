import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { OAuthCommand } from "../src/cli/oauth.ts";
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
		manual: false,
		status: false,
		refresh: false,
		logout: false,
		json: false,
		printHeaders: false,
		originator: "codework",
		...overrides,
	};
}

describe("OAuthCommand", () => {
	let dir: string;
	let path: string;
	let storage: JsonOpenAICodexAuthStorage;
	let previousExitCode: typeof process.exitCode;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "aikit-oauth-cli-test-"));
		path = join(dir, "auth.json");
		storage = new JsonOpenAICodexAuthStorage({ path });
		previousExitCode = process.exitCode;
		process.exitCode = undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
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

		const output = vi.mocked(console.log).mock.calls.flat().join("\n");
		expect(output).toContain("Account: acct_cli");
		expect(output).not.toContain("access-secret");
		expect(output).not.toContain("refresh-secret");
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
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Refreshed OpenAI Codex credentials");
	});

	it("logs out and clears stored Codex credentials", async () => {
		await storage.set(makeCredentials());

		await OAuthCommand.handler(args(path, { logout: true }));

		await expect(storage.get()).resolves.toBeUndefined();
		expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toContain("Cleared OpenAI Codex credentials");
	});
});
