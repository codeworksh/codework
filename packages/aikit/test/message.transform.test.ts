import { describe, expect, it } from "vite-plus/test";
import { Message } from "../src/message/message";
import {
	makeAssistantMessage,
	makeCompletedToolCall,
	makeModel,
	makePendingToolCall,
	makeUserMessage,
} from "./utils/fixtures";

const sameModel = makeModel();
const otherModel = makeModel({
	id: "other-model",
	provider: { id: "other-provider", name: "Other", source: "custom", env: [] },
	protocol: "openai",
});

describe("Message.transformMessages", () => {
	it("passes user messages through unchanged", () => {
		const user = makeUserMessage("hello");
		const result = Message.transformMessages([user], sameModel);
		expect(result).toEqual([user]);
	});

	describe("thinking parts", () => {
		it("keeps thinking parts for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" }],
			});

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			expect(result.parts).toEqual([{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" }]);
		});

		it("keeps signature-only (redacted) thinking parts for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "", thinkingSignature: "sig-1" }],
			});

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			expect(result.parts).toHaveLength(1);
		});

		it("downgrades thinking to text when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "reasoning here", thinkingSignature: "sig-1" }],
			});

			const [result] = Message.transformMessages([assistant], otherModel) as [Message.AssistantMessage];
			expect(result.parts).toEqual([{ type: "text", text: "reasoning here" }]);
		});

		it("drops empty thinking parts when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				parts: [{ type: "thinking", thinking: "  ", thinkingSignature: "sig-1" }],
			});

			const [result] = Message.transformMessages([assistant], otherModel) as [Message.AssistantMessage];
			expect(result.parts).toEqual([]);
		});
	});

	describe("tool call parts", () => {
		it("strips Google thoughtSignature when handing off to another model", () => {
			const toolCall = { ...makeCompletedToolCall("call-1"), thoughtSignature: "google-sig" };
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [toolCall] });

			const [result] = Message.transformMessages([assistant], otherModel) as [Message.AssistantMessage];
			const part = result.parts[0] as Message.ToolCall;
			expect(part.thoughtSignature).toBeUndefined();
		});

		it("keeps thoughtSignature for the same model", () => {
			const toolCall = { ...makeCompletedToolCall("call-1"), thoughtSignature: "google-sig" };
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [toolCall] });

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			const part = result.parts[0] as Message.ToolCall;
			expect(part.thoughtSignature).toBe("google-sig");
		});

		it("converts pending tool calls into synthetic skipped results", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makePendingToolCall("call-1")],
			});

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			const part = result.parts[0] as Message.ToolCall;
			expect(part.status).toBe("skipped");
			if (part.status !== "skipped") throw new Error("unreachable");
			expect(part.result.isError).toBe(true);
			expect(part.result.content).toEqual([{ type: "text", text: "No result provided" }]);
		});

		it("converts running tool calls into synthetic skipped results without partials", () => {
			const running: Message.ToolCall = {
				...makePendingToolCall("call-1"),
				status: "running",
				partial: { content: [{ type: "text", text: "halfway" }] },
			};
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [running] });

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			const part = result.parts[0] as Message.ToolCall & { partial?: unknown };
			expect(part.status).toBe("skipped");
			expect(part.partial).toBeUndefined();
		});

		it("leaves completed tool calls untouched", () => {
			const completed = makeCompletedToolCall("call-1");
			const assistant = makeAssistantMessage(sameModel, { stopReason: "toolUse", parts: [completed] });

			const [result] = Message.transformMessages([assistant], sameModel) as [Message.AssistantMessage];
			expect(result.parts[0]).toEqual(completed);
		});
	});

	describe("tool call ID normalization", () => {
		it("rewrites tool call IDs via the callback when handing off to another model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call_legacy/1")],
			});

			const [result] = Message.transformMessages([assistant], otherModel, (id) => id.replaceAll("/", "_")) as [
				Message.AssistantMessage,
			];
			const part = result.parts[0] as Message.ToolCall;
			expect(part.callID).toBe("call_legacy_1");
		});

		it("applies the same mapping to later occurrences of the same ID", () => {
			const first = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call/1")],
			});
			const second = makeAssistantMessage(sameModel, {
				parts: [makeCompletedToolCall("call/1")],
			});

			let calls = 0;
			const result = Message.transformMessages([first, second], otherModel, (id) => {
				calls += 1;
				return id.replaceAll("/", "-");
			}) as Message.AssistantMessage[];

			const firstPart = result[0]!.parts[0] as Message.ToolCall;
			const secondPart = result[1]!.parts[0] as Message.ToolCall;
			expect(firstPart.callID).toBe("call-1");
			expect(secondPart.callID).toBe("call-1");
			expect(calls).toBe(1);
		});

		it("does not invoke the callback for the same model", () => {
			const assistant = makeAssistantMessage(sameModel, {
				stopReason: "toolUse",
				parts: [makeCompletedToolCall("call/1")],
			});

			let calls = 0;
			Message.transformMessages([assistant], sameModel, (id) => {
				calls += 1;
				return id;
			});
			expect(calls).toBe(0);
		});
	});

	it("does not mutate the input messages", () => {
		const assistant = makeAssistantMessage(sameModel, {
			stopReason: "toolUse",
			parts: [makePendingToolCall("call-1")],
		});
		const snapshot = structuredClone(assistant);

		Message.transformMessages([assistant], otherModel);
		expect(assistant).toEqual(snapshot);
	});
});
