import { describe, expect, it } from "vite-plus/test";
import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../src/message/message";
import { Model } from "../src/model/model";
import { Provider } from "../src/provider/provider";
import { streamAnthropic } from "../src/provider/providers/anthropic/index";
import { calculatorTool } from "./utils/tools";

function createAnthropicModel(): Model.TModel<typeof Model.KnownProtocolEnum.anthropicMessages> {
	return {
		id: "claude-test",
		name: "Claude Test",
		provider: {
			id: Provider.KnownProviderEnum.anthropic,
			name: "Anthropic",
			env: ["ANTHROPIC_API_KEY"],
		},
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
		protocol: Model.KnownProtocolEnum.anthropicMessages,
	};
}

function createAsyncIterable<T>(events: T[]): AsyncIterable<T> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};
}

describe("streamAnthropic", () => {
	it("maps Anthropics streaming events into assistant parts and final toolUse message", async () => {
		const model = createAnthropicModel();
		const context: Message.Context = {
			systemPrompt: "Use tools when helpful.",
			messages: [
				{
					role: "user",
					time: { created: 1 },
					parts: [{ type: "text", text: "Calculate 25 * 18" }],
				},
			],
			tools: [calculatorTool],
		};

		const fakeClient = {
			messages: {
				stream: () =>
					createAsyncIterable<any>([
						{
							type: "message_start",
							message: {
								id: "msg_123",
								usage: {
									input_tokens: 7,
									output_tokens: 0,
									cache_read_input_tokens: 3,
									cache_creation_input_tokens: 2,
								},
							},
						},
						{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
						{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
						{ type: "content_block_stop", index: 0 },
						{
							type: "content_block_start",
							index: 1,
							content_block: { type: "thinking", thinking: "" },
						},
						{
							type: "content_block_delta",
							index: 1,
							delta: { type: "thinking_delta", thinking: "Need calculator" },
						},
						{
							type: "content_block_delta",
							index: 1,
							delta: { type: "signature_delta", signature: "sig_1" },
						},
						{ type: "content_block_stop", index: 1 },
						{
							type: "content_block_start",
							index: 2,
							content_block: { type: "tool_use", id: "tool_1", name: "calculator", input: {} },
						},
						{
							type: "content_block_delta",
							index: 2,
							delta: { type: "input_json_delta", partial_json: '{"expression":"25 * 18"}' },
						},
						{ type: "content_block_stop", index: 2 },
						{
							type: "message_delta",
							delta: { stop_reason: "tool_use" },
							usage: {
								input_tokens: 7,
								output_tokens: 11,
								cache_read_input_tokens: 3,
								cache_creation_input_tokens: 2,
							},
						},
					]),
			},
		} as unknown as Anthropic;

		const stream = streamAnthropic(model, context, {
			apiKey: "test-key",
			client: fakeClient,
		});

		const eventTypes: string[] = [];
		const snapshots: Array<{ type: string; parts: Message.AssistantMessage["parts"]; stopReason?: string }> = [];

		for await (const event of stream) {
			eventTypes.push(event.type);
			if ("partial" in event) {
				snapshots.push({
					type: event.type,
					parts: structuredClone(event.partial.parts),
					stopReason: event.partial.stopReason,
				});
			}
		}

		const message = await stream.result();

		expect(eventTypes).toEqual([
			"start",
			"text.start",
			"text.delta",
			"text.delta",
			"text.end",
			"thinking.start",
			"thinking.delta",
			"thinking.end",
			"toolcall.start",
			"toolcall.delta",
			"toolcall.end",
			"done",
		]);

		expect(message.responseID).toBe("msg_123");
		expect(message.stopReason).toBe("toolUse");
		expect(message.parts[0]).toEqual({ type: "text", text: "Hello world" });
		expect(message.parts[1]).toEqual({
			type: "thinking",
			thinking: "Need calculator",
			thinkingSignature: "sig_1",
		});
		expect(message.parts[2]).toMatchObject({
			type: "toolCall",
			callID: "tool_1",
			name: "calculator",
			arguments: { expression: "25 * 18" },
			status: "pending",
		});
		if (message.parts[2]?.type !== "toolCall") {
			throw new Error("Expected final part to be a toolCall");
		}
		expect(message.parts[2].time.end).toBeGreaterThanOrEqual(message.parts[2].time.start);
		expect(message.usage.input).toBe(7);
		expect(message.usage.output).toBe(11);
		expect(message.usage.cacheRead).toBe(3);
		expect(message.usage.cacheWrite).toBe(2);
		expect(message.usage.totalTokens).toBe(23);

		const textDeltaSnapshot = snapshots.find((snapshot) => snapshot.type === "text.delta");
		const thinkingEndSnapshot = snapshots.find((snapshot) => snapshot.type === "thinking.end");
		const toolcallDeltaSnapshot = snapshots.find((snapshot) => snapshot.type === "toolcall.delta");
		const toolcallEndSnapshot = snapshots.find((snapshot) => snapshot.type === "toolcall.end");

		expect(textDeltaSnapshot?.parts[0]).toMatchObject({ type: "text", text: "Hello world" });
		expect(thinkingEndSnapshot?.parts[1]).toMatchObject({
			type: "thinking",
			thinking: "Need calculator",
			thinkingSignature: "sig_1",
		});
		expect(toolcallDeltaSnapshot?.parts[2]).toMatchObject({
			type: "toolCall",
			status: "pending",
			arguments: { expression: "25 * 18" },
		});
		expect(toolcallEndSnapshot?.parts[2]).toMatchObject({
			type: "toolCall",
			status: "pending",
			callID: "tool_1",
			name: "calculator",
			arguments: { expression: "25 * 18" },
		});
	});
});
