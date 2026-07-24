import type { Message } from "@codeworksh/aikit";

export const pendingCall = (
	name: string,
	arguments_: Record<string, unknown> = {},
	callID = `call-${name}`,
): Message.ToolCallPendingPart => ({
	type: "toolCall",
	callID,
	name,
	arguments: arguments_,
	status: "pending",
	time: { start: 1, end: 1 },
});
