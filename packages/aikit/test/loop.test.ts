import { describe, expect, it } from "bun:test";
import { Type } from "@sinclair/typebox";
import { Agent } from "../src/agent/agent";
import { Loop } from "../src/agent/loop";
import type { Event } from "../src/event/event";
import type { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";
import { AssistantMessageEventStream } from "../src/utils/eventstream";

function createModel(): Model.Value {
	return {
		id: "test-model",
		name: "Test Model",
		provider: {
			id: Provider.KnownProviderEnum.openai,
			name: "OpenAI",
			env: ["OPENAI_API_KEY"],
		},
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 8192,
		maxTokens: 4096,
		protocol: Model.KnownProtocolEnum.openaiResponses,
	};
}

function createUserMessage(text: string): Message.UserMessage {
	return {
		role: "user",
		time: { created: 1 },
		parts: [{ type: "text", text }],
	};
}

function createAssistantMessage(model: Model.Value): Message.AssistantMessage {
	return {
		role: "assistant",
		protocol: model.protocol,
		provider: model.provider,
		model: model.id,
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
			created: 2,
			completed: 2,
		},
		parts: [],
	};
}

function createToolUseMessage(model: Model.Value): Message.AssistantMessage {
	const message = createAssistantMessage(model);
	message.stopReason = "toolUse";
	return message;
}

function createTextResponseStream(model: Model.Value, text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	queueMicrotask(() => {
		const partial = createAssistantMessage(model);
		stream.push({ type: "start", partial });

		partial.parts.push({ type: "text", text: "" });
		stream.push({ type: "text.start", partIndex: 0, partial });

		(partial.parts[0] as Message.TextContent).text = text;
		partial.usage.output = Math.max(1, text.length);
		partial.usage.totalTokens = partial.usage.output;
		partial.time.completed = partial.time.created + 1;

		stream.push({ type: "text.delta", partIndex: 0, delta: text, partial });
		stream.push({ type: "text.end", partIndex: 0, content: text, partial });
		stream.push({ type: "done", reason: "stop", message: structuredClone(partial) });
		stream.end();
	});

	return stream;
}

function createToolUseResponseStream(model: Model.Value): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();

	queueMicrotask(() => {
		const partial = createToolUseMessage(model);
		stream.push({ type: "start", partial });

		partial.parts.push({
			type: "toolCall",
			callID: "call_1",
			name: "calculator",
			arguments: {},
			status: "pending",
			time: {
				start: 10,
				end: 10,
			},
		});
		stream.push({ type: "toolcall.start", partIndex: 0, partial });

		(partial.parts[0] as Message.ToolCallPendingPart).arguments = { expression: "25 * 18" };
		stream.push({
			type: "toolcall.delta",
			partIndex: 0,
			delta: '{"expression":"25 * 18"}',
			partial,
		});

		partial.time.completed = 12;
		stream.push({
			type: "toolcall.end",
			partIndex: 0,
			toolCall: structuredClone(partial.parts[0]) as Message.ToolCall,
			partial,
		});
		stream.push({ type: "done", reason: "toolUse", message: structuredClone(partial) });
		stream.end();
	});

	return stream;
}

function collectToolLifecycle(
	events: Event.AgentEvent[],
	callID: string,
): {
	toolExecutionStarts: Extract<Event.AgentEvent, { type: "tool.execution.start" }>[];
	toolExecutionUpdates: Extract<Event.AgentEvent, { type: "tool.execution.update" }>[];
	toolExecutionEnds: Extract<Event.AgentEvent, { type: "tool.execution.end" }>[];
	toolPartUpdates: Extract<Event.AgentEvent, { type: "message.part.update" }>[];
} {
	const toolExecutionStarts = events.filter(
		(event): event is Extract<Event.AgentEvent, { type: "tool.execution.start" }> =>
			event.type === "tool.execution.start" && event.callID === callID,
	);
	const toolExecutionUpdates = events.filter(
		(event): event is Extract<Event.AgentEvent, { type: "tool.execution.update" }> =>
			event.type === "tool.execution.update" && event.callID === callID,
	);
	const toolExecutionEnds = events.filter(
		(event): event is Extract<Event.AgentEvent, { type: "tool.execution.end" }> =>
			event.type === "tool.execution.end" && event.callID === callID,
	);
	const toolPartUpdates = events.filter(
		(event): event is Extract<Event.AgentEvent, { type: "message.part.update" }> =>
			event.type === "message.part.update" &&
			event.source === "tool" &&
			event.part.type === "toolCall" &&
			event.part.callID === callID,
	);

	return {
		toolExecutionStarts,
		toolExecutionUpdates,
		toolExecutionEnds,
		toolPartUpdates,
	};
}

describe("Loop.run", () => {
	it("streams assistant part lifecycle events and persists non-tool assistant replies", async () => {
		const model = createModel();
		const prompt = createUserMessage("say hello");

		const agentStream = Loop.run(
			{
				model,
				convertToLlm: async (messages) => messages,
			},
			{
				systemPrompt: "Be concise.",
				messages: [],
				tools: [],
			},
			[prompt],
			async () => {
				const stream = new AssistantMessageEventStream();

				queueMicrotask(() => {
					const partial = createAssistantMessage(model);
					stream.push({ type: "start", partial });

					partial.parts.push({ type: "text", text: "" });
					stream.push({ type: "text.start", partIndex: 0, partial });

					(partial.parts[0] as Message.TextContent).text += "Hello";
					stream.push({ type: "text.delta", partIndex: 0, delta: "Hello", partial });

					(partial.parts[0] as Message.TextContent).text += " world";
					stream.push({ type: "text.delta", partIndex: 0, delta: " world", partial });

					partial.usage.output = 2;
					partial.usage.totalTokens = 2;
					partial.time.completed = 3;
					stream.push({ type: "text.end", partIndex: 0, content: "Hello world", partial });

					const finalMessage = structuredClone(partial);
					stream.push({ type: "done", reason: "stop", message: finalMessage });
					stream.end();
				});

				return stream;
			},
		);

		const events: Event.AgentEvent[] = [];
		for await (const event of agentStream) {
			events.push(event);
		}

		const messages = await agentStream.result();
		const assistantMessage = messages.at(-1);

		expect(messages).toHaveLength(2);
		expect(assistantMessage?.role).toBe("assistant");
		expect(assistantMessage?.parts).toEqual([{ type: "text", text: "Hello world" }]);

		const assistantEvents = events.filter(
			(event) =>
				"message" in event &&
				event.message.role === "assistant" &&
				(event.type === "message.start" ||
					event.type === "message.part.start" ||
					event.type === "message.part.update" ||
					event.type === "message.part.end" ||
					event.type === "message.update" ||
					event.type === "message.end"),
		);
		const assistantEventTypes = assistantEvents.map((event) => event.type);
		const partStarts = assistantEvents.filter((event) => event.type === "message.part.start");
		const partUpdates = assistantEvents.filter((event) => event.type === "message.part.update");
		const partEnds = assistantEvents.filter((event) => event.type === "message.part.end");
		const messageUpdates = assistantEvents.filter((event) => event.type === "message.update");

		expect(assistantEvents.some((event) => event.type === "message.start")).toBe(true);
		expect(partStarts).toHaveLength(1);
		expect(partUpdates).toHaveLength(2);
		expect(partEnds).toHaveLength(1);
		expect(messageUpdates).toHaveLength(1);
		expect(assistantEventTypes).toEqual([
			"message.start",
			"message.part.start",
			"message.part.update",
			"message.part.update",
			"message.part.end",
			"message.update",
			"message.end",
		]);
		expect(assistantEvents.some((event) => event.type === "message.end")).toBe(true);
		expect(events.some((event) => event.type === "turn.end" && event.message.role === "assistant")).toBe(true);
		expect(events.some((event) => event.type === "agent.end")).toBe(true);
	});

	it("mutates assistant toolCall parts from pending to running to completed across the loop", async () => {
		const model = createModel();
		const prompt = createUserMessage("calculate 25 * 18");
		const calculatorParams = Type.Object({
			expression: Type.String(),
		});
		const calculatorTool: Agent.AgentTool<typeof calculatorParams, { progress: number }, { value: number }> = {
			name: "calculator",
			label: "Calculator",
			description: "Evaluates arithmetic expressions",
			parameters: calculatorParams,
			async execute(_callID, params, _signal, onUpdate) {
				await onUpdate?.({
					status: "running",
					partial: {
						content: [{ type: "text", text: `Evaluating ${params.expression}` }],
						details: { progress: 50 },
					},
				});

				return {
					status: "completed",
					result: {
						content: [{ type: "text", text: "450" }],
						details: { value: 450 },
						isError: false,
					},
				};
			},
		};

		let invocation = 0;
		const agentStream = Loop.run(
			{
				model,
				convertToLlm: async (messages) => messages,
			},
			{
				systemPrompt: "Use tools when needed.",
				messages: [],
				tools: [calculatorTool],
			},
			[prompt],
			async () => {
				invocation += 1;
				return invocation === 1 ? createToolUseResponseStream(model) : createTextResponseStream(model, "Done");
			},
		);

		const events: Event.AgentEvent[] = [];
		for await (const event of agentStream) {
			events.push(event);
		}

		const messages = await agentStream.result();
		expect(messages).toHaveLength(3);

		const toolUseMessage = messages[1] as Message.AssistantMessage;
		const finalMessage = messages[2] as Message.AssistantMessage;
		const completedToolCall = toolUseMessage.parts[0] as Message.ToolCallCompletedPart;

		expect(toolUseMessage.stopReason).toBe("toolUse");
		expect(completedToolCall.type).toBe("toolCall");
		expect(completedToolCall.status).toBe("completed");
		expect(completedToolCall.arguments).toEqual({ expression: "25 * 18" });
		expect(completedToolCall.result.content).toEqual([{ type: "text", text: "450" }]);
		expect(completedToolCall.time.end).toBeGreaterThanOrEqual(completedToolCall.time.start);
		expect(finalMessage.parts).toEqual([{ type: "text", text: "Done" }]);

		const llmPartUpdates = events.filter(
			(event) => event.type === "message.part.update" && event.source === "llm" && event.part.type === "toolCall",
		);
		const toolPartUpdates = events.filter(
			(event) => event.type === "message.part.update" && event.source === "tool" && event.part.type === "toolCall",
		);
		const toolExecutionUpdate = events.find((event) => event.type === "tool.execution.update");
		const toolExecutionEnd = events.find((event) => event.type === "tool.execution.end");
		const terminalPartStart = events.find(
			(event) =>
				event.type === "message.part.start" &&
				event.message.role === "assistant" &&
				event.part.type === "toolCall" &&
				event.part.status === "completed",
		);

		expect(llmPartUpdates).toHaveLength(1);
		expect((llmPartUpdates[0] as Extract<Event.AgentEvent, { type: "message.part.update" }>).part).toMatchObject({
			type: "toolCall",
			status: "pending",
			arguments: { expression: "25 * 18" },
		});
		expect(toolPartUpdates).toHaveLength(1);
		expect((toolPartUpdates[0] as Extract<Event.AgentEvent, { type: "message.part.update" }>).part).toMatchObject({
			type: "toolCall",
			status: "running",
		});
		expect(toolExecutionUpdate).toMatchObject({
			type: "tool.execution.update",
			status: "running",
			callID: "call_1",
		});
		expect(toolExecutionEnd).toMatchObject({
			type: "tool.execution.end",
			status: "completed",
			callID: "call_1",
		});
		expect(terminalPartStart).toBeDefined();
	});

	it("blocks tool execution in beforeToolExecution and mutates the toolCall into an error part", async () => {
		const model = createModel();
		const prompt = createUserMessage("calculate 25 * 18");
		let executeCalls = 0;
		let invocation = 0;
		let beforeContext:
			| {
					callID: string;
					rawArgs: Record<string, unknown>;
					args: unknown;
					assistantParts: Message.AssistantMessage["parts"];
			  }
			| undefined;

		const calculatorTool = Agent.defineTool({
			name: "calculator",
			label: "Calculator",
			description: "Evaluates arithmetic expressions",
			parameters: Type.Object({
				expression: Type.String(),
			}),
			async execute() {
				executeCalls += 1;
				throw new Error("tool should have been blocked");
			},
		});

		const agentStream = Loop.run(
			{
				model,
				convertToLlm: async (messages) => messages,
				beforeToolExecution: async ({ assistantMessage, toolCall }) => {
					beforeContext = {
						callID: toolCall.callID,
						rawArgs: structuredClone(toolCall.rawArgs),
						args: structuredClone(toolCall.args),
						assistantParts: structuredClone(assistantMessage.parts),
					};
					return {
						block: true,
						reason: "Blocked by policy",
						details: { code: "POLICY" },
					};
				},
			},
			{
				systemPrompt: "Use tools when needed.",
				messages: [],
				tools: [calculatorTool],
			},
			[prompt],
			async () => {
				invocation += 1;
				return invocation === 1 ? createToolUseResponseStream(model) : createTextResponseStream(model, "Blocked");
			},
		);

		const events: Event.AgentEvent[] = [];
		for await (const event of agentStream) {
			events.push(event);
		}

		const messages = await agentStream.result();
		expect(messages).toHaveLength(3);
		expect(executeCalls).toBe(0);
		expect(beforeContext).toEqual({
			callID: "call_1",
			rawArgs: { expression: "25 * 18" },
			args: { expression: "25 * 18" },
			assistantParts: [
				{
					type: "toolCall",
					callID: "call_1",
					name: "calculator",
					arguments: { expression: "25 * 18" },
					status: "pending",
					time: {
						start: 10,
						end: 10,
					},
				},
			],
		});

		const blockedMessage = messages[1] as Message.AssistantMessage;
		const followUpMessage = messages[2] as Message.AssistantMessage;
		const blockedToolCall = blockedMessage.parts[0] as Message.ToolCallErrorPart;
		expect(blockedToolCall.status).toBe("error");
		expect(blockedToolCall.result.content).toEqual([{ type: "text", text: "Blocked by policy" }]);
		expect(blockedToolCall.result.details).toEqual({ code: "POLICY" });
		expect(followUpMessage.parts).toEqual([{ type: "text", text: "Blocked" }]);

		const lifecycle = collectToolLifecycle(events, "call_1");
		expect(lifecycle.toolExecutionStarts).toHaveLength(1);
		expect(lifecycle.toolExecutionUpdates).toHaveLength(0);
		expect(lifecycle.toolExecutionEnds).toHaveLength(1);
		expect(lifecycle.toolExecutionEnds[0]?.status).toBe("error");
		expect(lifecycle.toolExecutionEnds[0]?.result).toEqual({
			content: [{ type: "text", text: "Blocked by policy" }],
			details: { code: "POLICY" },
			isError: true,
		});
		expect(lifecycle.toolPartUpdates).toHaveLength(0);
	});

	it("lets afterToolExecution override the terminal tool result without double-emitting it", async () => {
		const model = createModel();
		const prompt = createUserMessage("calculate 25 * 18");
		let invocation = 0;
		let afterContext:
			| {
					callID: string;
					args: unknown;
					originalResult: Agent.ToolTerminalResult<unknown>;
					assistantParts: Message.AssistantMessage["parts"];
			  }
			| undefined;

		const calculatorParams = Type.Object({
			expression: Type.String(),
		});
		const calculatorTool: Agent.AgentTool<typeof calculatorParams, { progress: number }, { value: number }> = {
			name: "calculator",
			label: "Calculator",
			description: "Evaluates arithmetic expressions",
			parameters: calculatorParams,
			async execute(_callID, params, _signal, onUpdate) {
				await onUpdate?.({
					status: "running",
					partial: {
						content: [{ type: "text", text: `Evaluating ${params.expression}` }],
						details: { progress: 50 },
					},
				});

				return {
					status: "completed",
					result: {
						content: [{ type: "text", text: "450" }],
						details: { value: 450 },
						isError: false,
					},
				};
			},
		};

		const agentStream = Loop.run(
			{
				model,
				convertToLlm: async (messages) => messages,
				afterToolExecution: async ({ assistantMessage, toolCall, result }) => {
					afterContext = {
						callID: toolCall.callID,
						args: structuredClone(toolCall.args),
						originalResult: structuredClone(result),
						assistantParts: structuredClone(assistantMessage.parts),
					};

					return {
						status: "completed",
						result: {
							content: [{ type: "text", text: "451" }],
							details: { value: 451, overridden: true },
							isError: false,
						},
					};
				},
			},
			{
				systemPrompt: "Use tools when needed.",
				messages: [],
				tools: [calculatorTool],
			},
			[prompt],
			async () => {
				invocation += 1;
				return invocation === 1
					? createToolUseResponseStream(model)
					: createTextResponseStream(model, "Override applied");
			},
		);

		const events: Event.AgentEvent[] = [];
		for await (const event of agentStream) {
			events.push(event);
		}

		const messages = await agentStream.result();
		expect(messages).toHaveLength(3);
		expect(afterContext).toEqual({
			callID: "call_1",
			args: { expression: "25 * 18" },
			originalResult: {
				status: "completed",
				result: {
					content: [{ type: "text", text: "450" }],
					details: { value: 450 },
					isError: false,
				},
			},
			assistantParts: [
				{
					type: "toolCall",
					callID: "call_1",
					name: "calculator",
					arguments: { expression: "25 * 18" },
					status: "running",
					partial: {
						content: [{ type: "text", text: "Evaluating 25 * 18" }],
						details: { progress: 50 },
					},
					time: {
						start: 10,
						end: 10,
					},
				},
			],
		});

		const overriddenMessage = messages[1] as Message.AssistantMessage;
		const followUpMessage = messages[2] as Message.AssistantMessage;
		const overriddenToolCall = overriddenMessage.parts[0] as Message.ToolCallCompletedPart;
		expect(overriddenToolCall.status).toBe("completed");
		expect(overriddenToolCall.result.content).toEqual([{ type: "text", text: "451" }]);
		expect(overriddenToolCall.result.details).toEqual({ value: 451, overridden: true });
		expect(followUpMessage.parts).toEqual([{ type: "text", text: "Override applied" }]);

		const lifecycle = collectToolLifecycle(events, "call_1");
		expect(lifecycle.toolExecutionStarts).toHaveLength(1);
		expect(lifecycle.toolExecutionUpdates).toHaveLength(1);
		expect(lifecycle.toolExecutionEnds).toHaveLength(1);
		expect(lifecycle.toolExecutionEnds[0]).toMatchObject({
			type: "tool.execution.end",
			status: "completed",
			callID: "call_1",
			result: {
				content: [{ type: "text", text: "451" }],
				details: { value: 451, overridden: true },
				isError: false,
			},
		});
	});
});

describe("Loop.runContinue", () => {
	it("continues from the current context and emits only new assistant events", async () => {
		const model = createModel();
		const existingMessage = createUserMessage("continue from here");
		const context: Agent.AgentContext = {
			systemPrompt: "Be concise.",
			messages: [existingMessage],
			tools: [],
		};

		const agentStream = Loop.runContinue(
			{
				model,
				convertToLlm: async (messages) => messages,
			},
			context,
			async () => createTextResponseStream(model, "continued response"),
		);

		const events: Event.AgentEvent[] = [];
		for await (const event of agentStream) {
			events.push(event);
		}

		const messages = await agentStream.result();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			role: "assistant",
			parts: [{ type: "text", text: "continued response" }],
		});

		expect(events.map((event) => event.type)).toEqual([
			"agent.start",
			"turn.start",
			"message.start",
			"message.part.start",
			"message.part.update",
			"message.part.end",
			"message.update",
			"message.end",
			"turn.end",
			"agent.end",
		]);

		expect(
			events.some((event) => event.type === "message.start" && "message" in event && event.message.role === "user"),
		).toBe(false);
	});
});
