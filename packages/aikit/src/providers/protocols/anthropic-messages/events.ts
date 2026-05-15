import type Anthropic from "@anthropic-ai/sdk";
import type { Message } from "../../../message/message";

export type AnthropicStopReason = Anthropic.Messages.StopReason | "sensitive";

export function mapStopReason(reason: AnthropicStopReason): Message.StopReason {
	switch (reason) {
		case "end_turn":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "refusal":
		case "sensitive":
			return "error";
		default:
			throw new Error("Unhandled Anthropic stop reason");
	}
}

export type Block = (Message.ThinkingContent | Message.TextContent | (Message.ToolCall & { partialJson: string })) & {
	index: number;
};
