/**
 * Shared helpers for the live-provider (*.e2e.test.ts) suites: API-key gates,
 * registry model getters, provider options, and message text extraction.
 */
import "./env";

import { describe } from "vite-plus/test";
import { llm } from "../../src/llm";
import type { AnthropicOptions, OpenAICodexOptions, OpenAIOptions, OpenRouterOptions } from "../../src/llm/options";
import type { Protocol } from "../../src/llm/protocol";
import type { Message } from "../../src/message/message";
import { Model } from "../../src/model/model";

/** A model whose protocol has registered stream support (accepted by stream/complete). */
export type StreamableModel = Model.TModel<Protocol.ProtocolWithOptions>;

export const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;
export const describeIfOpenAI = process.env.OPENAI_API_KEY ? describe : describe.skip;
export const describeIfOpenAICodex = process.env.OPENAI_CODEX_API_KEY ? describe : describe.skip;
export const describeIfOpenRouter = process.env.OPENROUTER_API_KEY ? describe : describe.skip;

export function anthropicOptions(extras: Partial<AnthropicOptions> = {}): AnthropicOptions {
	return { apiKey: process.env.ANTHROPIC_API_KEY, ...extras };
}

export function openaiOptions(extras: Partial<OpenAIOptions> = {}): OpenAIOptions {
	return { apiKey: process.env.OPENAI_API_KEY, ...extras };
}

export function openaiCodexOptions(extras: Partial<OpenAICodexOptions> = {}): OpenAICodexOptions {
	return { apiKey: process.env.OPENAI_CODEX_API_KEY, ...extras };
}

export function openrouterOptions(extras: Partial<OpenRouterOptions> = {}): OpenRouterOptions {
	return {
		apiKey: process.env.OPENROUTER_API_KEY,
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
	if (!model) throw new Error("Expected model to be defined");
	if (model.protocol !== protocol) {
		throw new Error(`Expected ${protocol} protocol, received ${model.protocol}`);
	}
}

export async function getAnthropicModel(
	modelId = "claude-haiku-4-5-20251001",
): Promise<Model.TModel<typeof Model.KnownProviderEnum.anthropic>> {
	const model = await llm("anthropic", modelId);
	assertProtocol(model, Model.KnownProviderEnum.anthropic);
	return model;
}

export async function getOpenAIModel(
	modelId = "gpt-4o-mini",
): Promise<Model.TModel<typeof Model.KnownProviderEnum.openai>> {
	const model = await llm("openai", modelId);
	assertProtocol(model, Model.KnownProviderEnum.openai);
	return model;
}

export async function getOpenAICodexModel(
	modelId = "gpt-5.4",
): Promise<Model.TModel<typeof Model.KnownProviderEnum.openaiCodex>> {
	const model = await llm("openai-codex", modelId);
	assertProtocol(model, Model.KnownProviderEnum.openaiCodex);
	return model;
}

export async function getOpenRouterModel(
	modelId = "deepseek/deepseek-v4-flash",
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
