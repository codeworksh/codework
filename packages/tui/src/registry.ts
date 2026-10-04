import { getProviderModels, type ModelEntry } from "./catalog.ts";
import { getCredentialStore } from "./credentials.ts";

export interface ValidationResult {
	readonly ok: boolean;
	readonly error?: string;
}

export interface ProviderDefinition {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly envKeys: readonly string[];
	readonly defaultModel: string;
	getModels(): readonly ModelEntry[];
	validate(apiKey: string, modelId: string): Promise<ValidationResult>;
}

export class ProviderRegistry {
	private readonly providers = new Map<string, ProviderDefinition>();

	register(provider: ProviderDefinition): void {
		this.providers.set(provider.id, provider);
	}

	get(id: string): ProviderDefinition | undefined {
		return this.providers.get(id);
	}

	getAll(): readonly ProviderDefinition[] {
		return Array.from(this.providers.values());
	}
}

export const registry = new ProviderRegistry();

// 1. Google
registry.register({
	id: "google",
	name: "Google",
	description: "Gemini 2.5 Pro, Flash, and Gemma models",
	envKeys: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
	defaultModel: "gemini-2.5-pro",
	getModels() {
		return getProviderModels("google");
	},
	async validate(apiKey: string, _modelId: string) {
		const key = apiKey.trim();
		if (!key) return { ok: false, error: "API key cannot be empty" };
		try {
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
				{ signal: AbortSignal.timeout(8000) },
			);
			if (res.ok) return { ok: true };
			const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			const msg = json?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
			return { ok: false, error: msg };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Validation request failed: ${message}` };
		}
	},
});

// 2. OpenAI
registry.register({
	id: "openai",
	name: "OpenAI",
	description: "GPT-4o, o1, o3-mini, and reasoning models",
	envKeys: ["OPENAI_API_KEY"],
	defaultModel: "gpt-4o",
	getModels() {
		return getProviderModels("openai");
	},
	async validate(apiKey: string, _modelId: string) {
		const key = apiKey.trim();
		if (!key) return { ok: false, error: "API key cannot be empty" };
		try {
			const res = await fetch("https://api.openai.com/v1/models", {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(8000),
			});
			if (res.ok) return { ok: true };
			const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			const msg = json?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
			return { ok: false, error: msg };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Validation request failed: ${message}` };
		}
	},
});

// 3. Anthropic
registry.register({
	id: "anthropic",
	name: "Anthropic",
	description: "Claude 3.7 Sonnet, Haiku, and Opus",
	envKeys: ["ANTHROPIC_API_KEY"],
	defaultModel: "claude-3-7-sonnet-latest",
	getModels() {
		return getProviderModels("anthropic");
	},
	async validate(apiKey: string, _modelId: string) {
		const key = apiKey.trim();
		if (!key) return { ok: false, error: "API key cannot be empty" };
		try {
			const res = await fetch("https://api.anthropic.com/v1/models", {
				headers: {
					"x-api-key": key,
					"anthropic-version": "2023-06-01",
				},
				signal: AbortSignal.timeout(8000),
			});
			if (res.ok) return { ok: true };
			const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			const msg = json?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
			return { ok: false, error: msg };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Validation request failed: ${message}` };
		}
	},
});

// 4. OpenRouter
registry.register({
	id: "openrouter",
	name: "OpenRouter",
	description: "Unified API gateway to 300+ AI models",
	envKeys: ["OPENROUTER_API_KEY"],
	defaultModel: "anthropic/claude-3.7-sonnet",
	getModels() {
		return getProviderModels("openrouter");
	},
	async validate(apiKey: string, _modelId: string) {
		const key = apiKey.trim();
		if (!key) return { ok: false, error: "API key cannot be empty" };
		try {
			const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(8000),
			});
			if (res.ok) return { ok: true };
			const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			const msg = json?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
			return { ok: false, error: msg };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Validation request failed: ${message}` };
		}
	},
});

// 5. Groq
registry.register({
	id: "groq",
	name: "Groq",
	description: "Ultra-low latency LPU inference engine",
	envKeys: ["GROQ_API_KEY"],
	defaultModel: "llama-3.3-70b-versatile",
	getModels() {
		return getProviderModels("groq");
	},
	async validate(apiKey: string, _modelId: string) {
		const key = apiKey.trim();
		if (!key) return { ok: false, error: "API key cannot be empty" };
		try {
			const res = await fetch("https://api.groq.com/openai/v1/models", {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(8000),
			});
			if (res.ok) return { ok: true };
			const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
			const msg = json?.error?.message || `HTTP ${res.status}: ${res.statusText}`;
			return { ok: false, error: msg };
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			return { ok: false, error: `Validation request failed: ${message}` };
		}
	},
});

/**
 * Resolves an API key for a provider from either environment variables or the secure credential store.
 */
export async function resolveApiKey(
	provider: ProviderDefinition,
): Promise<{ key: string; source: "env" | "store" } | undefined> {
	for (const envKey of provider.envKeys) {
		const val = process.env[envKey];
		if (val && val.trim().length > 0) {
			return { key: val.trim(), source: "env" };
		}
	}

	const store = getCredentialStore();
	const stored = await store.getApiKey(provider.id);
	if (stored && stored.trim().length > 0) {
		return { key: stored.trim(), source: "store" };
	}

	return undefined;
}
