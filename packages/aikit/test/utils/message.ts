import { expect } from "bun:test";
import Ajv from "ajv";
import { Message } from "../../src/message/message";

const ajv = new Ajv({
	allErrors: true,
	strict: false,
	coerceTypes: true,
});

const validateToolCallSchema = ajv.compile(Message.ToolCallSchema);

function formatErrors(): string {
	return JSON.stringify(validateToolCallSchema.errors, null, 2);
}

export function expectValidToolCall(
	toolCall: Message.ToolCall,
	expectedStatus?: Message.ToolCall["status"],
): void {
	if (!validateToolCallSchema(toolCall)) {
		throw new Error(`Invalid Message.ToolCall shape:\n${formatErrors()}`);
	}

	expect(toolCall.type).toBe("toolCall");
	expect(toolCall.callID).toBeString();
	expect(toolCall.callID.length).toBeGreaterThan(0);
	expect(toolCall.name).toBeString();
	expect(toolCall.name.length).toBeGreaterThan(0);
	expect(toolCall.arguments).toBeObject();
	expect(toolCall.time.start).toBeNumber();
	expect(toolCall.time.end).toBeNumber();
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
