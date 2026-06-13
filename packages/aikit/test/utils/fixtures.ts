import { Message } from "../../src/message/message";
import type { Model } from "../../src/model/model";

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
