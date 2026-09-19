import { LoadAPIKeyError } from "@ai-sdk/provider";
import { applyCopilotHeaders, type GitHubCopilotInteractionType } from "./copilot-headers.ts";

export type GitHubCopilotApiKey = string | (() => string | PromiseLike<string | undefined> | undefined);

export type CopilotFetchOptions = {
	/** Static token or async resolver — e.g. `() => getGitHubCopilotApiKey()`. */
	apiKey?: GitHubCopilotApiKey;
	/** Upstream fetch implementation; defaults to `globalThis.fetch`. */
	fetch?: typeof globalThis.fetch;
	/** Sent as `X-Interaction-Id` so Copilot can group requests by session. */
	sessionId?: string;
	interactionType?: GitHubCopilotInteractionType;
};

const API_KEY_ENVS = ["COPILOT_GITHUB_TOKEN", "GITHUB_TOKEN", "GH_TOKEN"];

async function resolveToken(apiKey: GitHubCopilotApiKey | undefined): Promise<string> {
	const resolved = typeof apiKey === "function" ? await apiKey() : apiKey;
	if (resolved) return resolved;
	for (const name of API_KEY_ENVS) {
		const value = typeof process === "undefined" ? undefined : process.env[name];
		if (value) return value;
	}
	throw new LoadAPIKeyError({
		message:
			"GitHub Copilot API key is missing. Set COPILOT_GITHUB_TOKEN (or GITHUB_TOKEN/GH_TOKEN), pass an apiKey, or authenticate with `aikit auth --github-copilot`.",
	});
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * Wrap an upstream fetch with Copilot auth and request metadata. The wrapped
 * call replaces adapter-set auth headers, injects the Copilot identity
 * headers, and derives `x-initiator` / `Copilot-Vision-Request` from the
 * serialized JSON body without consuming it.
 */
export function createCopilotFetch(options: CopilotFetchOptions = {}): typeof globalThis.fetch {
	const upstream = options.fetch ?? globalThis.fetch;
	return async (input, init) => {
		const token = await resolveToken(options.apiKey);
		const headers = new Headers(init?.headers);
		const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
		const body = typeof init?.body === "string" ? parseJson(init.body) : undefined;
		applyCopilotHeaders(headers, {
			token,
			url,
			body,
			...(options.sessionId !== undefined && { sessionId: options.sessionId }),
			...(options.interactionType !== undefined && { interactionType: options.interactionType }),
		});
		return upstream(input, { ...init, headers });
	};
}
