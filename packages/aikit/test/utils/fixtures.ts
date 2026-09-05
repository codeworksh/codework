import type { LanguageModelUsage } from "ai";
import * as Message from "../../src/message/message.ts";
import type * as Model from "../../src/model/model.ts";
import { applyModification } from "../../src/cli/modelgen.ts";

/** Exercise the same model normalization that writes the generated catalog. */
export function makeGeneratedModel(id: string, npm = "@ai-sdk/google"): Model.Info {
	const model = applyModification(
		"test-provider",
		{ id: "test-provider", name: "Test Provider", env: [], npm, models: {} },
		{
			id,
			name: id,
			family: "test",
			attachment: true,
			reasoning: true,
			tool_call: true,
			release_date: "2026-01-01",
			last_updated: "2026-01-01",
			modalities: { input: ["text", "image"], output: ["text"] },
			open_weights: false,
			limit: { context: 200_000, output: 64_000 },
		},
	);
	if (!model) throw new Error(`Unsupported test model package ${npm}`);
	return model;
}

export function makeModel(overrides: Partial<Model.Info> = {}): Model.Info {
	return {
		id: "test-model",
		name: "Test Model",
		provider: {
			id: "test-provider",
			name: "Test Provider",
			source: "custom",
			env: [],
		},
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		protocol: "anthropic",
		...overrides,
	};
}

export function makeUsage(overrides: Partial<Message.Usage> = {}): Message.Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

export function makeAssistantMessage(
	model: Model.Info,
	overrides: Partial<Message.AssistantMessage> = {},
): Message.AssistantMessage {
	return Message.createAssistantMessage({
		role: "assistant",
		parts: [],
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
		usage: makeUsage(),
		stopReason: "stop",
		time: { created: Date.now(), completed: Date.now() },
		...overrides,
	});
}

export function makeUserMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		parts: [{ type: "text", text }],
		time: { created: Date.now() },
	});
}

export function makePendingToolCall(
	callID: string,
	name = "test_tool",
	args: Record<string, unknown> = {},
): Message.ToolCallPendingPart {
	return {
		type: "toolCall",
		callID,
		name,
		arguments: args,
		status: "pending",
		time: { start: Date.now(), end: Date.now() },
	};
}

export function makeCompletedToolCall(
	callID: string,
	name = "test_tool",
	content: Array<Message.TextContent | Message.ImageContent> = [{ type: "text", text: "ok" }],
	args: Record<string, unknown> = {},
): Message.ToolCallCompletedPart {
	return {
		type: "toolCall",
		callID,
		name,
		arguments: args,
		status: "completed",
		result: { content, isError: false },
		time: { start: Date.now(), end: Date.now() },
	};
}

export function makeLanguageModelUsage(
	overrides: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
		inputTokenDetails?: {
			noCacheTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
		};
		outputTokenDetails?: {
			textTokens?: number;
			reasoningTokens?: number;
		};
	} = {},
): LanguageModelUsage {
	return {
		inputTokens: overrides.inputTokens,
		outputTokens: overrides.outputTokens,
		totalTokens: overrides.totalTokens,
		inputTokenDetails: {
			noCacheTokens: overrides.inputTokenDetails?.noCacheTokens,
			cacheReadTokens: overrides.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: overrides.inputTokenDetails?.cacheWriteTokens,
		},
		outputTokenDetails: {
			textTokens: overrides.outputTokenDetails?.textTokens,
			reasoningTokens: overrides.outputTokenDetails?.reasoningTokens,
		},
	};
}
