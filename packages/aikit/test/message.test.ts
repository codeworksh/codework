import { describe, expect, it } from "vite-plus/test";
import type { Static } from "typebox";
import Schema from "typebox/schema";
import type { Agent } from "../src/agent/agent";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";
import { validateToolArguments, validateToolCall } from "../src/utils/validation";
import { expectValidToolCall } from "./utils/message";
import { searchTool } from "./utils/tools";

function createToolCall(status: Message.ToolCall["status"], arguments_: Record<string, unknown>): Message.ToolCall {
	const base = {
		type: "toolCall" as const,
		callID: "call_1",
		name: "search",
		arguments: arguments_,
		time: {
			start: 1,
			end: 2,
		},
	};

	switch (status) {
		case "pending":
			return {
				...base,
				status,
			};
		case "running":
			return {
				...base,
				status,
				partial: {
					content: [{ type: "text", text: "Working" }],
				},
			};
		case "completed":
			return {
				...base,
				status,
				result: {
					content: [{ type: "text", text: "ok" }],
					isError: false,
				},
			};
		case "error":
		case "skipped":
		case "aborted":
			return {
				...base,
				status,
				result: {
					content: [{ type: "text", text: "failed" }],
					isError: true,
				},
			};
	}
}

function createContext(): Message.Context {
	return {
		systemPrompt: "Be concise.",
		tools: [searchTool],
		messages: [
			Message.createUserMessage({
				role: "user",
				time: {
					created: 1,
				},
				parts: [{ type: "text", text: "Find the docs" }],
			}),
			Message.createAssistantMessage({
				role: "assistant",
				protocol: Model.KnownProtocolEnum.openaiResponses,
				provider: {
					id: Provider.KnownProviderEnum.openai,
					name: "OpenAI",
					env: ["OPENAI_API_KEY"],
				},
				model: "gpt-5",
				usage: {
					input: 10,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 30,
					cost: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0,
					},
				},
				stopReason: "stop",
				time: {
					created: 2,
					completed: 3,
				},
				parts: [
					{ type: "thinking", thinking: "Looking for relevant sources" },
					createToolCall("completed", { query: "aikit docs", limit: 5 }),
					{ type: "text", text: "Found the docs" },
				],
			}),
		],
	};
}

function toToolExecution(toolCall: Message.ToolCall): Agent.ToolCallInFlight {
	return {
		callID: toolCall.callID,
		name: toolCall.name,
		rawArgs: toolCall.arguments,
	};
}

describe("Message schema", () => {
	it("generates messageId values for user and assistant messages", () => {
		const userMessage = Message.createUserMessage({
			role: "user",
			time: { created: 1 },
			parts: [{ type: "text", text: "hello" }],
		});
		const assistantMessage = Message.createAssistantMessage({
			role: "assistant",
			protocol: Model.KnownProtocolEnum.openaiResponses,
			provider: {
				id: Provider.KnownProviderEnum.openai,
				name: "OpenAI",
				env: ["OPENAI_API_KEY"],
			},
			model: "gpt-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: "stop",
			time: {
				created: 1,
				completed: 2,
			},
			parts: [],
		});

		expect(typeof userMessage.messageId).toBe("string");
		expect(userMessage.messageId.length).toBeGreaterThan(0);
		expect(typeof assistantMessage.messageId).toBe("string");
		expect(assistantMessage.messageId.length).toBeGreaterThan(0);
		expect(assistantMessage.messageId).not.toBe(userMessage.messageId);
	});

	it("accepts typed tools in the tool and context schemas", () => {
		const validateToolSchema = Schema.Compile(Message.ToolSchema);
		const validateContextSchema = Schema.Compile(Message.ContextSchema);
		const context = createContext();
		const completedToolCall = createToolCall("completed", { query: "aikit docs", limit: 5 });

		expect(validateToolSchema.Check(searchTool)).toBe(true);
		expect(validateContextSchema.Check(context)).toBe(true);
		expectValidToolCall(completedToolCall, "completed");
	});

	it("rejects completed tool calls without a result payload", () => {
		const validateToolCallSchema = Schema.Compile(Message.ToolCallSchema);
		const invalidCompletedCall = {
			type: "toolCall",
			callID: "call_1",
			name: "search",
			arguments: { query: "aikit docs" },
			time: {
				start: 1,
				end: 2,
			},
			status: "completed",
		};

		const [_result, errors] = validateToolCallSchema.Errors(invalidCompletedCall);
		expect(validateToolCallSchema.Check(invalidCompletedCall)).toBe(false);
		expect(errors.some((error) => error.message?.includes("required properties result"))).toBe(true);
	});
});

describe("tool validation", () => {
	it("coerces arguments to the tool parameter schema", () => {
		const args = validateToolArguments(
			searchTool,
			toToolExecution(
				createToolCall("pending", {
					query: "aikit docs",
					limit: "5",
					includeArchived: "true",
				}),
			),
		);

		const typedArgs: Static<typeof searchTool.parameters> = args;
		expect(typedArgs.query).toBe("aikit docs");
		expect(typedArgs.limit).toBe(5);
		expect(typedArgs.includeArchived).toBe(true);
	});

	it("validates tool calls by name and reports schema errors", () => {
		expect(() =>
			validateToolCall(
				[searchTool],
				toToolExecution(
					createToolCall("pending", {
						limit: "5",
					}),
				),
			),
		).toThrow(/Validation Failed For Tool "search"/);
	});

	it("throws when the tool name is unknown", () => {
		expect(() =>
			validateToolCall([searchTool], {
				...toToolExecution(createToolCall("pending", { query: "aikit docs" })),
				name: "missing",
			}),
		).toThrow('Tool "missing" not found');
	});
});
