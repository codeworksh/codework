import { expect } from "vite-plus/test";
import Schema from "typebox/schema";
import { Message } from "../../src/message/message";

const validateToolCallSchema = Schema.Compile(Message.ToolCallSchema);
let latestErrors: unknown[] = [];

function formatErrors(): string {
	return JSON.stringify(latestErrors, null, 2);
}

export function expectValidToolCall(toolCall: Message.ToolCall, expectedStatus?: Message.ToolCall["status"]): void {
	const [valid, errors] = validateToolCallSchema.Errors(toolCall);
	latestErrors = errors;

	if (!valid) {
		throw new Error(`Invalid Message.ToolCall shape:\n${formatErrors()}`);
	}

	expect(toolCall.type).toBe("toolCall");
	expect(typeof toolCall.callID).toBe("string");
	expect(toolCall.callID.length).toBeGreaterThan(0);
	expect(typeof toolCall.name).toBe("string");
	expect(toolCall.name.length).toBeGreaterThan(0);
	expect(toolCall.arguments).toBeTypeOf("object");
	expect(toolCall.arguments).not.toBeNull();
	expect(typeof toolCall.time.start).toBe("number");
	expect(typeof toolCall.time.end).toBe("number");
	expect(toolCall.time.end).toBeGreaterThanOrEqual(toolCall.time.start);

	if (expectedStatus) {
		expect(toolCall.status).toBe(expectedStatus);
	}
}

export function expectAssistantToolUseMessage(message: Message.AssistantMessage): Message.ToolCall[] {
	expect(message.stopReason).toBe("toolUse");

	const toolCalls = message.parts.filter((part): part is Message.ToolCall => part.type === "toolCall");
	expect(toolCalls.length).toBeGreaterThan(0);

	for (const toolCall of toolCalls) {
		expectValidToolCall(toolCall, "pending");
	}

	return toolCalls;
}
