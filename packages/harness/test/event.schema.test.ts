import type { Message } from "@codeworksh/aikit";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { EventSchema } from "../src/event/schema.ts";

const codec = EventSchema.AikitAssistantMessage;
const decode = Schema.decodeUnknownSync(codec);
const decodeResult = Schema.decodeUnknownResult(codec);
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
	it("decodes a valid assistant message and round-trips it", () => {
		const value = message([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "thought", thinkingSignature: "sig" },
			{ ...toolCall, status: "completed", result: { content: [{ type: "text", text: "ok" }], isError: false } },
		]);

		const decoded = decode(value);
		expect(decoded).toEqual(value);
		expect(decode(encode(decoded))).toEqual(value);
	});

	it("strips streamId from text and thinking parts", () => {
		const decoded = decode(
			message([
				{ type: "text", text: "hello", streamId: "block_0" },
				{ type: "thinking", thinking: "thought", streamId: "block_1" },
			] as unknown as Message.AssistantMessage["parts"]),
		);

		expect(decoded.parts).toEqual([
			{ type: "text", text: "hello" },
			{ type: "thinking", thinking: "thought" },
		]);
	});

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

	it("leaves an unrelated part shape untouched", () => {
		const image = { type: "image", data: "aGk=", mimeType: "image/png" } as const;
		expect(decode(message([image])).parts).toEqual([image]);
	});

	it("fails decode with a typed error instead of throwing", () => {
		const result = decodeResult({ ...message([]), role: "user" });

		expect(Result.isFailure(result)).toBe(true);
		if (Result.isFailure(result)) {
			expect(Schema.isSchemaError(result.failure)).toBe(true);
			expect(String(result.failure)).toContain("validation failed for aikit assistant message");
		}
	});

	it("fails decode when a required field is missing", () => {
		const { usage: _usage, ...withoutUsage } = message([]);
		expect(Result.isFailure(decodeResult(withoutUsage))).toBe(true);
		expect(Result.isFailure(decodeResult(null))).toBe(true);
	});

	it("rejects invalid primitives instead of coercing durable event data", () => {
		const result = decodeResult({
			...message([]),
			time: { created: "10", completed: 20 },
		});
		expect(Result.isFailure(result)).toBe(true);
	});

	it("is usable as an EventSchema.define field", () => {
		const LLMEnded = EventSchema.define({
			type: "test.llm.ended",
			durable: { aggregate: "sessionId", version: 1 },
			schema: { sessionId: Schema.String, message: codec },
		});

		const value = message([{ type: "text", text: "hello" }]);
		const payload = {
			id: EventSchema.ID.create(),
			type: "test.llm.ended" as const,
			data: { sessionId: "ses_1", message: value },
		};

		const encoded = Schema.encodeSync(LLMEnded)(payload);
		expect(Schema.decodeUnknownSync(LLMEnded)(encoded).data.message).toEqual(value);
	});
});
