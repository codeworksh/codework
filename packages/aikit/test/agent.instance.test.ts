import "./utils/env";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { Type } from "@sinclair/typebox";
import { Agent } from "../src/agent/agent";
import type { Event } from "../src/event/event";
import { Message } from "../src/message/message";
import { ModelCatalog } from "../src/model/catalog";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";
import { AssistantMessageEventStream } from "../src/utils/eventstream";
import { ROOT_MODELS_PATH } from "./utils/paths";

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
		reasoning: true,
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

function userMessage(text: string): Message.UserMessage {
	return Message.createUserMessage({
		role: "user",
		time: {
			created: Date.now(),
		},
		parts: [
			{
				type: "text",
				text,
			},
		],
	});
}

function textContent(text: string): Message.TextContent {
	return {
		type: "text",
		text,
	};
}

function createAssistantMessage(
	model: Model.Value,
	stopReason: Message.AssistantMessage["stopReason"] = "stop",
): Message.AssistantMessage {
	return Message.createAssistantMessage({
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
		stopReason,
		time: {
			created: Date.now(),
			completed: Date.now(),
		},
		parts: [],
	});
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
		const partial = createAssistantMessage(model, "toolUse");
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

		partial.time.completed = partial.time.created + 1;
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

function getText(message: Message.AssistantMessage): string {
	return message.parts
		.filter((part): part is Message.TextContent => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function getEventLabel(event: Event.AgentEvent): string {
	switch (event.type) {
		case "agent.start":
		case "agent.end":
		case "turn.start":
			return event.type;
		case "turn.end":
			return `${event.type}:${event.message.stopReason}`;
		case "message.start":
		case "message.end":
		case "message.update":
			return `${event.type}:${event.message.role}`;
		case "message.part.start":
		case "message.part.end":
			return `${event.type}:${event.message.role}:${event.part.type}`;
		case "message.part.update":
			return `${event.type}:${event.message.role}:${event.part.type}:${event.source}`;
		case "tool.execution.start":
		case "tool.execution.update":
		case "tool.execution.end":
			return `${event.type}:${event.name}`;
	}
}

describe("Agent.Instance", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("resolves provider models and threads creation options into loop execution", async () => {
		const captured: {
			context?: Message.Context;
			options?: Parameters<Agent.Instance["streamFn"]>[2];
		} = {};

		const instance = await Agent.create({
			provider: "openai",
			model: "gpt-5",
			name: "builder",
			initialState: {
				systemPrompt: "Be precise.",
				thinkingLevel: "medium",
			},
			sessionId: "session-1",
			transport: "auto",
			thinkingBudgets: {
				medium: 128,
			},
			toolExecution: "sequential",
			getApiKey: async () => "test-key",
			onPayload: async (payload) => payload,
			streamFn: async (model, context, options) => {
				captured.context = context;
				captured.options = options;
				return createTextResponseStream(model, "ready");
			},
		});

		expect(instance).toBeInstanceOf(Agent.Instance);
		expect(instance.getName()).toBe("builder");
		expect(instance.state.model.id).toBe("gpt-5");

		await instance.prompt([textContent("hello")]);

		expect(captured.context?.systemPrompt).toBe("Be precise.");
		expect(captured.options?.sessionId).toBe("session-1");
		expect(captured.options?.transport).toBe("auto");
		expect(captured.options?.reasoning).toBe("medium");
		expect(captured.options?.thinkingBudgets).toEqual({ medium: 128 });
		expect(captured.options?.apiKey).toBe("test-key");
		expect(typeof captured.options?.onPayload).toBe("function");
	});

	it("throws a named error when a provider model cannot be resolved", async () => {
		try {
			await Agent.create({
				provider: "openai",
				model: "does-not-exist",
			});
			throw new Error("expected Agent.create() to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Agent.ModelNotFoundErr);
			expect((error as InstanceType<typeof Agent.ModelNotFoundErr>).data.provider).toBe("openai");
			expect((error as InstanceType<typeof Agent.ModelNotFoundErr>).data.model).toBe("does-not-exist");
		}
	});

	it("emits prompt and assistant streaming events in deterministic order", async () => {
		const instance = await Agent.create({
			model: createModel(),
			streamFn: async (model) => createTextResponseStream(model, "Hello world"),
		});

		const labels: string[] = [];
		instance.subscribe((event) => {
			labels.push(getEventLabel(event));
		});

		await instance.prompt([textContent("say hello")]);

		expect(labels).toEqual([
			"agent.start",
			"turn.start",
			"message.start:user",
			"message.part.start:user:text",
			"message.part.end:user:text",
			"message.end:user",
			"message.start:assistant",
			"message.part.start:assistant:text",
			"message.part.update:assistant:text:llm",
			"message.part.end:assistant:text",
			"message.update:assistant",
			"message.end:assistant",
			"turn.end:stop",
			"agent.end",
		]);

		expect(instance.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(getText(instance.state.messages[1] as Message.AssistantMessage)).toBe("Hello world");
	});

	it("continues existing state with loopContinue() without re-emitting prior user messages", async () => {
		const instance = await Agent.create({
			model: createModel(),
			streamFn: async (model) => createTextResponseStream(model, "continued reply"),
		});
		instance.replaceMessages([userMessage("retry this")]);

		const labels: string[] = [];
		instance.subscribe((event) => {
			labels.push(getEventLabel(event));
		});

		await instance.loopContinue();

		expect(labels).toEqual([
			"agent.start",
			"turn.start",
			"message.start:assistant",
			"message.part.start:assistant:text",
			"message.part.update:assistant:text:llm",
			"message.part.end:assistant:text",
			"message.update:assistant",
			"message.end:assistant",
			"turn.end:stop",
			"agent.end",
		]);
		expect(instance.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("emits ordered tool lifecycle events and stores tool results on the assistant message", async () => {
		const calculatorTool = Agent.defineTool({
			name: "calculator",
			label: "Calculator",
			description: "Evaluates arithmetic expressions",
			parameters: Type.Object({
				expression: Type.String(),
			}),
			async execute(_callID, params, _signal, onUpdate) {
				await onUpdate?.({
					status: "running",
					partial: {
						content: [{ type: "text", text: `Calculating ${params.expression}` }],
					},
				});

				return {
					status: "completed",
					result: {
						content: [{ type: "text", text: "450" }],
						isError: false,
					},
				};
			},
		});

		let callCount = 0;
		const instance = await Agent.create({
			model: createModel(),
			initialState: {
				tools: [calculatorTool],
			},
			streamFn: async (model) => {
				callCount += 1;
				if (callCount === 1) {
					return createToolUseResponseStream(model);
				}
				return createTextResponseStream(model, "The answer is 450");
			},
		});

		const labels: string[] = [];
		instance.subscribe((event) => {
			labels.push(getEventLabel(event));
		});

		await instance.prompt([textContent("Use the calculator tool for 25 * 18")]);

		expect(labels).toEqual([
			"agent.start",
			"turn.start",
			"message.start:user",
			"message.part.start:user:text",
			"message.part.end:user:text",
			"message.end:user",
			"message.start:assistant",
			"message.part.start:assistant:toolCall",
			"message.part.update:assistant:toolCall:llm",
			"message.part.end:assistant:toolCall",
			"message.update:assistant",
			"message.end:assistant",
			"tool.execution.start:calculator",
			"tool.execution.update:calculator",
			"message.part.update:assistant:toolCall:tool",
			"tool.execution.end:calculator",
			"message.part.start:assistant:toolCall",
			"message.part.end:assistant:toolCall",
			"message.update:assistant",
			"turn.end:toolUse",
			"turn.start",
			"message.start:assistant",
			"message.part.start:assistant:text",
			"message.part.update:assistant:text:llm",
			"message.part.end:assistant:text",
			"message.update:assistant",
			"message.end:assistant",
			"turn.end:stop",
			"agent.end",
		]);
		expect(callCount).toBe(2);
		expect(instance.state.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);

		const toolMessage = instance.state.messages[1] as Message.AssistantMessage;
		const toolPart = toolMessage.parts[0];
		expect(toolPart?.type).toBe("toolCall");
		expect(toolPart && "status" in toolPart ? toolPart.status : undefined).toBe("completed");

		const finalMessage = instance.state.messages[2] as Message.AssistantMessage;
		expect(getText(finalMessage)).toContain("450");
	});

	it("reconciles tool updates onto the same assistant message after state is reloaded", async () => {
		let instance!: Agent.Instance;
		let callCount = 0;
		let runningToolStatus: Message.ToolCall["status"] | undefined;

		const calculatorTool = Agent.defineTool({
			name: "calculator",
			label: "Calculator",
			description: "Evaluates arithmetic expressions",
			parameters: Type.Object({
				expression: Type.String(),
			}),
			async execute(_callID, params, _signal, onUpdate) {
				const toolMessage = instance.state.messages.find(
					(message): message is Message.AssistantMessage =>
						message.role === "assistant" && message.stopReason === "toolUse",
				);
				if (!toolMessage) {
					throw new Error("expected tool-use assistant message in state");
				}

				// Simulate a consumer reloading persisted messages mid-turn.
				instance.replaceMessages(structuredClone(instance.state.messages));

				await onUpdate?.({
					status: "running",
					partial: {
						content: [{ type: "text", text: `Calculating ${params.expression}` }],
					},
				});

				const storedToolMessage = instance.state.messages.find(
					(message): message is Message.AssistantMessage => message.messageId === toolMessage.messageId,
				);
				const runningPart = storedToolMessage?.parts[0];
				if (runningPart?.type === "toolCall") {
					runningToolStatus = runningPart.status;
				}

				return {
					status: "completed",
					result: {
						content: [{ type: "text", text: "450" }],
						isError: false,
					},
				};
			},
		});

		instance = await Agent.create({
			model: createModel(),
			initialState: {
				tools: [calculatorTool],
			},
			streamFn: async (model) => {
				callCount += 1;
				if (callCount === 1) {
					return createToolUseResponseStream(model);
				}
				return createTextResponseStream(model, "The answer is 450");
			},
		});

		await instance.prompt([textContent("Use the calculator tool for 25 * 18")]);

		expect(runningToolStatus).toBe("running");

		const toolMessage = instance.state.messages.find(
			(message): message is Message.AssistantMessage =>
				message.role === "assistant" && message.stopReason === "toolUse",
		);
		const toolPart = toolMessage?.parts[0];
		expect(toolPart?.type).toBe("toolCall");
		expect(toolPart && "status" in toolPart ? toolPart.status : undefined).toBe("completed");
	});

	it("delivers queued follow-up messages in a later turn with the correct event order", async () => {
		const instance = await Agent.create({
			model: createModel(),
			streamFn: async (model, context) => {
				const lastUser = [...context.messages]
					.reverse()
					.find((message): message is Message.UserMessage => message.role === "user");
				return createTextResponseStream(
					model,
					`Handled: ${lastUser?.parts[0]?.type === "text" ? lastUser.parts[0].text : ""}`,
				);
			},
		});

		instance.followUp(userMessage("second task"));

		const labels: string[] = [];
		instance.subscribe((event) => {
			labels.push(getEventLabel(event));
		});

		await instance.prompt([textContent("first task")]);

		expect(labels).toEqual([
			"agent.start",
			"turn.start",
			"message.start:user",
			"message.part.start:user:text",
			"message.part.end:user:text",
			"message.end:user",
			"message.start:assistant",
			"message.part.start:assistant:text",
			"message.part.update:assistant:text:llm",
			"message.part.end:assistant:text",
			"message.update:assistant",
			"message.end:assistant",
			"turn.end:stop",
			"turn.start",
			"message.start:user",
			"message.part.start:user:text",
			"message.part.end:user:text",
			"message.update:user",
			"message.end:user",
			"message.start:assistant",
			"message.part.start:assistant:text",
			"message.part.update:assistant:text:llm",
			"message.part.end:assistant:text",
			"message.update:assistant",
			"message.end:assistant",
			"turn.end:stop",
			"agent.end",
		]);
		expect(instance.state.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(getText(instance.state.messages[1] as Message.AssistantMessage)).toContain("first task");
		expect(getText(instance.state.messages[3] as Message.AssistantMessage)).toContain("second task");
	});

	it("rejects concurrent prompts while the instance is still streaming", async () => {
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});

		const instance = await Agent.create({
			model: createModel(),
			streamFn: async (model) => {
				const stream = new AssistantMessageEventStream();

				queueMicrotask(async () => {
					const partial = createAssistantMessage(model);
					stream.push({ type: "start", partial });

					partial.parts.push({ type: "text", text: "" });
					stream.push({ type: "text.start", partIndex: 0, partial });

					await released;

					(partial.parts[0] as Message.TextContent).text = "done";
					partial.usage.output = 1;
					partial.usage.totalTokens = 1;
					partial.time.completed = partial.time.created + 1;

					stream.push({ type: "text.delta", partIndex: 0, delta: "done", partial });
					stream.push({ type: "text.end", partIndex: 0, content: "done", partial });
					stream.push({ type: "done", reason: "stop", message: structuredClone(partial) });
					stream.end();
				});

				return stream;
			},
		});

		const runningPrompt = instance.prompt([textContent("first")]);

		try {
			await instance.prompt([textContent("second")]);
			throw new Error("expected the second prompt to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(Agent.AgentInStreamingErr);
			expect((error as InstanceType<typeof Agent.AgentInStreamingErr>).data.name).toBe("main");
		}

		release();
		await runningPrompt;
	});
});

const describeIfAnthropic = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

describeIfAnthropic("Agent.Instance integration", () => {
	const originalModelsPath = process.env.CODEWORK_AIKIT_MODELS_PATH;

	beforeEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = ROOT_MODELS_PATH;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	afterEach(() => {
		process.env.CODEWORK_AIKIT_MODELS_PATH = originalModelsPath;
		ModelCatalog.modelsDevData.reset();
		Model.registry.reset();
	});

	it("runs a live prompt against a real provider and emits agent lifecycle events", async () => {
		const instance = await Agent.create({
			provider: "anthropic",
			model: "claude-haiku-4-5-20251001",
			name: "live-agent",
			getApiKey: async () => process.env.ANTHROPIC_API_KEY,
		});
		instance.setSystemPrompt("Reply with the requested text only.");

		const labels: string[] = [];
		instance.subscribe((event) => {
			labels.push(getEventLabel(event));
		});

		await instance.prompt([textContent("Reply with exactly: Agent instance live test successful")]);

		expect(labels[0]).toBe("agent.start");
		expect(labels.at(-1)).toBe("agent.end");

		const finalMessage = instance.state.messages.at(-1);
		expect(finalMessage?.role).toBe("assistant");
		expect(instance.state.messages[0]?.role).toBe("user");

		const finalText = getText(finalMessage as Message.AssistantMessage);
		expect(finalText).toContain("Agent instance live test successful");
	}, 30000);
});
