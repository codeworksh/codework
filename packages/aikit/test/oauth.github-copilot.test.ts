import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
	createGitHubCopilotDeviceFlow,
	fetchGitHubCopilotModels,
	pollGitHubCopilotDeviceToken,
	getGitHubCopilotApiKey,
	GitHubCopilotOAuthClient,
	GITHUB_COPILOT_PROVIDER_ID,
	gitHubCopilotBaseUrl,
	gitHubCopilotEntitlementError,
	JsonGitHubCopilotAuthStorage,
} from "../src/oauth/github/copilot.ts";

type Json = Record<string, unknown>;

const ENV_KEYS = ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "XDG_CONFIG_HOME", "CODEWORK_CREDENTIALS"];

async function scratchDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "aikit-copilot-"));
}

function oauthFixture(extra: Json = {}): Json {
	return { "github.com": { oauth_token: "gho_editor" }, ...extra };
}

function makeFetch(handlers: Array<(url: string, init?: RequestInit) => Response>) {
	const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
	const send: typeof globalThis.fetch = async (input, init) => {
		const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
		calls.push({ url, init });
		const handler = handlers.shift();
		if (!handler) return new Response("unexpected request", { status: 500 });
		return handler(url, init);
	};
	return { calls, send };
}

const ok = (body: unknown) => Response.json(body);

function deviceFlowHandlers(overrides: { interval?: number; user?: Json; models?: Json } = {}) {
	const user = overrides.user ?? {
		chat_enabled: true,
		endpoints: { api: "https://api.individual.githubcopilot.com" },
	};
	const models = overrides.models ?? {
		data: [
			{
				id: "gpt-5.4",
				capabilities: { supports: { tool_calls: true } },
				model_picker_enabled: true,
				policy: { state: "enabled" },
			},
		],
	};
	return [
		// device code
		() =>
			ok({
				device_code: "dc_1",
				user_code: "WDJB-MJHT",
				verification_uri: "https://github.com/login/device",
				expires_in: 900,
				...(overrides.interval !== undefined ? { interval: overrides.interval } : {}),
			}),
		// token poll (pending first, then success)
		() => ok({ error: "authorization_pending" }),
		() => ok({ access_token: "ghu_live" }),
		// copilot_internal/user
		() => ok(user),
		// models
		() => ok(models),
	];
}

beforeEach(() => {
	for (const key of ENV_KEYS) vi.stubEnv(key, "");
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("gitHubCopilotBaseUrl", () => {
	it("prefers the discovered API endpoint, then enterprise, then public", () => {
		expect(gitHubCopilotBaseUrl({ apiEndpoint: "https://api.business.githubcopilot.com" })).toBe(
			"https://api.business.githubcopilot.com",
		);
		expect(gitHubCopilotBaseUrl({ enterpriseUrl: "https://ghe.example.com" })).toBe(
			"https://copilot-api.ghe.example.com",
		);
		expect(gitHubCopilotBaseUrl({ enterpriseUrl: "ghe.example.com/" })).toBe("https://copilot-api.ghe.example.com");
		expect(gitHubCopilotBaseUrl()).toBe("https://api.githubcopilot.com");
	});
});

describe("JsonGitHubCopilotAuthStorage", () => {
	it("round-trips credentials without exposing tokens in errors", async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		const storage = new JsonGitHubCopilotAuthStorage({ path });
		const credentials = {
			access: "ghu_x",
			refresh: "ghu_x",
			expires: 0,
			availableModelIds: ["gpt-4.1"],
		};
		await storage.set(credentials);
		expect(await storage.get()).toEqual(credentials);
		const raw = JSON.parse(await readFile(path, "utf8"));
		expect(raw[GITHUB_COPILOT_PROVIDER_ID].access).toBe("ghu_x");
		await storage.clear();
		expect(await storage.get()).toBeUndefined();
	});

	it("returns undefined for invalid or missing files", async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		await writeFile(path, "{not json", "utf8");
		const storage = new JsonGitHubCopilotAuthStorage({ path });
		expect(await storage.get()).toBeUndefined();
	});

	it("refuses to overwrite a file it could not read", async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		await writeFile(path, "{not json", "utf8");
		const storage = new JsonGitHubCopilotAuthStorage({ path });

		// A write rebuilds the whole file, so treating an unreadable one as empty
		// would silently drop every other provider's credentials.
		await expect(storage.set({ access: "ghu_x", refresh: "ghu_x", expires: 0 })).rejects.toThrow("not valid JSON");
		expect(await readFile(path, "utf8")).toBe("{not json");
	});

	it("leaves other providers alone when writing and clearing", async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		await writeFile(path, JSON.stringify({ "openai-codex": { access: "codex" } }), "utf8");
		const storage = new JsonGitHubCopilotAuthStorage({ path });

		await storage.set({ access: "ghu_x", refresh: "ghu_x", expires: 0 });
		expect(JSON.parse(await readFile(path, "utf8"))["openai-codex"]).toEqual({ access: "codex" });

		await storage.clear();
		expect(JSON.parse(await readFile(path, "utf8"))["openai-codex"]).toEqual({ access: "codex" });
	});
});

describe("getGitHubCopilotApiKey", () => {
	it("prefers COPILOT_GITHUB_TOKEN over every other source", async () => {
		const dir = await scratchDir();
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "ghu_env");
		vi.stubEnv("CODEWORK_CREDENTIALS", join(dir, "auth.json"));
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ [GITHUB_COPILOT_PROVIDER_ID]: { access: "ghu_stored", refresh: "ghu_stored", expires: 0 } }),
			"utf8",
		);
		expect(await getGitHubCopilotApiKey()).toBe("ghu_env");
	});

	it("ignores GITHUB_TOKEN and GH_TOKEN entirely", async () => {
		const dir = await scratchDir();
		vi.stubEnv("CODEWORK_CREDENTIALS", join(dir, "auth.json"));

		// Both are usually set for git or `gh` and carry no Copilot access, so
		// they are not a credential source at all -- not even a last resort.
		vi.stubEnv("GITHUB_TOKEN", "gho_ambient");
		vi.stubEnv("GH_TOKEN", "gho_ambient_2");
		expect(await getGitHubCopilotApiKey()).toBeUndefined();

		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ [GITHUB_COPILOT_PROVIDER_ID]: { access: "ghu_stored", refresh: "ghu_stored", expires: 0 } }),
			"utf8",
		);
		expect(await getGitHubCopilotApiKey()).toBe("ghu_stored");

		// The Copilot-specific variable still overrides everything.
		vi.stubEnv("COPILOT_GITHUB_TOKEN", "ghu_env");
		expect(await getGitHubCopilotApiKey()).toBe("ghu_env");
	});

	it("never reads credentials another application stored for itself", async () => {
		const dir = await scratchDir();
		vi.stubEnv("XDG_CONFIG_HOME", join(dir, "config"));
		vi.stubEnv("CODEWORK_CREDENTIALS", join(dir, "auth.json"));
		await mkdir(join(dir, "config", "github-copilot"), { recursive: true });

		// An editor's Copilot sign-in lives here. Treating it as a credential
		// source would let a run bill and act as an account codework was never
		// given, invisibly to `auth --status`.
		await writeFile(
			join(dir, "config", "github-copilot", "hosts.json"),
			JSON.stringify(oauthFixture({ "ghe.example.com": { oauth_token: "gho_ghe" } })),
			"utf8",
		);
		expect(await getGitHubCopilotApiKey()).toBeUndefined();

		await writeFile(join(dir, "config", "github-copilot", "apps.json"), JSON.stringify(oauthFixture()), "utf8");
		expect(await getGitHubCopilotApiKey()).toBeUndefined();

		// Only a login codework was actually given counts.
		await writeFile(
			join(dir, "auth.json"),
			JSON.stringify({ [GITHUB_COPILOT_PROVIDER_ID]: { access: "ghu_stored", refresh: "ghu_stored", expires: 0 } }),
			"utf8",
		);
		expect(await getGitHubCopilotApiKey()).toBe("ghu_stored");
	});
});

describe("createGitHubCopilotDeviceFlow", () => {
	it("returns the code payload and a pollable completion", async () => {
		const { calls, send } = makeFetch([
			() =>
				ok({
					device_code: "dc_1",
					user_code: "WDJB-MJHT",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
					interval: 1,
				}),
			() => ok({ access_token: "ghu_done" }),
		]);
		const flow = await createGitHubCopilotDeviceFlow({ fetch: send });
		expect(flow.userCode).toBe("WDJB-MJHT");
		expect(flow.verificationUri).toBe("https://github.com/login/device");
		expect(flow.intervalSeconds).toBe(1);
		await expect(pollGitHubCopilotDeviceToken(flow, { fetch: send })).resolves.toBe("ghu_done");
		expect(calls[1]!.init?.body).toContain("dc_1");
	});

	it("defaults to a 5 second poll interval", async () => {
		const { send } = makeFetch([
			() =>
				ok({
					device_code: "dc_1",
					user_code: "WDJB-MJHT",
					verification_uri: "https://github.com/login/device",
					expires_in: 900,
				}),
		]);
		const flow = await createGitHubCopilotDeviceFlow({ fetch: send });
		expect(flow.intervalSeconds).toBe(5);
	});
});

describe("gitHubCopilotEntitlementError", () => {
	it("denies only on explicit chat_enabled false", () => {
		expect(gitHubCopilotEntitlementError({ chat_enabled: true, can_signup_for_limited: false })).toBeUndefined();
		expect(gitHubCopilotEntitlementError({})).toBeUndefined();
		expect(gitHubCopilotEntitlementError({ chat_enabled: false, can_signup_for_limited: true })).toContain(
			"not signed up",
		);
		expect(gitHubCopilotEntitlementError({ chat_enabled: false, can_signup_for_limited: false })).toContain(
			"does not have",
		);
	});
});

describe("fetchGitHubCopilotModels", () => {
	it("parses the live catalog shape", async () => {
		const { send } = makeFetch([
			() =>
				ok({
					data: [
						{
							id: "claude-haiku-4.5",
							capabilities: { supports: { tool_calls: true } },
							model_picker_enabled: true,
							policy: { state: "enabled" },
							supported_endpoints: ["/chat/completions", "/v1/messages"],
						},
						{ id: "no-tools", capabilities: { supports: { tool_calls: false } } },
					],
				}),
		]);
		const models = await fetchGitHubCopilotModels("ghu_x", { fetch: send });
		expect(models).toEqual([
			{
				id: "claude-haiku-4.5",
				pickerEnabled: true,
				policyState: "enabled",
				supportedEndpoints: ["/chat/completions", "/v1/messages"],
				toolCalls: true,
			},
			{
				id: "no-tools",
				pickerEnabled: false,
				policyState: undefined,
				supportedEndpoints: [],
				toolCalls: false,
			},
		]);
	});
});

describe("GitHubCopilotOAuthClient", () => {
	it("runs the device flow and stores credentials with live model ids", { timeout: 20_000 }, async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		vi.stubEnv("CODEWORK_CREDENTIALS", path);
		const { send } = makeFetch(deviceFlowHandlers({ interval: 1 }));
		const client = new GitHubCopilotOAuthClient({ storage: new JsonGitHubCopilotAuthStorage({ path }) });
		const authInfo: Array<{ url: string; userCode: string; instructions?: string | undefined }> = [];

		const credentials = await client.login({ onAuth: (info) => authInfo.push(info), fetch: send });

		expect(authInfo).toEqual([
			{
				url: "https://github.com/login/device",
				userCode: "WDJB-MJHT",
				instructions: "Complete the GitHub device authorization to finish GitHub Copilot authentication.",
			},
		]);
		expect(credentials.access).toBe("ghu_live");
		expect(credentials.refresh).toBe("ghu_live");
		expect(credentials.expires).toBe(0);
		expect(credentials.apiEndpoint).toBe("https://api.individual.githubcopilot.com");
		expect(credentials.availableModelIds).toEqual(["gpt-5.4"]);
		expect(await new JsonGitHubCopilotAuthStorage({ path }).get()).toMatchObject({ access: "ghu_live" });
	});

	it("rejects accounts without Copilot entitlement before storing", { timeout: 20_000 }, async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		vi.stubEnv("CODEWORK_CREDENTIALS", path);
		const { send } = makeFetch(
			deviceFlowHandlers({ interval: 1, user: { chat_enabled: false, can_signup_for_limited: false } }),
		);
		const client = new GitHubCopilotOAuthClient({ storage: new JsonGitHubCopilotAuthStorage({ path }) });
		await expect(client.login({ onAuth: () => {}, fetch: send })).rejects.toThrow("does not have");
		expect(await new JsonGitHubCopilotAuthStorage({ path }).get()).toBeUndefined();
	});

	it("resolves a token through stored credentials", async () => {
		const dir = await scratchDir();
		const path = join(dir, "auth.json");
		vi.stubEnv("CODEWORK_CREDENTIALS", path);
		const storage = new JsonGitHubCopilotAuthStorage({ path });
		await storage.set({ access: "ghu_stored", refresh: "ghu_stored", expires: 0 });
		const client = new GitHubCopilotOAuthClient({ storage });
		expect(await client.getApiKey()).toBe("ghu_stored");
	});
});
