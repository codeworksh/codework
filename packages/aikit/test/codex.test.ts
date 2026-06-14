import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	createOpenAICodexAuthorizationFlow,
	getOpenAICodexAccountId,
	openAICodexHeaders,
	parseOpenAICodexAuthorizationInput,
	type OpenAICodexAuthStorage,
	type OpenAICodexOAuthCredentials,
} from "../src/oauth/openai/codex";

function makeJwt(payload: Record<string, unknown>): string {
	const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

function makeCredentials(overrides: Partial<OpenAICodexOAuthCredentials> = {}): OpenAICodexOAuthCredentials {
	return {
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		accountId: "acct_123",
		...overrides,
	};
}

describe("parseOpenAICodexAuthorizationInput", () => {
	it("extracts code and state from a redirect URL", () => {
		const input = "http://localhost:1455/auth/callback?code=abc123&state=xyz";
		expect(parseOpenAICodexAuthorizationInput(input)).toEqual({ code: "abc123", state: "xyz" });
	});

	it("handles URLs without a state parameter", () => {
		expect(parseOpenAICodexAuthorizationInput("http://localhost:1455/auth/callback?code=abc123")).toEqual({
			code: "abc123",
			state: undefined,
		});
	});

	it("parses the code#state form", () => {
		expect(parseOpenAICodexAuthorizationInput("abc123#xyz")).toEqual({ code: "abc123", state: "xyz" });
	});

	it("parses a raw query string", () => {
		expect(parseOpenAICodexAuthorizationInput("code=abc123&state=xyz")).toEqual({ code: "abc123", state: "xyz" });
	});

	it("treats other input as a bare code", () => {
		expect(parseOpenAICodexAuthorizationInput("  abc123  ")).toEqual({ code: "abc123" });
	});

	it("returns an empty result for blank input", () => {
		expect(parseOpenAICodexAuthorizationInput("   ")).toEqual({});
	});
});

describe("getOpenAICodexAccountId", () => {
	it("extracts the ChatGPT account id from the JWT claim", () => {
		const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
		expect(getOpenAICodexAccountId(token)).toBe("acct_123");
	});

	it("returns null when the claim is missing", () => {
		expect(getOpenAICodexAccountId(makeJwt({ sub: "user" }))).toBeNull();
	});

	it("returns null for an empty account id", () => {
		const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "" } });
		expect(getOpenAICodexAccountId(token)).toBeNull();
	});

	it("returns null for malformed tokens", () => {
		expect(getOpenAICodexAccountId("not-a-jwt")).toBeNull();
		expect(getOpenAICodexAccountId("one.two")).toBeNull();
		expect(getOpenAICodexAccountId(`a.${Buffer.from("not json").toString("base64url")}.c`)).toBeNull();
	});
});

describe("createOpenAICodexAuthorizationFlow", () => {
	it("builds an authorization URL with PKCE", async () => {
		const flow = await createOpenAICodexAuthorizationFlow();
		const url = new URL(flow.url);

		expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize");
		expect(url.searchParams.get("response_type")).toBe("code");
		expect(url.searchParams.get("client_id")).toBeTruthy();
		expect(url.searchParams.get("redirect_uri")).toBe(flow.redirectUri);
		expect(url.searchParams.get("state")).toBe(flow.state);
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("originator")).toBe("codework");

		// The challenge must be the base64url-encoded SHA-256 of the verifier.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(flow.verifier));
		const expectedChallenge = Buffer.from(digest).toString("base64url");
		expect(url.searchParams.get("code_challenge")).toBe(expectedChallenge);
	});

	it("honors custom redirect URI, scope, and originator", async () => {
		const flow = await createOpenAICodexAuthorizationFlow({
			redirectUri: "http://localhost:9999/cb",
			scope: "openid",
			originator: "custom-cli",
		});
		const url = new URL(flow.url);

		expect(flow.redirectUri).toBe("http://localhost:9999/cb");
		expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:9999/cb");
		expect(url.searchParams.get("scope")).toBe("openid");
		expect(url.searchParams.get("originator")).toBe("custom-cli");
	});

	it("generates unique state and verifier per flow", async () => {
		const first = await createOpenAICodexAuthorizationFlow();
		const second = await createOpenAICodexAuthorizationFlow();
		expect(first.state).not.toBe(second.state);
		expect(first.verifier).not.toBe(second.verifier);
	});
});

describe("JsonOpenAICodexAuthStorage default path", () => {
	const ENV_VARS = ["CODEWORK_CREDENTIALS", "CODEWORK_HOME_DIR"] as const;
	const saved: Partial<Record<(typeof ENV_VARS)[number], string | undefined>> = {};

	beforeEach(() => {
		for (const name of ENV_VARS) {
			saved[name] = process.env[name];
			delete process.env[name];
		}
	});

	afterEach(() => {
		for (const name of ENV_VARS) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	it("defaults to ~/.codework/aikit/auth.json", () => {
		expect(new JsonOpenAICodexAuthStorage().path).toBe(join(process.env.HOME!, ".codework/aikit/auth.json"));
	});

	it("uses CODEWORK_CREDENTIALS when set, expanding ~", () => {
		process.env.CODEWORK_CREDENTIALS = "~/custom/auth.json";
		expect(new JsonOpenAICodexAuthStorage().path).toBe(join(process.env.HOME!, "custom/auth.json"));
	});

	it("uses CODEWORK_HOME_DIR as the base directory when set", () => {
		process.env.CODEWORK_HOME_DIR = "/tmp/codework-home";
		expect(new JsonOpenAICodexAuthStorage().path).toBe("/tmp/codework-home/aikit/auth.json");
	});
});

describe("openAICodexHeaders", () => {
	it("builds the Codex request headers from credentials", () => {
		expect(openAICodexHeaders(makeCredentials())).toEqual({
			Authorization: "Bearer access-token",
			"chatgpt-account-id": "acct_123",
			"OpenAI-Beta": "responses=experimental",
		});
	});
});

describe("JsonOpenAICodexAuthStorage", () => {
	let dir: string;
	let path: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "aikit-codex-test-"));
		path = join(dir, "auth.json");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("returns undefined when the file does not exist", async () => {
		const storage = new JsonOpenAICodexAuthStorage({ path });
		await expect(storage.get()).resolves.toBeUndefined();
	});

	it("round-trips credentials nested under the provider id", async () => {
		const storage = new JsonOpenAICodexAuthStorage({ path });
		const credentials = makeCredentials();

		await storage.set(credentials);
		await expect(storage.get()).resolves.toEqual(credentials);

		const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(file["openai-codex"]).toEqual(credentials);
	});

	it("reads a flat credentials file", async () => {
		const credentials = makeCredentials();
		await writeFile(path, JSON.stringify(credentials));

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await expect(storage.get()).resolves.toEqual(credentials);
	});

	it("reads credentials nested under providers", async () => {
		const credentials = makeCredentials();
		await writeFile(path, JSON.stringify({ providers: { "openai-codex": credentials } }));

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await expect(storage.get()).resolves.toEqual(credentials);
	});

	it("returns undefined for unrecognized file contents", async () => {
		await writeFile(path, JSON.stringify({ unrelated: true }));

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await expect(storage.get()).resolves.toBeUndefined();
	});

	it("preserves unrelated keys when setting credentials", async () => {
		await writeFile(path, JSON.stringify({ "other-provider": { token: "keep-me" } }));

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await storage.set(makeCredentials());

		const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(file["other-provider"]).toEqual({ token: "keep-me" });
		expect(file["openai-codex"]).toBeDefined();
	});

	it("clear() removes only this provider's credentials", async () => {
		await writeFile(
			path,
			JSON.stringify({
				"openai-codex": makeCredentials(),
				"other-provider": { token: "keep-me" },
			}),
		);

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await storage.clear();

		await expect(storage.get()).resolves.toBeUndefined();
		const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(file["other-provider"]).toEqual({ token: "keep-me" });
	});

	it("clear() empties a flat credentials file", async () => {
		await writeFile(path, JSON.stringify(makeCredentials()));

		const storage = new JsonOpenAICodexAuthStorage({ path });
		await storage.clear();

		await expect(storage.get()).resolves.toBeUndefined();
	});

	it("supports a custom provider id", async () => {
		const storage = new JsonOpenAICodexAuthStorage({ path, providerId: "my-codex" });
		await storage.set(makeCredentials());

		const file = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
		expect(file["my-codex"]).toBeDefined();
	});
});

class MemoryStorage implements OpenAICodexAuthStorage {
	credentials: OpenAICodexOAuthCredentials | undefined;

	async get() {
		return this.credentials;
	}

	async set(credentials: OpenAICodexOAuthCredentials) {
		this.credentials = credentials;
	}

	async clear() {
		this.credentials = undefined;
	}
}

describe("OpenAICodexOAuthClient", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns undefined when no credentials are stored", async () => {
		const client = new OpenAICodexOAuthClient({ storage: new MemoryStorage() });
		await expect(client.getCredentials()).resolves.toBeUndefined();
		await expect(client.getApiKey()).resolves.toBeUndefined();
		await expect(client.getHeaders()).resolves.toBeUndefined();
	});

	it("returns stored credentials while they are still fresh", async () => {
		const storage = new MemoryStorage();
		const credentials = makeCredentials();
		storage.credentials = credentials;

		const client = new OpenAICodexOAuthClient({ storage });
		await expect(client.getCredentials()).resolves.toEqual(credentials);
		await expect(client.getApiKey()).resolves.toBe("access-token");
	});

	it("refreshes credentials that are within the expiry skew", async () => {
		const storage = new MemoryStorage();
		storage.credentials = makeCredentials({ expires: Date.now() + 1000 });

		const refreshedAccess = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_refreshed" } });
		const fetchMock = vi.fn(async () =>
			Response.json({
				access_token: refreshedAccess,
				refresh_token: "new-refresh",
				expires_in: 3600,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const client = new OpenAICodexOAuthClient({ storage });
		const refreshed = await client.getCredentials();

		expect(fetchMock).toHaveBeenCalledOnce();
		expect(refreshed).toMatchObject({
			access: refreshedAccess,
			refresh: "new-refresh",
			accountId: "acct_refreshed",
		});
		// The refreshed credentials must be persisted.
		expect(storage.credentials).toEqual(refreshed);
	});

	it("surfaces refresh failures as errors", async () => {
		const storage = new MemoryStorage();
		storage.credentials = makeCredentials({ expires: Date.now() - 1000 });

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("invalid_grant", { status: 400 })),
		);

		const client = new OpenAICodexOAuthClient({ storage });
		await expect(client.getCredentials()).rejects.toThrow(/token refresh failed \(400\)/);
	});

	it("builds request headers from refreshed credentials", async () => {
		const storage = new MemoryStorage();
		storage.credentials = makeCredentials();

		const client = new OpenAICodexOAuthClient({ storage });
		await expect(client.getHeaders()).resolves.toEqual({
			Authorization: "Bearer access-token",
			"chatgpt-account-id": "acct_123",
			"OpenAI-Beta": "responses=experimental",
		});
	});
});
