/**
 * Shared helpers for the live-provider (*.e2e.test.ts) suites: API-key gates,
 * registry model getters, provider options, and message text extraction.
 */
import "./env.ts";

import { describe } from "vite-plus/test";
import { llm } from "../../src/llm.ts";
import type {
	AnthropicOptions,
	GoogleOptions,
	OpenAICodexOptions,
	OpenAIOptions,
	OpenRouterOptions,
} from "../../src/llm/options.ts";
import type * as Protocol from "../../src/llm/protocol.ts";
import type * as Message from "../../src/message/message.ts";
import * as Model from "../../src/model/model.ts";

/** A model whose protocol has registered stream support (accepted by stream/complete). */
export type StreamableModel = Model.TModel<Protocol.ProtocolWithOptions>;

export const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
export const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
export const describeIfOpenAICodex = process.env.OPENAI_CODEX_API_KEY ? describe : describe.skip;
export const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;
export const describeIfGoogle = process.env.GEMINI_API_KEY ? describe : describe.skip;

export function googleOptions(extras: GoogleOptions = {}): GoogleOptions {
	return { ...fromEnvApiKey(process.env.GEMINI_API_KEY), ...extras };
}

export async function getGoogleModel(modelId = "gemini-3.5-flash"): Promise<Model.TModel<"google">> {
	const model = await llm("google", modelId);
	assertProtocol(model, Model.KnownProviderEnum.google);
	return model;
}

function fromEnvApiKey(value: string | undefined): { apiKey: string } | Record<string, never> {
	return value === undefined ? {} : { apiKey: value };
}

/** Every Anthropic suite runs once per model: current generation, then the 4.5 generation. */
export const ANTHROPIC_E2E_MODELS = [
	"claude-sonnet-4-6",
	"claude-sonnet-5",
	"claude-sonnet-5-5",
	"claude-opus-4-6",
	"claude-opus-4-8",
	"claude-opus-5-5",
	"claude-fable-5-1",
	"claude-sonnet-4-5-20250929",
	"claude-haiku-4-5-20251001",
] as const;

/**
 * The lowest effort at which a model reliably emits thinking on a short reasoning prompt:
 * adaptive models skip thinking below high (Opus 4.6) or below max (Sonnet 5, 5.5, Fable).
 */
export function anthropicThinkingLevel(modelId: string): "high" | "max" {
	return /^claude-(sonnet|fable)-5/.test(modelId) ? "max" : "high";
}

export function anthropicOptions(extras: AnthropicOptions = {}): AnthropicOptions {
	return { ...fromEnvApiKey(process.env.ANTHROPIC_API_KEY), ...extras };
}

/** Every OpenAI suite runs once per model, latest to oldest. */
export const OPENAI_E2E_MODELS = [
	"gpt-6-luna",
	"gpt-5.6-luna",
	"gpt-5.5",
	"gpt-5.4",
	"gpt-5.4-mini",
	"gpt-5.4-nano",
] as const;

/**
 * Every Codex suite runs once per model. The Codex backend rejects gpt-5.4, gpt-5.4-mini and
 * gpt-5.4-nano for ChatGPT accounts ("not supported when using Codex with a ChatGPT account").
 */
export const OPENAI_CODEX_E2E_MODELS = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.5"] as const;

/** Suites default to low reasoning; pass `reasoning` to override. */
export function openaiOptions(extras: OpenAIOptions = {}): OpenAIOptions {
	return { ...fromEnvApiKey(process.env.OPENAI_API_KEY), reasoning: "low", ...extras };
}

export function openaiCodexOptions(extras: OpenAICodexOptions = {}): OpenAICodexOptions {
	return { ...fromEnvApiKey(process.env.OPENAI_CODEX_API_KEY), reasoning: "low", ...extras };
}

export function openrouterOptions(extras: OpenRouterOptions = {}): OpenRouterOptions {
	return {
		...fromEnvApiKey(process.env.OPENROUTER_API_KEY),
		headers: {
			"HTTP-Referer": "https://www.codework.sh",
			"X-OpenRouter-Title": "CodeWork",
			"X-OpenRouter-Categories": "cli-agent,personal-agent",
		},
		...extras,
	};
}

export function assertProtocol<TProtocol extends Model.KnownProviderEnum>(
	model: Model.Info | undefined,
	protocol: TProtocol,
): asserts model is Model.TModel<TProtocol> {
	if (!model) throw new Error("expected model to be defined");
	if (model.protocol !== protocol) {
		throw new Error(`expected ${protocol} protocol, received ${model.protocol}`);
	}
}

export async function getAnthropicModel(
	modelId: string,
): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", modelId);
	assertProtocol(model, Model.KnownProviderEnum.anthropic);
	return model;
}

export async function getOpenAIModel(modelId: string): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", modelId);
	assertProtocol(model, Model.KnownProviderEnum.openai);
	return model;
}

export async function getOpenAICodexModel(
	modelId: string,
): Promise<Model.TModel<typeof Model.KnownProviderEnum.openaiCodex>> {
	const model = await llm("openai-codex", modelId);
	assertProtocol(model, Model.KnownProviderEnum.openaiCodex);
	return model;
}

/** Every OpenRouter suite runs once per model. */
export const OPENROUTER_E2E_MODELS = [
	"deepseek/deepseek-v4.1-flash",
	"google/gemini-3.8-flash",
	"meta/muse-spark-1.3-contributor",
] as const;

export async function getOpenRouterModel(
	modelId: string,
): Promise<Model.TModel<typeof Model.KnownProviderEnum.openrouter>> {
	const model = await llm("openrouter", modelId);
	assertProtocol(model, Model.KnownProviderEnum.openrouter);
	return model;
}

/** Concatenated text parts of an assistant message. */
export function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

/** Concatenated text and thinking parts of an assistant message. */
export function getGeneratedText(message: Message.AssistantMessage): string {
	return message.parts
		.flatMap((part) => {
			if (part.type === "text") return [part.text];
			if (part.type === "thinking") return [part.thinking];
			return [];
		})
		.join("\n");
}
