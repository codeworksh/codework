import { describe, expect, it } from "vite-plus/test";
import Schema from "typebox/schema";
import { Agent } from "../src/agent/agent";
import { Event } from "../src/event/event";
import { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";

function createUserMessage(parts: Message.UserMessage["parts"]): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		time: { created: 1 },
		parts,
	});
}

function createAssistantMessage(
	stopReason: Message.AssistantMessage["stopReason"],
	parts: Message.AssistantMessage["parts"],
): Message.AssistantMessage {
	return Message.createAssistantMessage({
		role: "assistant",
		protocol: Model.KnownProtocolEnum.openaiResponses,
		provider: {
			id: Provider.KnownProviderEnum.openai,
			name: "OpenAI",
			env: ["OPENAI_API_KEY"],
		},
		model: "gpt-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason,
		time: {
			created: 1,
			completed: 2,
		},
		parts,
	});
}

describe("Agent tool result schema", () => {
	it("accepts valid running, completed, and error tool execution results", () => {
		const validate = Schema.Compile(Agent.ToolResultSchema);

		const running: Agent.ToolRunningResult<{ progress: number }> = {
			status: "running",
			partial: {
				content: [{ type: "text", text: "Working" }],
			},
		};
		const completed: Agent.ToolCompletedResult<{ durationMs: number }> = {
			status: "completed",
			result: {
				content: [{ type: "text", text: "Done" }],
				isError: false,
			},
		};
		const errored: Agent.ToolErrorResult<{ code: string }> = {
			status: "error",
			result: {
				content: [{ type: "text", text: "Failed" }],
				isError: true,
				details: { code: "E_FAIL" },
			},
		};

		expect(validate.Check(running)).toBe(true);
		expect(validate.Check(completed)).toBe(true);
		expect(validate.Check(errored)).toBe(true);
	});

	it("rejects invalid status and payload combinations", () => {
		const validate = Schema.Compile(Agent.ToolResultSchema);

		expect(
			validate.Check({
				status: "completed",
				partial: {
					content: [{ type: "text", text: "Still running" }],
				},
			}),
		).toBe(false);

		expect(
			validate.Check({
				status: "error",
				result: {
					content: [{ type: "text", text: "Done" }],
					isError: false,
				},
			}),
		).toBe(false);
	});

	it("keeps details optional in the typed runtime model", () => {
		const runningWithoutDetails: Agent.ToolRunningResult<{ progress: number }> = {
			status: "running",
			partial: {
				content: [{ type: "text", text: "Working" }],
			},
		};
		const completedWithoutDetails: Agent.ToolCompletedResult<{ durationMs: number }> = {
			status: "completed",
			result: {
				content: [{ type: "text", text: "Done" }],
				isError: false,
			},
		};

		expect(runningWithoutDetails.partial?.details).toBeUndefined();
		expect(completedWithoutDetails.result.details).toBeUndefined();
	});

	it("allows running results in Agent.ToolResultSchema but not in Agent.ToolTerminalResultSchema", () => {
		const validateResult = Schema.Compile(Agent.ToolResultSchema);
		const validateTerminalResult = Schema.Compile(Agent.ToolTerminalResultSchema);
		const running: Agent.ToolRunningResult<{ progress: number }> = {
			status: "running",
			partial: {
				content: [{ type: "text", text: "Working" }],
				details: { progress: 25 },
			},
		};
		const completed: Agent.ToolCompletedResult<{ durationMs: number }> = {
			status: "completed",
			result: {
				content: [{ type: "text", text: "Done" }],
				isError: false,
				details: { durationMs: 42 },
			},
		};

		expect(validateResult.Check(running)).toBe(true);
		expect(validateTerminalResult.Check(running)).toBe(false);
		expect(validateTerminalResult.Check(completed)).toBe(true);
	});
});

describe("Agent event schema", () => {
	it("accepts tool execution events with raw args and optional validated params", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const runningUpdate: Event.AgentEvent = {
			type: "tool.execution.update",
			callID: "call_1",
			name: "search",
			rawArgs: { query: "docs", limit: "5" },
			args: { query: "docs", limit: 5 },
			status: "running",
			partial: {
				content: [{ type: "text", text: "Searching" }],
			},
		};
		const terminalEnd: Event.AgentEvent = {
			type: "tool.execution.end",
			callID: "call_1",
			name: "search",
			rawArgs: { query: "docs" },
			status: "error",
			result: {
				content: [{ type: "text", text: "Validation failed" }],
				isError: true,
			},
		};

		expect(validate.Check(runningUpdate)).toBe(true);
		expect(validate.Check(terminalEnd)).toBe(true);
	});

	it("rejects terminal updates and non-assistant turn end messages", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const userMessage = createUserMessage([{ type: "text", text: "hello" }]);

		expect(
			validate.Check({
				type: "tool.execution.update",
				callID: "call_1",
				name: "search",
				rawArgs: { query: "docs" },
				status: "completed",
				result: {
					content: [{ type: "text", text: "Done" }],
					isError: false,
				},
			}),
		).toBe(false);

		expect(
			validate.Check({
				type: "turn.end",
				message: userMessage,
			}),
		).toBe(false);
	});

	it("accepts assistant message updates and turn end events", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const assistantMessage = createAssistantMessage("stop", [{ type: "text", text: "hello" }]);

		expect(
			validate.Check({
				type: "message.update",
				message: assistantMessage,
			}),
		).toBe(true);

		expect(
			validate.Check({
				type: "turn.end",
				message: assistantMessage,
			}),
		).toBe(true);
	});

	it("requires source on message.part.update and tolerates extra fields on message.update", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const assistantMessage = createAssistantMessage("toolUse", [
			{
				type: "toolCall",
				callID: "call_1",
				name: "search",
				arguments: { query: "docs" },
				status: "pending",
				time: {
					start: 1,
					end: 2,
				},
			},
		]);

		expect(
			validate.Check({
				type: "message.part.update",
				message: assistantMessage,
				partIndex: 0,
				part: assistantMessage.parts[0],
			}),
		).toBe(false);

		expect(
			validate.Check({
				type: "message.update",
				message: assistantMessage,
				source: "tool",
			}),
		).toBe(true);

		expect(
			validate.Check({
				type: "message.part.update",
				message: assistantMessage,
				partIndex: 0,
				part: assistantMessage.parts[0],
				source: "tool",
			}),
		).toBe(true);
	});

	it("accepts message part lifecycle events for user and assistant parts", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const userMessage = createUserMessage([
			{ type: "text", text: "hello" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		]);
		const assistantMessage = createAssistantMessage("toolUse", [
			{
				type: "toolCall",
				callID: "call_1",
				name: "search",
				arguments: { query: "docs" },
				status: "pending",
				time: {
					start: 1,
					end: 2,
				},
			},
		]);

		expect(
			validate.Check({
				type: "message.part.start",
				message: userMessage,
				partIndex: 1,
				part: userMessage.parts[1],
			}),
		).toBe(true);

		expect(
			validate.Check({
				type: "message.part.update",
				message: assistantMessage,
				partIndex: 0,
				part: assistantMessage.parts[0],
				source: "tool",
			}),
		).toBe(true);

		expect(
			validate.Check({
				type: "message.part.end",
				message: assistantMessage,
				partIndex: 0,
				part: assistantMessage.parts[0],
			}),
		).toBe(true);
	});

	it("rejects role-incompatible part events", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const userMessage = createUserMessage([{ type: "text", text: "hello" }]);
		const assistantMessage = createAssistantMessage("stop", [{ type: "text", text: "hello" }]);

		expect(
			validate.Check({
				type: "message.part.start",
				message: userMessage,
				partIndex: 0,
				part: { type: "thinking", thinking: "secret" },
			}),
		).toBe(false);

		expect(
			validate.Check({
				type: "message.part.end",
				message: assistantMessage,
				partIndex: 0,
				part: { type: "image", data: "abc", mimeType: "image/png" },
			}),
		).toBe(true);
	});

	it("accepts tool-driven message updates without provider stream events", () => {
		const validate = Schema.Compile(Event.AgentEventSchema);
		const assistantMessage = createAssistantMessage("toolUse", [
			{
				type: "toolCall",
				callID: "call_1",
				name: "search",
				arguments: { query: "docs" },
				status: "completed",
				result: {
					content: [{ type: "text", text: "Done" }],
					isError: false,
				},
				time: {
					start: 1,
					end: 2,
				},
			},
		]);

		expect(
			validate.Check({
				type: "message.update",
				message: assistantMessage,
			}),
		).toBe(true);
	});
});
