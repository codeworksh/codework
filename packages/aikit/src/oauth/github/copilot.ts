/**
 * GitHub Copilot OAuth.
 *
 * The device flow yields a plain GitHub OAuth token (`ghu_`/`gho_`), which the
 * Copilot API accepts directly as a Bearer credential — no session-token
 * exchange and no refresh path. `getGitHubCopilotApiKey` resolves a token from
 * the environment, from credentials other Copilot clients persist
 * (`~/.config/github-copilot/hosts.json` / `apps.json`), or from the codework
 * auth.json store; `GitHubCopilotOAuthClient#login` performs the device flow.
 */

import {
	GITHUB_COPILOT_API_VERSION,
	GITHUB_COPILOT_STATIC_HEADERS,
} from "../../providers/github-copilot/copilot-headers.ts";
import { JsonAuthStorage, homeDirectory, isObject, joinPath, readEnv } from "../storage.ts";

export const GITHUB_COPILOT_API_KEY_ENV = "COPILOT_GITHUB_TOKEN";
export const GITHUB_COPILOT_API_KEY_ENV_FALLBACKS = ["GITHUB_TOKEN", "GH_TOKEN"] as const;

// The official GitHub Copilot OAuth client id — the same one copilot.vim,
// copilot.lua, and pi use, so the consent screen shows "GitHub Copilot".
const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const SCOPE = "read:user";
const DEFAULT_DOMAIN = "github.com";
const DEFAULT_BASE_URL = "https://api.githubcopilot.com";
const USER_API_VERSION = "2025-04-01";
const DEFAULT_PROVIDER_ID = "github-copilot";
export const GITHUB_COPILOT_PROVIDER_ID = DEFAULT_PROVIDER_ID;
const MIN_POLL_INTERVAL_MS = 1000;
const SLOW_DOWN_INCREMENT_MS = 5000;
const POLLING_SAFETY_MARGIN_MS = 3000;
const DEFAULT_MODELS_RETRY = { maxRetries: 2, maxElapsedMs: 5000 };

export type GitHubCopilotOAuthCredentials = {
	/** GitHub OAuth token (`ghu_`/`gho_`), used directly as the Copilot Bearer credential. */
	access: string;
	/** Same token; kept for shape parity with other OAuth credentials. */
	refresh: string;
	/** Always 0 — GitHub OAuth tokens do not expire; re-login only on persistent 401. */
	expires: number;
	enterpriseUrl?: string;
	/** `endpoints.api` from `/copilot_internal/user` — the plan-specific Copilot API host. */
	apiEndpoint?: string;
	/** Model ids visible to the account at login time, from `GET {base}/models`. */
	availableModelIds?: string[];
};

export type GitHubCopilotDeviceFlow = {
	deviceCode: string;
	userCode: string;
	verificationUri: string;
	intervalSeconds: number;
	expiresInSeconds?: number;
};

export type GitHubCopilotUser = {
	chatEnabled?: boolean;
	canSignupForLimited?: boolean;
	apiEndpoint?: string;
};

export type GitHubCopilotRemoteModel = {
	id: string;
	supportedEndpoints: string[];
	policyState?: string;
	pickerEnabled: boolean;
	toolCalls: boolean;
};

export type GitHubCopilotLoginOptions = {
	enterpriseUrl?: string | undefined;
	/** Enable `policy.state === "unconfigured"` catalog models after login. Off by default — it writes account policy. */
	enableModels?: boolean | undefined;
	signal?: AbortSignal | undefined;
	fetch?: typeof globalThis.fetch | undefined;
	onAuth: (info: { url: string; userCode: string; instructions?: string | undefined }) => void;
	onProgress?: ((message: string) => void) | undefined;
};

export interface GitHubCopilotAuthStorage {
	get(): Promise<GitHubCopilotOAuthCredentials | undefined>;
	set(credentials: GitHubCopilotOAuthCredentials): Promise<void>;
	clear(): Promise<void>;
}

export type JsonGitHubCopilotAuthStorageOptions = {
	path?: string;
	providerId?: string;
};

type FetchLike = typeof globalThis.fetch;

function fetchWith(options: { fetch?: FetchLike | undefined }): FetchLike {
	return options.fetch ?? globalThis.fetch;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("GitHub Copilot login cancelled"));
			return;
		}
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("GitHub Copilot login cancelled"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function normalizeGitHubDomain(input: string | undefined): string | undefined {
	const trimmed = input?.trim();
	if (!trimmed) return undefined;
	try {
		const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
		return url.hostname;
	} catch {
		return undefined;
	}
}

/** The `api.` host serving `copilot_internal/*` for a given GitHub domain. */
export function gitHubApiDomain(domain: string): string {
	return domain === DEFAULT_DOMAIN ? "api.github.com" : `api.${domain}`;
}

/** The Copilot inference host for a credential or enterprise domain. */
export function gitHubCopilotBaseUrl(options?: {
	enterpriseUrl?: string | undefined;
	apiEndpoint?: string | undefined;
}): string {
	const apiEndpoint = options?.apiEndpoint;
	if (typeof apiEndpoint === "string" && apiEndpoint) return apiEndpoint.replace(/\/+$/, "");
	const domain = normalizeGitHubDomain(options?.enterpriseUrl);
	return domain ? `https://copilot-api.${domain}` : DEFAULT_BASE_URL;
}

/**
 * GitHub reports Copilot access on `/copilot_internal/user`; OAuth itself
 * succeeds for any GitHub account, so this is the only signal that the account
 * can chat.
 */
export function gitHubCopilotEntitlementError(user: {
	chat_enabled?: boolean | undefined;
	can_signup_for_limited?: boolean | undefined;
}): string | undefined {
	if (user.chat_enabled !== false) return undefined;
	if (user.can_signup_for_limited) {
		return "This GitHub account is not signed up for GitHub Copilot. Sign up for Copilot Free at https://github.com/features/copilot/plans and connect again.";
	}
	return "This GitHub account does not have GitHub Copilot access. It needs an active Copilot subscription or a seat assigned by an organization.";
}

export async function createGitHubCopilotDeviceFlow(
	options: { domain?: string | undefined; fetch?: FetchLike | undefined; signal?: AbortSignal | undefined } = {},
): Promise<GitHubCopilotDeviceFlow> {
	const domain = options.domain ?? DEFAULT_DOMAIN;
	const response = await fetchWith(options)(`https://${domain}/login/device/code`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
		signal: options.signal ?? null,
	});
	if (!response.ok) {
		throw new Error(`GitHub device code request failed (${response.status})`);
	}

	const data: unknown = await response.json();
	if (!isObject(data)) throw new Error("Invalid GitHub device code response");
	const { device_code, user_code, verification_uri, interval, expires_in } = data;
	if (
		typeof device_code !== "string" ||
		typeof user_code !== "string" ||
		typeof verification_uri !== "string" ||
		(interval !== undefined && typeof interval !== "number") ||
		(expires_in !== undefined && typeof expires_in !== "number")
	) {
		throw new Error("Invalid GitHub device code response fields");
	}

	// The verification URI is opened in the user's browser; force it to be a URL
	// so `open` cannot be tricked into launching something else.
	let parsed: URL;
	try {
		parsed = new URL(verification_uri);
	} catch {
		throw new Error("Untrusted verification_uri in GitHub device code response");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("Untrusted verification_uri in GitHub device code response");
	}

	return {
		deviceCode: device_code,
		userCode: user_code,
		verificationUri: parsed.href,
		intervalSeconds: typeof interval === "number" && interval > 0 ? interval : 5,
		...(typeof expires_in === "number" && { expiresInSeconds: expires_in }),
	};
}

export async function pollGitHubCopilotDeviceToken(
	flow: GitHubCopilotDeviceFlow,
	options: { domain?: string | undefined; fetch?: FetchLike | undefined; signal?: AbortSignal | undefined } = {},
): Promise<string> {
	const domain = options.domain ?? DEFAULT_DOMAIN;
	const send = fetchWith(options);
	const deadline =
		typeof flow.expiresInSeconds === "number" ? Date.now() + flow.expiresInSeconds * 1000 : Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(MIN_POLL_INTERVAL_MS, Math.floor(flow.intervalSeconds * 1000));

	const poll = async (): Promise<string | undefined> => {
		const response = await send(`https://${domain}/login/oauth/access_token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				client_id: CLIENT_ID,
				device_code: flow.deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
			signal: options.signal ?? null,
		});
		if (!response.ok) {
			throw new Error(`GitHub device token poll failed (${response.status})`);
		}
		const data: unknown = await response.json();
		if (!isObject(data)) throw new Error("Invalid GitHub device token response");

		if (typeof data.access_token === "string" && data.access_token) return data.access_token;

		const error = typeof data.error === "string" ? data.error : undefined;
		if (error === "authorization_pending") {
			await sleep(intervalMs + POLLING_SAFETY_MARGIN_MS, options.signal);
			return undefined;
		}
		if (error === "slow_down") {
			const serverInterval =
				typeof data.interval === "number" && data.interval > 0 ? data.interval * 1000 : undefined;
			intervalMs = serverInterval ?? intervalMs + SLOW_DOWN_INCREMENT_MS;
			await sleep(intervalMs + POLLING_SAFETY_MARGIN_MS, options.signal);
			return undefined;
		}
		const description = typeof data.error_description === "string" ? `: ${data.error_description}` : "";
		throw new Error(`GitHub device authorization failed: ${error ?? "unknown error"}${description}`);
	};

	// RFC 8628: wait `interval` before the first poll.
	await sleep(Math.min(intervalMs, deadline - Date.now()), options.signal);
	while (Date.now() < deadline) {
		const token = await poll();
		if (token) return token;
	}
	throw new Error("GitHub device authorization timed out");
}

/**
 * Look up the account's Copilot entitlement and per-plan API endpoint.
 *
 * A failed or malformed lookup returns `undefined` rather than denying login —
 * only an explicit `chat_enabled: false` answer blocks.
 */
export async function fetchGitHubCopilotUser(
	token: string,
	options: { domain?: string | undefined; fetch?: FetchLike | undefined; signal?: AbortSignal | undefined } = {},
): Promise<GitHubCopilotUser | undefined> {
	const domain = options.domain ?? DEFAULT_DOMAIN;
	try {
		const response = await fetchWith(options)(`https://${gitHubApiDomain(domain)}/copilot_internal/user`, {
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"User-Agent": GITHUB_COPILOT_STATIC_HEADERS["User-Agent"],
				"X-GitHub-Api-Version": USER_API_VERSION,
			},
			signal: options.signal ?? null,
		});
		if (!response.ok) return undefined;
		const data: unknown = await response.json();
		if (!isObject(data)) return undefined;
		const endpoints = isObject(data.endpoints) ? data.endpoints : undefined;
		return {
			...(typeof data.chat_enabled === "boolean" && { chatEnabled: data.chat_enabled }),
			...(typeof data.can_signup_for_limited === "boolean" && { canSignupForLimited: data.can_signup_for_limited }),
			...(typeof endpoints?.api === "string" && endpoints.api && { apiEndpoint: endpoints.api.replace(/\/+$/, "") }),
		};
	} catch (error) {
		if (options.signal?.aborted) throw error;
		return undefined;
	}
}

async function fetchWithRateLimitRetry(
	send: FetchLike,
	url: string,
	init: RequestInit,
	options: { signal?: AbortSignal; maxRetries: number; maxElapsedMs: number },
): Promise<Response> {
	const deadline = Date.now() + options.maxElapsedMs;
	for (let retry = 0; ; retry++) {
		const response = await send(url, { ...init, signal: options.signal ?? null });
		if (response.status !== 429 || retry >= options.maxRetries) return response;

		const retryAfter = response.headers.get("retry-after");
		let delayMs = 500 * 2 ** retry;
		if (retryAfter) {
			const seconds = Number.parseFloat(retryAfter);
			delayMs = Number.isNaN(seconds) ? Date.parse(retryAfter) - Date.now() : seconds * 1000;
			if (!Number.isFinite(delayMs)) return response;
		}
		delayMs = Math.max(0, delayMs);
		if (delayMs >= deadline - Date.now()) return response;
		await response.body?.cancel();
		await sleep(delayMs, options.signal);
	}
}

/**
 * The account-visible Copilot model catalog. `GET {base}/models` is the ground
 * truth for endpoint routing (`supported_endpoints`) and enablement (`policy`,
 * `model_picker_enabled`) — models.dev has no equivalent data.
 */
export async function fetchGitHubCopilotModels(
	token: string,
	options: {
		baseURL?: string | undefined;
		domain?: string | undefined;
		fetch?: FetchLike | undefined;
		signal?: AbortSignal | undefined;
		maxRetries?: number | undefined;
		maxElapsedMs?: number | undefined;
	} = {},
): Promise<GitHubCopilotRemoteModel[]> {
	const baseURL = options.baseURL ?? gitHubCopilotBaseUrl({ enterpriseUrl: options.domain });
	const response = await fetchWithRateLimitRetry(
		fetchWith(options),
		`${baseURL}/models`,
		{
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				...GITHUB_COPILOT_STATIC_HEADERS,
				"X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
			},
		},
		{
			...(options.signal !== undefined && { signal: options.signal }),
			maxRetries: options.maxRetries ?? DEFAULT_MODELS_RETRY.maxRetries,
			maxElapsedMs: options.maxElapsedMs ?? DEFAULT_MODELS_RETRY.maxElapsedMs,
		},
	);
	if (!response.ok) {
		throw new Error(`GitHub Copilot models request failed (${response.status})`);
	}

	const data: unknown = await response.json();
	const list = isObject(data) ? data.data : undefined;
	if (!Array.isArray(list)) throw new Error("Invalid GitHub Copilot models response");

	return list.flatMap((raw) => {
		if (!isObject(raw) || typeof raw.id !== "string") return [];
		const capabilities = isObject(raw.capabilities) ? raw.capabilities : undefined;
		const supports = isObject(capabilities?.supports) ? capabilities.supports : undefined;
		const policy = isObject(raw.policy) ? raw.policy : undefined;
		return [
			{
				id: raw.id,
				supportedEndpoints: Array.isArray(raw.supported_endpoints)
					? raw.supported_endpoints.filter((entry): entry is string => typeof entry === "string")
					: [],
				...(typeof policy?.state === "string" && { policyState: policy.state }),
				pickerEnabled: raw.model_picker_enabled === true,
				toolCalls: supports?.tool_calls !== false,
			},
		];
	});
}

/**
 * Enable models the account has not configured yet (`policy.state ===
 * "unconfigured"`). Best effort per model; a rate limit that outlives the
 * retry budget stops the batch.
 */
export async function enableGitHubCopilotModels(
	token: string,
	modelIds: readonly string[],
	options: {
		baseURL?: string | undefined;
		domain?: string | undefined;
		fetch?: FetchLike | undefined;
		signal?: AbortSignal | undefined;
	} = {},
): Promise<string[]> {
	const baseURL = options.baseURL ?? gitHubCopilotBaseUrl({ enterpriseUrl: options.domain });
	const send = fetchWith(options);
	const enabled: string[] = [];
	for (const modelId of modelIds) {
		try {
			const response = await fetchWithRateLimitRetry(
				send,
				`${baseURL}/models/${modelId}/policy`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${token}`,
						...GITHUB_COPILOT_STATIC_HEADERS,
						"openai-intent": "chat-policy",
						"x-interaction-type": "chat-policy",
					},
					body: JSON.stringify({ state: "enabled" }),
				},
				{ ...(options.signal !== undefined && { signal: options.signal }), maxRetries: 2, maxElapsedMs: 5000 },
			);
			if (response.status === 429) break;
			if (response.ok) enabled.push(modelId);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			break;
		}
	}
	return enabled;
}

function isGitHubCopilotCredentials(value: unknown): value is GitHubCopilotOAuthCredentials {
	if (!isObject(value)) return false;
	return typeof value.access === "string" && typeof value.refresh === "string" && typeof value.expires === "number";
}

export class JsonGitHubCopilotAuthStorage implements GitHubCopilotAuthStorage {
	private readonly storage: JsonAuthStorage<GitHubCopilotOAuthCredentials>;

	constructor(options: JsonGitHubCopilotAuthStorageOptions = {}) {
		this.storage = new JsonAuthStorage({
			providerId: options.providerId ?? DEFAULT_PROVIDER_ID,
			isCredentials: isGitHubCopilotCredentials,
			...(options.path !== undefined && { path: options.path }),
		});
	}

	get path(): string {
		return this.storage.path;
	}

	get providerId(): string {
		return this.storage.providerId;
	}

	get(): Promise<GitHubCopilotOAuthCredentials | undefined> {
		return this.storage.get();
	}

	set(credentials: GitHubCopilotOAuthCredentials): Promise<void> {
		return this.storage.set(credentials);
	}

	clear(): Promise<void> {
		return this.storage.clear();
	}
}

/**
 * The token other Copilot clients persist for the user
 * (`~/.config/github-copilot/hosts.json`, fallback `apps.json`; on Windows
 * `%LOCALAPPDATA%\github-copilot`). Any `ghu_`/`gho_` token works directly
 * against the Copilot API, so an editor's token is usable as-is.
 */
async function readEditorCopilotToken(domain?: string): Promise<string | undefined> {
	const directories =
		typeof process !== "undefined" && process.platform === "win32"
			? [readEnv("LOCALAPPDATA") && joinPath(readEnv("LOCALAPPDATA")!, "github-copilot")].filter(
					(dir): dir is string => Boolean(dir),
				)
			: [joinPath(readEnv("XDG_CONFIG_HOME") ?? joinPath(homeDirectory(), ".config"), "github-copilot")];

	const fs = await import("node:fs/promises");
	for (const directory of directories) {
		for (const filename of ["hosts.json", "apps.json"]) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await fs.readFile(joinPath(directory, filename), "utf8"));
			} catch {
				continue;
			}
			if (!isObject(parsed)) continue;
			// Enterprise hosts are keyed by their domain; github.com is the default.
			const preferred =
				(domain !== undefined && isObject(parsed[domain]) ? parsed[domain] : undefined) ??
				(isObject(parsed["github.com"]) ? parsed["github.com"] : undefined) ??
				Object.values(parsed).find(isObject);
			if (preferred && typeof preferred.oauth_token === "string" && preferred.oauth_token) {
				return preferred.oauth_token;
			}
		}
	}
	return undefined;
}

export type GitHubCopilotOAuthClientOptions = {
	storage?: GitHubCopilotAuthStorage;
};

export class GitHubCopilotOAuthClient {
	readonly storage: GitHubCopilotAuthStorage;

	constructor(options: GitHubCopilotOAuthClientOptions = {}) {
		this.storage = options.storage ?? new JsonGitHubCopilotAuthStorage();
	}

	async login(options: GitHubCopilotLoginOptions): Promise<GitHubCopilotOAuthCredentials> {
		const enterpriseUrl = options.enterpriseUrl?.trim() || undefined;
		const domain = normalizeGitHubDomain(enterpriseUrl) ?? DEFAULT_DOMAIN;
		if (enterpriseUrl && !normalizeGitHubDomain(enterpriseUrl)) {
			throw new Error("Invalid GitHub Enterprise URL/domain");
		}

		const flow = await createGitHubCopilotDeviceFlow({ domain, fetch: options.fetch, signal: options.signal });
		options.onAuth({
			url: flow.verificationUri,
			userCode: flow.userCode,
			instructions: "Complete the GitHub device authorization to finish GitHub Copilot authentication.",
		});

		const access = await pollGitHubCopilotDeviceToken(flow, {
			domain,
			fetch: options.fetch,
			...(options.signal !== undefined && { signal: options.signal }),
		});

		const user = await fetchGitHubCopilotUser(access, { domain, fetch: options.fetch, signal: options.signal });
		const denied = user
			? gitHubCopilotEntitlementError({
					chat_enabled: user.chatEnabled,
					can_signup_for_limited: user.canSignupForLimited,
				})
			: undefined;
		if (denied) throw new Error(denied);

		const apiEndpoint =
			user?.apiEndpoint ?? gitHubCopilotBaseUrl({ enterpriseUrl: domain === DEFAULT_DOMAIN ? undefined : domain });

		options.onProgress?.("Fetching available Copilot models...");
		let availableModelIds: string[] | undefined;
		let unconfigured: string[] = [];
		try {
			const models = await fetchGitHubCopilotModels(access, {
				baseURL: apiEndpoint,
				fetch: options.fetch,
				...(options.signal !== undefined && { signal: options.signal }),
			});
			const usable = models.filter((model) => model.toolCalls && model.policyState !== "disabled");
			const pickerIds = usable.filter((model) => model.pickerEnabled).map((model) => model.id);
			// Some Individual accounts report picker=false for every model despite
			// enabled policies; only that endpoint gets the policy fallback.
			const host = new URL(apiEndpoint).hostname;
			const policyFallback = pickerIds.length === 0 && host === "api.individual.githubcopilot.com";
			availableModelIds = pickerIds.length
				? pickerIds
				: policyFallback
					? usable.filter((model) => model.policyState === "enabled").map((model) => model.id)
					: [];
			unconfigured = usable.filter((model) => model.policyState === "unconfigured").map((model) => model.id);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			options.onProgress?.("Could not fetch the Copilot model catalog; continuing without it.");
		}

		if (options.enableModels && unconfigured.length > 0) {
			options.onProgress?.("Enabling Copilot models...");
			const enabled = await enableGitHubCopilotModels(access, unconfigured, {
				baseURL: apiEndpoint,
				fetch: options.fetch,
				...(options.signal !== undefined && { signal: options.signal }),
			});
			availableModelIds = [...new Set([...(availableModelIds ?? []), ...enabled])];
		}

		const credentials: GitHubCopilotOAuthCredentials = {
			access,
			refresh: access,
			expires: 0,
			...(domain !== DEFAULT_DOMAIN && { enterpriseUrl: domain }),
			apiEndpoint,
			...(availableModelIds !== undefined && availableModelIds.length > 0 && { availableModelIds }),
		};
		await this.storage.set(credentials);
		return credentials;
	}

	/** The stored `ghu_` token, returned as-is — it never expires. */
	async getCredentials(): Promise<GitHubCopilotOAuthCredentials | undefined> {
		return this.storage.get();
	}

	async getApiKey(): Promise<string | undefined> {
		return (await this.getCredentials())?.access;
	}

	async getHeaders(): Promise<Record<string, string> | undefined> {
		const credentials = await this.getCredentials();
		return credentials ? gitHubCopilotHeaders(credentials) : undefined;
	}

	async logout(): Promise<void> {
		await this.storage.clear();
	}
}

export function gitHubCopilotHeaders(credentials: GitHubCopilotOAuthCredentials): Record<string, string> {
	return {
		Authorization: `Bearer ${credentials.access}`,
		...GITHUB_COPILOT_STATIC_HEADERS,
		"X-GitHub-Api-Version": GITHUB_COPILOT_API_VERSION,
	};
}

/**
 * Resolve the GitHub Copilot API credential: `COPILOT_GITHUB_TOKEN` first
 * (`GITHUB_TOKEN`/`GH_TOKEN` after it — note GitHub Actions sets `GITHUB_TOKEN`
 * to a workflow token without Copilot access), then the token VS
 * Code/JetBrains/Neovim Copilot clients persist, then codework auth.json.
 * Returns undefined when nothing is stored; device flow only runs via
 * `GitHubCopilotOAuthClient#login`.
 */
export async function getGitHubCopilotApiKey(
	options: GitHubCopilotOAuthClientOptions & { enterpriseUrl?: string | undefined } = {},
): Promise<string | undefined> {
	for (const name of [GITHUB_COPILOT_API_KEY_ENV, ...GITHUB_COPILOT_API_KEY_ENV_FALLBACKS]) {
		const value = readEnv(name);
		if (value) return value;
	}

	const domain = normalizeGitHubDomain(options.enterpriseUrl);
	const editor = await readEditorCopilotToken(domain).catch(() => undefined);
	if (editor) return editor;

	return new GitHubCopilotOAuthClient(options).getApiKey();
}
