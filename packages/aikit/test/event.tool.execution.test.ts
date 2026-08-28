import Value from "typebox/value";
import { describe, expect, it } from "vite-plus/test";
import { Event, Message } from "../src/index.ts";

const pending: Message.ToolCallPendingPart = {
	type: "toolCall",
	callID: "call-1",
	name: "bash",
	arguments: { command: "echo hi" },
	thoughtSignature: "opaque-provider-signature",
	status: "pending",
	time: { start: 10, end: 10 },
};

describe("tool execution events", () => {
	it("carry the complete pending tool-call part at start", () => {
		const event: Event.ToolExecutionStart = {
			type: "tool.execution.start",
			messageId: "message-1",
			partIndex: 2,
			toolCall: pending,
		};

		expect(Value.Check(Event.AgentEventSchema, event)).toBe(true);
		expect(event.toolCall.thoughtSignature).toBe("opaque-provider-signature");
	});

	it("carries a complete aborted terminal part at end", () => {
		const event: Event.ToolExecutionEnd = {
			type: "tool.execution.end",
			messageId: "message-1",
			partIndex: 2,
			toolCall: {
				...pending,
				status: "aborted",
				result: {
					content: [{ type: "text", text: "Tool Call Aborted." }],
					isError: true,
				},
				time: { start: pending.time.start, end: 20 },
			},
		};

		expect(Value.Check(Event.AgentEventSchema, event)).toBe(true);
		expect(event.toolCall.arguments).toEqual({ command: "echo hi" });
	});
});
