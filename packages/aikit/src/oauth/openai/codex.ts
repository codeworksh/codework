/**
 * OpenAI Codex OAuth helpers.
 *
 * This flow is intended for Node.js CLI/server environments. The low-level
 * authorization helpers are storage-free so they can also be used from an
 * existing HTTP server callback route.
 */

import dedent from "dedent";

const CODEWORK_OAUTH_CALLBACK_HOST = "CODEWORK_OAUTH_CALLBACK_HOST";
const CODEWORK_CREDENTIALS = "CODEWORK_CREDENTIALS";
const CODEWORK_HOME_DIR = "CODEWORK_HOME_DIR";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const DEFAULT_REDIRECT_URI = "http://localhost:1455/auth/callback";
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_ORIGINATOR = "codework";
const DEFAULT_PROVIDER_ID = "openai-codex";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const REFRESH_SKEW_MS = 60 * 1000;

export type OpenAICodexOAuthCredentials = {
	access: string;
	refresh: string;
	expires: number;
	accountId: string;
};

export type OpenAICodexTokenSuccess = {
	type: "success";
	access: string;
	refresh: string;
	expires: number;
};

export type OpenAICodexTokenFailure = {
	type: "failed";
	message: string;
	status?: number;
};

export type OpenAICodexTokenResult = OpenAICodexTokenSuccess | OpenAICodexTokenFailure;

export type OpenAICodexAuthorizationFlow = {
	url: string;
	verifier: string;
	state: string;
	redirectUri: string;
};

export type OpenAICodexAuthorizationOptions = {
	originator?: string;
	redirectUri?: string;
	scope?: string;
};

export type OpenAICodexPrompt = {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
};

export type OpenAICodexLoginOptions = OpenAICodexAuthorizationOptions & {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OpenAICodexPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
};

export interface OpenAICodexAuthStorage {
	get(): Promise<OpenAICodexOAuthCredentials | undefined>;
	set(credentials: OpenAICodexOAuthCredentials): Promise<void>;
	clear(): Promise<void>;
}

export type JsonOpenAICodexAuthStorageOptions = {
	path?: string;
	providerId?: string;
};

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
	};
	[key: string]: unknown;
};

type OAuthServerInfo = {
	close: () => void;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
};

type AuthFile = Record<string, unknown>;

function readEnv(name: string): string | undefined {
	if (typeof process === "undefined") return undefined;
	return process.env[name];
}

function joinPath(...parts: string[]): string {
	return parts.filter(Boolean).join("/").replaceAll(/\/+/g, "/");
}

function expandHome(path: string): string {
	if (path === "~") return homeDirectory();
	if (path.startsWith("~/")) return joinPath(homeDirectory(), path.slice(2));
	return path;
}

function homeDirectory(): string {
	const home = readEnv("HOME") ?? readEnv("USERPROFILE");
	if (!home) {
		throw new Error("Unable to resolve home directory for OpenAI Codex auth storage");
	}
	return home;
}

function codeworkHomeDirectory(): string {
	const override = readEnv(CODEWORK_HOME_DIR);
	if (override) return expandHome(override);
	return joinPath(homeDirectory(), ".codework");
}

export function defaultOpenAICodexAuthFilePath(): string {
	const authFile = readEnv(CODEWORK_CREDENTIALS);
	if (authFile) return expandHome(authFile);

	return joinPath(codeworkHomeDirectory(), "aikit", "auth.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenAICodexCredentials(value: unknown): value is OpenAICodexOAuthCredentials {
	if (!isObject(value)) return false;
	return (
		typeof value.access === "string" &&
		typeof value.refresh === "string" &&
		typeof value.expires === "number" &&
		typeof value.accountId === "string"
	);
}

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
	const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
	return atob(padded);
}

type WebCrypto = typeof globalThis.crypto;

function getCrypto(): WebCrypto {
	if (!globalThis.crypto?.getRandomValues || !globalThis.crypto.subtle) {
		throw new Error("OpenAI Codex OAuth requires Web Crypto support");
	}
	return globalThis.crypto;
}

function createState(): string {
	const bytes = new Uint8Array(16);
	getCrypto().getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function generatePKCE(): Promise<{
	verifier: string;
	challenge: string;
}> {
	const bytes = new Uint8Array(32);
	getCrypto().getRandomValues(bytes);
	const verifier = base64UrlEncode(bytes);

	const data = new TextEncoder().encode(verifier);
	const hash = await getCrypto().subtle.digest("SHA-256", data);
	const challenge = base64UrlEncode(new Uint8Array(hash));

	return { verifier, challenge };
}

export function parseOpenAICodexAuthorizationInput(input: string): {
	code?: string;
	state?: string;
} {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// Not a URL.
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function decodeJwt(token: string): JwtPayload | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(base64UrlDecode(parts[1] ?? "")) as JwtPayload;
	} catch {
		return null;
	}
}

export function getOpenAICodexAccountId(accessToken: string): string | null {
	const payload = decodeJwt(accessToken);
	const auth = payload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id;
	return typeof accountId === "string" && accountId.length > 0 ? accountId : null;
}

export async function createOpenAICodexAuthorizationFlow(
	options: OpenAICodexAuthorizationOptions = {},
): Promise<OpenAICodexAuthorizationFlow> {
	const redirectUri = options.redirectUri ?? DEFAULT_REDIRECT_URI;
	const { verifier, challenge } = await generatePKCE();
	const state = createState();

	const url = new URL(AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", CLIENT_ID);
	url.searchParams.set("redirect_uri", redirectUri);
	url.searchParams.set("scope", options.scope ?? DEFAULT_SCOPE);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", state);
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("originator", options.originator ?? DEFAULT_ORIGINATOR);

	return { verifier, state, redirectUri, url: url.toString() };
}

export async function exchangeOpenAICodexAuthorizationCode(
	code: string,
	verifier: string,
	redirectUri: string = DEFAULT_REDIRECT_URI,
): Promise<OpenAICodexTokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		return {
			type: "failed",
			status: response.status,
			message: `OpenAI Codex token exchange failed (${response.status}): ${text || response.statusText}`,
		};
	}

	const json = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
	};

	if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		return {
			type: "failed",
			message: `OpenAI Codex token exchange response missing fields: ${JSON.stringify(json)}`,
		};
	}

	return {
		type: "success",
		access: json.access_token,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
	};
}

async function refreshAccessToken(refreshToken: string): Promise<OpenAICodexTokenResult> {
	try {
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "refresh_token",
				refresh_token: refreshToken,
				client_id: CLIENT_ID,
			}),
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				type: "failed",
				status: response.status,
				message: `OpenAI Codex token refresh failed (${response.status}): ${text || response.statusText}`,
			};
		}

		const json = (await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
		};

		if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
			return {
				type: "failed",
				message: `OpenAI Codex token refresh response missing fields: ${JSON.stringify(json)}`,
			};
		}

		return {
			type: "success",
			access: json.access_token,
			refresh: json.refresh_token,
			expires: Date.now() + json.expires_in * 1000,
		};
	} catch (error) {
		return {
			type: "failed",
			message: `OpenAI Codex token refresh error: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function oauthPage(options: { title: string; heading: string; message: string; details?: string }): string {
	const escapeHtml = (value: string) =>
		value
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;")
			.replaceAll('"', "&quot;")
			.replaceAll("'", "&#39;");
	const details = options.details ? escapeHtml(options.details) : undefined;

	return dedent`
	<!doctype html>
	<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1" />
		<title>${escapeHtml(options.title)}</title>
		<style>
			html { color-scheme: dark; }
			body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			padding: 24px;
			background: #09090b;
			color: #fafafa;
			font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
			text-align: center;
			}
			main { width: 100%; max-width: 560px; }
			h1 { margin: 0 0 10px; font-size: 28px; line-height: 1.15; font-weight: 650; }
			p { margin: 0; line-height: 1.7; color: #a1a1aa; font-size: 15px; }
			.details { margin-top: 16px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: #a1a1aa; white-space: pre-wrap; word-break: break-word; }
		</style>
	</head>
	<body>
		<main>
			<h1>${escapeHtml(options.heading)}</h1>
			<p>${escapeHtml(options.message)}</p>
			${details ? `<div class="details">${details}</div>` : ""}
		</main>
	</body>
	</html>
	`;
}

function oauthSuccessHtml(message: string): string {
	return oauthPage({
		title: "Authentication successful",
		heading: "Authentication successful",
		message,
	});
}

function oauthErrorHtml(message: string, details?: string): string {
	return oauthPage({
		title: "Authentication failed",
		heading: "Authentication failed",
		message,
		details,
	});
}

async function startLocalOAuthServer(state: string): Promise<OAuthServerInfo> {
	const http = await import("node:http").catch(() => undefined);
	if (!http) {
		throw new Error("OpenAI Codex OAuth callback server is only available in Node.js environments");
	}

	let settleWait: ((value: { code: string } | null) => void) | undefined;
	const waitForCodePromise = new Promise<{ code: string } | null>((resolve) => {
		let settled = false;
		settleWait = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
	});

	const server = http.createServer((req, res) => {
		try {
			const url = new URL(req.url || "", "http://localhost");
			if (url.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Callback route not found."));
				return;
			}

			if (url.searchParams.get("state") !== state) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("State mismatch."));
				return;
			}

			const code = url.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(oauthErrorHtml("Missing authorization code."));
				return;
			}

			res.statusCode = 200;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(oauthSuccessHtml("OpenAI authentication completed. You can close this window."));
			settleWait?.({ code });
		} catch (error) {
			res.statusCode = 500;
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			res.end(
				oauthErrorHtml(
					"Internal error while processing OAuth callback.",
					error instanceof Error ? error.message : String(error),
				),
			);
		}
	});

	return new Promise((resolve) => {
		server
			.listen(1455, readEnv(CODEWORK_OAUTH_CALLBACK_HOST) || "127.0.0.1", () => {
				resolve({
					close: () => server.close(),
					cancelWait: () => {
						settleWait?.(null);
					},
					waitForCode: () => waitForCodePromise,
				});
			})
			.on("error", () => {
				settleWait?.(null);
				resolve({
					close: () => {
						try {
							server.close();
						} catch {
							// Ignore close errors after a listen failure.
						}
					},
					cancelWait: () => {},
					waitForCode: async () => null,
				});
			});
	});
}

export async function loginOpenAICodex(options: OpenAICodexLoginOptions): Promise<OpenAICodexOAuthCredentials> {
	const flow = await createOpenAICodexAuthorizationFlow(options);
	const server = await startLocalOAuthServer(flow.state);

	options.onAuth({
		url: flow.url,
		instructions: "Complete the browser login to finish OpenAI Codex authentication.",
	});

	let code: string | undefined;
	try {
		if (options.onManualCodeInput) {
			let manualCode: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualCode = input;
					if (input.trim()) server.cancelWait();
				})
				.catch((error) => {
					manualError = error instanceof Error ? error : new Error(String(error));
					server.cancelWait();
				});

			const result = await server.waitForCode();
			if (manualError) throw manualError;

			if (result?.code) {
				code = result.code;
			} else if (manualCode) {
				const parsed = parseOpenAICodexAuthorizationInput(manualCode);
				if (parsed.state && parsed.state !== flow.state) throw new Error("State mismatch");
				code = parsed.code;
			}

			if (!code) {
				await manualPromise;
				if (manualError) throw manualError;
				if (manualCode) {
					const parsed = parseOpenAICodexAuthorizationInput(manualCode);
					if (parsed.state && parsed.state !== flow.state) throw new Error("State mismatch");
					code = parsed.code;
				}
			}
		} else {
			const result = await server.waitForCode();
			if (result?.code) code = result.code;
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
			});
			const parsed = parseOpenAICodexAuthorizationInput(input);
			if (parsed.state && parsed.state !== flow.state) throw new Error("State mismatch");
			code = parsed.code;
		}

		if (!code) throw new Error("Missing authorization code");

		const tokenResult = await exchangeOpenAICodexAuthorizationCode(code, flow.verifier, flow.redirectUri);
		if (tokenResult.type !== "success") throw new Error(tokenResult.message);

		const accountId = getOpenAICodexAccountId(tokenResult.access);
		if (!accountId) throw new Error("Failed to extract accountId from token");

		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
			accountId,
		};
	} finally {
		server.close();
	}
}

export async function refreshOpenAICodexToken(refreshToken: string): Promise<OpenAICodexOAuthCredentials> {
	const result = await refreshAccessToken(refreshToken);
	if (result.type !== "success") {
		throw new Error(result.message);
	}

	const accountId = getOpenAICodexAccountId(result.access);
	if (!accountId) {
		throw new Error("Failed to extract accountId from token");
	}

	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
		accountId,
	};
}

export function openAICodexHeaders(credentials: OpenAICodexOAuthCredentials): Record<string, string> {
	return {
		Authorization: `Bearer ${credentials.access}`,
		"chatgpt-account-id": credentials.accountId,
		"OpenAI-Beta": "responses=experimental",
	};
}

export class JsonOpenAICodexAuthStorage implements OpenAICodexAuthStorage {
	readonly path: string;
	readonly providerId: string;

	constructor(options: JsonOpenAICodexAuthStorageOptions = {}) {
		this.path = options.path ? expandHome(options.path) : defaultOpenAICodexAuthFilePath();
		this.providerId = options.providerId ?? DEFAULT_PROVIDER_ID;
	}

	async get(): Promise<OpenAICodexOAuthCredentials | undefined> {
		const file = await this.readFile();
		if (!file) return undefined;

		if (isOpenAICodexCredentials(file)) return file;

		const direct = file[this.providerId];
		if (isOpenAICodexCredentials(direct)) return direct;

		const providers = file.providers;
		if (isObject(providers) && isOpenAICodexCredentials(providers[this.providerId])) {
			return providers[this.providerId] as OpenAICodexOAuthCredentials;
		}

		return undefined;
	}

	async set(credentials: OpenAICodexOAuthCredentials): Promise<void> {
		const current = await this.readFile();
		const next = isObject(current) && !isOpenAICodexCredentials(current) ? current : {};
		next[this.providerId] = credentials;
		await this.writeFile(next);
	}

	async clear(): Promise<void> {
		const current = await this.readFile();
		if (!current) return;

		if (isOpenAICodexCredentials(current)) {
			await this.writeFile({});
			return;
		}

		delete current[this.providerId];
		const providers = current.providers;
		if (isObject(providers)) delete providers[this.providerId];
		await this.writeFile(current);
	}

	private async readFile(): Promise<AuthFile | undefined> {
		const fs = await import("node:fs/promises");
		try {
			const text = await fs.readFile(this.path, "utf8");
			const parsed = JSON.parse(text) as unknown;
			return isObject(parsed) ? parsed : undefined;
		} catch (error) {
			if (isObject(error) && error.code === "ENOENT") return undefined;
			throw error;
		}
	}

	private async writeFile(value: AuthFile): Promise<void> {
		const fs = await import("node:fs/promises");
		const path = await import("node:path");
		await fs.mkdir(path.dirname(this.path), { recursive: true });
		const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
		await fs.writeFile(tempPath, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
		await fs.rename(tempPath, this.path);
	}
}

export type OpenAICodexOAuthClientOptions = {
	storage?: OpenAICodexAuthStorage;
	refreshSkewMs?: number;
};

export class OpenAICodexOAuthClient {
	readonly storage: OpenAICodexAuthStorage;
	readonly refreshSkewMs: number;

	constructor(options: OpenAICodexOAuthClientOptions = {}) {
		this.storage = options.storage ?? new JsonOpenAICodexAuthStorage();
		this.refreshSkewMs = options.refreshSkewMs ?? REFRESH_SKEW_MS;
	}

	async login(options: OpenAICodexLoginOptions): Promise<OpenAICodexOAuthCredentials> {
		const credentials = await loginOpenAICodex(options);
		await this.storage.set(credentials);
		return credentials;
	}

	async getCredentials(): Promise<OpenAICodexOAuthCredentials | undefined> {
		const credentials = await this.storage.get();
		if (!credentials) return undefined;

		if (credentials.expires > Date.now() + this.refreshSkewMs) {
			return credentials;
		}

		const refreshed = await refreshOpenAICodexToken(credentials.refresh);
		await this.storage.set(refreshed);
		return refreshed;
	}

	async getApiKey(): Promise<string | undefined> {
		return (await this.getCredentials())?.access;
	}

	async getHeaders(): Promise<Record<string, string> | undefined> {
		const credentials = await this.getCredentials();
		return credentials ? openAICodexHeaders(credentials) : undefined;
	}

	async logout(): Promise<void> {
		await this.storage.clear();
	}
}

export const openAICodexOAuthProvider = {
	id: DEFAULT_PROVIDER_ID,
	name: "ChatGPT Plus/Pro (OpenAI Codex)",
	usesCallbackServer: true,

	async login(options: OpenAICodexLoginOptions): Promise<OpenAICodexOAuthCredentials> {
		return loginOpenAICodex(options);
	},

	async refreshToken(credentials: OpenAICodexOAuthCredentials): Promise<OpenAICodexOAuthCredentials> {
		return refreshOpenAICodexToken(credentials.refresh);
	},

	getApiKey(credentials: OpenAICodexOAuthCredentials): string {
		return credentials.access;
	},

	getHeaders(credentials: OpenAICodexOAuthCredentials): Record<string, string> {
		return openAICodexHeaders(credentials);
	},
} as const;
