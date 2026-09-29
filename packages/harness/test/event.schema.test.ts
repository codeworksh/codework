import type { Message } from "@codeworksh/aikit";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { EventSchema } from "../src/event/schema.ts";

const codec = EventSchema.AikitAssistantMessage;
const decode = Schema.decodeUnknownSync(codec);
const encode = Schema.encodeSync(codec);

const message = (parts: Message.AssistantMessage["parts"]): Message.AssistantMessage => ({
	messageId: "msg_1",
	role: "assistant",
	protocol: "anthropic",
	provider: { id: "anthropic", name: "Anthropic", source: "custom", env: [] },
	model: "claude-test",
	usage: {
		input: 10,
		output: 20,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 30,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	time: { created: 10, completed: 20 },
	parts,
});

const toolCall = {
	type: "toolCall",
	callID: "call_1",
	name: "bash",
	arguments: { command: "ls" },
	status: "running",
	time: { start: 10, end: 20 },
} as const satisfies Message.AssistantMessage["parts"][number];

describe("EventSchema.AikitAssistantMessage", () => {
	it("strips partialJson from a tool call but keeps its declared progress snapshot", () => {
		const progress = { content: [{ type: "text", text: "streaming" }] };
		const parts = [
			{ ...toolCall, partialJson: '{"command":"l' },
			{ ...toolCall, callID: "call_2", partial: progress },
		] as unknown as Message.AssistantMessage["parts"];

		// `partialJson` is undeclared streaming bookkeeping and goes. `partial` is a
		// declared member of ToolCallRunningPart, so dropping it would make the codec
		// lossy for a shape aikit's own schema admits.
		expect(decode(message(parts)).parts).toEqual([toolCall, { ...toolCall, callID: "call_2", partial: progress }]);
	});

	it("strips transient fields on encode too, so they never reach a durable log", () => {
		const parts = [
			{ type: "text", text: "hello", streamId: "block_0" },
			{ ...toolCall, partialJson: "{" },
		] as unknown as Message.AssistantMessage["parts"];

		expect(encode(message(parts))).toEqual(message([{ type: "text", text: "hello" }, toolCall]));
	});
});
