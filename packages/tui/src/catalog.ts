import fs from "node:fs";
import path from "node:path";
import { getCodeworkDir } from "./credentials.ts";

export interface ModelEntry {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly isDefault?: boolean;
}

const DEFAULT_MODELS: Record<string, readonly ModelEntry[]> = {
	google: [
		{
			id: "gemini-2.5-pro",
			name: "Gemini 2.5 Pro",
			description: "State-of-the-art coding and reasoning",
			isDefault: true,
		},
		{ id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: "High speed, balanced capability" },
		{ id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", description: "Fast production-grade model" },
		{ id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", description: "Deep context window and analysis" },
		{ id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", description: "Lightweight and cost-efficient" },
	],
	openai: [
		{ id: "gpt-4o", name: "GPT-4o", description: "Flagship multimodal intelligence", isDefault: true },
		{ id: "gpt-4o-mini", name: "GPT-4o Mini", description: "Fast, cost-efficient everyday tasks" },
		{ id: "o1", name: "o1", description: "Advanced reasoning and deep math" },
		{ id: "o3-mini", name: "o3-mini", description: "High-speed reasoning and code synthesis" },
		{ id: "gpt-4-turbo", name: "GPT-4 Turbo", description: "High capability GPT-4 generation" },
	],
	anthropic: [
		{
			id: "claude-3-7-sonnet-latest",
			name: "Claude 3.7 Sonnet",
			description: "Hybrid reasoning and coding champion",
			isDefault: true,
		},
		{ id: "claude-3-5-sonnet-latest", name: "Claude 3.5 Sonnet", description: "Industry standard coding model" },
		{ id: "claude-3-5-haiku-latest", name: "Claude 3.5 Haiku", description: "Ultra-fast intelligent responses" },
		{ id: "claude-3-opus-latest", name: "Claude 3 Opus", description: "Deep intellectual analysis" },
	],
	openrouter: [
		{
			id: "anthropic/claude-3.7-sonnet",
			name: "Claude 3.7 Sonnet",
			description: "Anthropic via OpenRouter",
			isDefault: true,
		},
		{ id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", description: "Anthropic via OpenRouter" },
		{ id: "openai/gpt-4o", name: "GPT-4o", description: "OpenAI via OpenRouter" },
		{ id: "deepseek/deepseek-r1", name: "DeepSeek R1", description: "Open reasoning model" },
		{ id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", description: "Meta open weights" },
		{ id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", description: "Google via OpenRouter" },
	],
	groq: [
		{
			id: "llama-3.3-70b-versatile",
			name: "Llama 3.3 70B Versatile",
			description: "Ultra-low latency inference",
			isDefault: true,
		},
		{ id: "llama-3.1-8b-instant", name: "Llama 3.1 8B Instant", description: "Fastest response times" },
		{
			id: "deepseek-r1-distill-llama-70b",
			name: "DeepSeek R1 Distill 70B",
			description: "Fast reasoning on Groq LPU",
		},
		{ id: "mixtral-8x7b-32768", name: "Mixtral 8x7b", description: "High context MoE architecture" },
		{ id: "gemma2-9b-it", name: "Gemma 2 9B", description: "Google open weights on Groq" },
	],
};

function tryFindCatalogPath(): string | undefined {
	const candidates = [
		process.env.CODEWORK_MODELS_FILE,
		path.join(getCodeworkDir(), "models.gen.json"),
		path.resolve(process.cwd(), "packages/aikit/models.gen.json"),
		path.resolve(process.cwd(), "packages/codework/.codework/models.gen.json"),
	];

	for (const candidate of candidates) {
		if (candidate && fs.existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

export function getProviderModels(providerId: string): readonly ModelEntry[] {
	const defaults = DEFAULT_MODELS[providerId] ?? [];
	const catalogPath = tryFindCatalogPath();
	if (!catalogPath) return defaults;

	try {
		const raw = fs.readFileSync(catalogPath, "utf8");
		const parsed = JSON.parse(raw);
		const providerData = parsed[providerId];
		if (!providerData || typeof providerData !== "object") return defaults;

		const catalogList: ModelEntry[] = [];
		const seen = new Set<string>();

		for (const d of defaults) {
			seen.add(d.id);
			catalogList.push(d);
		}

		for (const [id, info] of Object.entries(providerData)) {
			if (!seen.has(id) && info && typeof info === "object") {
				const name = (info as { name?: string }).name || id;
				catalogList.push({ id, name });
				seen.add(id);
			}
		}

		return catalogList;
	} catch {
		return defaults;
	}
}
