/*
 * @file Terminal tool-call parts the runner writes for calls that did not run to completion.
 */

import type { Message } from "@codeworksh/aikit";

type OpenCall = Message.ToolCallPendingPart | Message.ToolCallRunningPart;

export const terminalResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	isError: true as const,
});

export const endTime = (call: OpenCall, now: number) => Math.max(call.time.end, now);

export const abortedPart = (call: OpenCall, now: number): Message.ToolCallAbortedPart => {
	const { status: _status, ...base } = call;
	return {
		...base,
		status: "aborted",
		result: terminalResult("Tool Execution Interrupted"),
		time: { ...call.time, end: endTime(call, now) },
	};
};

/** The message with every tool call still pending or running aborted: an ended reply never runs them. */
export const abortCalls = (message: Message.AssistantMessage, now: number): Message.AssistantMessage => ({
	...message,
	parts: message.parts.map((part) =>
		part.type === "toolCall" && (part.status === "pending" || part.status === "running")
			? abortedPart(part, now)
			: part,
	),
});

export * as RunnerPart from "./part.ts";
