import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	JsonOpenAICodexAuthStorage,
	OpenAICodexOAuthClient,
	createOpenAICodexAuthorizationFlow,
	getOpenAICodexAccountId,
	parseOpenAICodexAuthorizationInput,
	refreshOpenAICodexToken,
	type OpenAICodexAuthStorage,
	type OpenAICodexOAuthCredentials,
} from "../src/oauth/openai/codex.ts";

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

	it("parses the code#state form", () => {
		expect(parseOpenAICodexAuthorizationInput("abc123#xyz")).toEqual({ code: "abc123", state: "xyz" });
	});

	it("parses a raw query string", () => {
		expect(parseOpenAICodexAuthorizationInput("code=abc123&state=xyz")).toEqual({ code: "abc123", state: "xyz" });
	});
});

describe("getOpenAICodexAccountId", () => {
	it("extracts the ChatGPT account id from the JWT claim", () => {
		const token = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });
		expect(getOpenAICodexAccountId(token)).toBe("acct_123");
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

	it("uses CODEWORK_CREDENTIALS when set, expanding ~", () => {
		process.env.CODEWORK_CREDENTIALS = "~/custom/auth.json";
		expect(new JsonOpenAICodexAuthStorage().path).toBe(join(process.env.HOME!, "custom/auth.json"));
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

	it("writes credentials with owner-only file permissions", async () => {
		const storage = new JsonOpenAICodexAuthStorage({ path });
		await storage.set(makeCredentials());

		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
		}
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

	it("closes the callback server before login resolves", async () => {
		const nativeFetch = globalThis.fetch;
		const storage = new MemoryStorage();
		const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_login" } });
		let callbackRequest: Promise<Response> | undefined;

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 20));
				return Response.json({ access_token: access, refresh_token: "refresh-login", expires_in: 3600 });
			}),
		);

		const client = new OpenAICodexOAuthClient({ storage });
		const credentials = await client.login({
			onAuth: ({ url }) => {
				const state = new URL(url).searchParams.get("state");
				callbackRequest = nativeFetch(`http://127.0.0.1:1455/auth/callback?code=login-code&state=${state}`);
			},
			onPrompt: async () => {
				throw new Error("the callback should supply the authorization code");
			},
		});

		expect(credentials.accountId).toBe("acct_login");
		if (!callbackRequest) throw new Error("expected the callback request to start");
		expect((await callbackRequest).status).toBe(200);
		await expect(
			nativeFetch("http://127.0.0.1:1455/auth/callback", { signal: AbortSignal.timeout(1000) }),
		).rejects.toThrow();
	});

	it("signs in with a device code and never opens a local port", async () => {
		const { createServer } = await import("node:http");
		// Hold 1455: the device flow must not want it.
		const blocker = createServer((_req, res) => res.end("busy"));
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_device" } });
			const calls: string[] = [];
			let polls = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
					calls.push(url);
					if (url.endsWith("/deviceauth/usercode")) {
						return Response.json({ device_auth_id: "dev_1", user_code: "WDJB-MJHT", interval: 0 });
					}
					if (url.endsWith("/deviceauth/token")) {
						polls += 1;
						// Unclaimed codes answer 403 until the user approves.
						if (polls === 1) return new Response("", { status: 403 });
						return Response.json({ authorization_code: "dev-code", code_verifier: "dev-verifier" });
					}
					expect(url).toBe("https://auth.openai.com/oauth/token");
					const body = init?.body instanceof URLSearchParams ? init.body.toString() : "";
					expect(body).toContain("code=dev-code");
					expect(body).toContain("code_verifier=dev-verifier");
					// The code is redeemed against the server's own callback, not 1455.
					expect(body).toContain(encodeURIComponent("https://auth.openai.com/deviceauth/callback"));
					return Response.json({ access_token: access, refresh_token: "refresh-device", expires_in: 3600 });
				}),
			);

			const storage = new MemoryStorage();
			let announced: { url: string; userCode?: string | undefined } | undefined;
			const credentials = await new OpenAICodexOAuthClient({ storage }).login({
				device: true,
				onAuth: (info) => {
					announced = info;
				},
				onPrompt: async () => {
					throw new Error("the device flow must not prompt for a pasted code");
				},
			});

			expect(credentials.accountId).toBe("acct_device");
			expect(storage.credentials?.access).toBe(access);
			expect(announced).toEqual({
				url: "https://auth.openai.com/codex/device",
				userCode: "WDJB-MJHT",
				instructions: "Open the URL and enter the code to finish OpenAI Codex authentication.",
			});
			expect(polls).toBe(2);
			expect(calls.some((url) => url.includes("1455"))).toBe(false);
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
	});

	it("explains a busy callback port instead of silently asking for a paste", async () => {
		const { createServer } = await import("node:http");
		const blocker = createServer((_req, res) => res.end("busy"));
		await new Promise<void>((resolve, reject) => {
			blocker.listen(1455, "127.0.0.1", resolve).on("error", reject);
		});

		try {
			const access = makeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_busy" } });
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => Response.json({ access_token: access, refresh_token: "refresh-busy", expires_in: 3600 })),
			);

			const progress: string[] = [];
			let state: string | null = null;
			const credentials = await new OpenAICodexOAuthClient({ storage: new MemoryStorage() }).login({
				onAuth: ({ url }) => {
					state = new URL(url).searchParams.get("state");
				},
				onProgress: (message) => progress.push(message),
				onPrompt: async () => `http://localhost:1455/auth/callback?code=pasted-code&state=${state}`,
			});

			expect(credentials.accountId).toBe("acct_busy");
			expect(progress.join("\n")).toContain("Could not listen on http://localhost:1455/auth/callback");
		} finally {
			await new Promise<void>((resolve) => blocker.close(() => resolve()));
		}
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

	it("redacts refresh tokens from endpoint failures", async () => {
		const storage = new MemoryStorage();
		const refresh = "refresh-super-secret";
		storage.credentials = makeCredentials({ refresh, expires: Date.now() - 1000 });

		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "invalid_grant", refresh_token: refresh }), { status: 400 }),
			),
		);

		const client = new OpenAICodexOAuthClient({ storage });
		const error = await client.getCredentials().then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(Error);
		if (error instanceof Error) {
			expect(error.message).toContain("token refresh failed (400)");
			expect(error.message).toContain("[REDACTED]");
			expect(error.message).not.toContain(refresh);
		}
	});

	it("does not include returned tokens in malformed-response errors", async () => {
		const access = "access-super-secret";
		const refresh = "refresh-super-secret";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ access_token: access, refresh_token: refresh })),
		);

		const error = await refreshOpenAICodexToken("stored-refresh-secret").then(
			() => undefined,
			(thrown: unknown) => thrown,
		);

		expect(error).toBeInstanceOf(Error);
		if (error instanceof Error) {
			expect(error.message).toContain("missing fields: expires_in");
			expect(error.message).not.toContain(access);
			expect(error.message).not.toContain(refresh);
		}
	});
});
