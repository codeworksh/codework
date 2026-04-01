import { type Static, Type } from "@sinclair/typebox";
import { Agent } from "../agent/agent";
import { Message } from "../message/message";

// TODO sanchitrk:
// for _delta events we can have metadata KV that a provider can use for internal state
// similar to index what anthropic does
export namespace Event {
	export const LLMMessageEventTypeEnum = {
		start: "start",

		textStart: "text_start",
		textDelta: "text_delta",
		textEnd: "text_end",

		thinkingStart: "thinking_start",
		thinkingDelta: "thinking_delta",
		thinkingEnd: "thinking_end",

		toolcallStart: "toolcall_start",
		toolcallDelta: "toolcall_delta",
		toolcallEnd: "toolcall_end",

		done: "done",
		error: "error",
	} as const;
	export type LLMMessageEventType = (typeof LLMMessageEventTypeEnum)[keyof typeof LLMMessageEventTypeEnum];

	/**
	 * Event protocol for AssistantMessageEventStream.
	 *
	 * Streams should emit `start` before partial updates, then terminate with either:
	 * - `done` carrying the final successful AssistantMessage, or
	 * - `error` carrying the final AssistantMessage with stopReason "error" or "aborted"
	 *   and errorMessage.
	 */
	export const LLMMessageEventSchema = Type.Union([
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.start),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.textStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.textDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.textEnd),
			partIndex: Type.Number(),
			content: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.thinkingStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.thinkingDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.thinkingEnd),
			partIndex: Type.Number(),
			content: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.toolcallStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.toolcallDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.toolcallEnd),
			partIndex: Type.Number(),
			toolCall: Message.ToolCallSchema,
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.done),
			reason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
			message: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventTypeEnum.error),
			reason: Type.Union([Type.Literal("aborted"), Type.Literal("error")]),
			error: Message.AssistantMessageSchema,
		}),
	]);
	export type LLMMessageEvent = Static<typeof LLMMessageEventSchema>;

	export const AgentEventTypeEnum = {
		// Agent lifecycle
		agentStart: "agent_start",
		agentEnd: "agent_end",
		// Turn lifecycle - a turn is one assistant response + any tool calls/results
		turnStart: "turn_start",
		turnEnd: "turn_end",
		// Message lifecycle - emitted for user, assistant message and corresponding parts
		messageStart: "message_start",

		messagePartStart: "message_part_start",
		messagePartUpdate: "message_part_update",
		messagePartEnd: "message_part_end",

		messageUpdate: "message_update",
		messageEnd: "message_end",
		// Tool execution lifecycle
		toolExecutionStart: "tool_execution_start",
		toolExecutionUpdate: "tool_execution_update",
		toolExecutionEnd: "tool_execution_end",
	} as const;
	export type AgentEventType = (typeof AgentEventTypeEnum)[keyof typeof AgentEventTypeEnum];

	//
	// message parts
	const UserMessagePart = Type.Union([Message.TextContentSchema, Message.ImageContentSchema]);
	const AssistantMessagePart = Type.Union([
		Message.TextContentSchema,
		Message.ImageContentSchema,
		Message.ThinkingContentSchema,
		Message.ToolCallSchema,
	]);

	//
	// user message part
	// part start
	const UserMessagePartStart = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartStart),
		message: Message.UserMessageSchema,
		partIndex: Type.Number(),
		part: UserMessagePart,
	});
	// part end
	const UserMessagePartEnd = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartEnd),
		message: Message.UserMessageSchema,
		partIndex: Type.Number(),
		part: UserMessagePart,
	});

	//
	// assistant message part
	// part start
	const AssistantMessagePartStart = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartStart),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
	});
	// part update llm
	const AssistantMessagePartLLMUpdate = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartUpdate),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
		source: Type.Literal("llm"),
	});
	// part update tool
	const AssistantMessagePartToolUpdate = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartUpdate),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
		source: Type.Literal("tool"),
	});
	// part end
	const AssistantMessagePartEnd = Type.Object({
		type: Type.Literal(AgentEventTypeEnum.messagePartEnd),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
	});

	//
	// tool exection
	const ToolExecutionStartSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.toolExecutionStart),
		}),
	]);
	export type ToolExecutionStart = Static<typeof ToolExecutionStartSchema>;

	const ToolExecutionUpdateSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.toolExecutionUpdate),
		}),
		Message.ToolRunningSchema,
	]);
	export type ToolExecutionUpdate = Static<typeof ToolExecutionUpdateSchema>;

	const ToolExecutionEndSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.toolExecutionEnd),
		}),
		Type.Union([Message.ToolCompletedSchema, Message.ToolErrorSchema]),
	]);
	export type ToolExecutionEnd = Static<typeof ToolExecutionEndSchema>;

	/**
	 * Events emitted by the Agent lifecycle
	 * These events provide fine-grained lifecycle information for messages, turns, and tool execution.
	 */
	export const AgentEventSchema = Type.Union([
		//
		// Agent lifecycle
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.agentStart),
		}),
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.agentEnd),
			messages: Type.Array(Message.MessageSchema),
		}),
		//
		// Turn lifecycle - a turn is one assistant response + any tool calls/results
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.turnStart),
		}),
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.turnEnd),
			message: Message.AssistantMessageSchema,
		}),
		//
		// Message lifecycle - emitted for user, assistant and corresponding parts
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.messageStart),
			message: Message.MessageSchema,
		}),
		// user message parts lifecycle
		Type.Union([UserMessagePartStart, UserMessagePartEnd]),
		//
		// assistant message parts lifecycle
		Type.Union([
			AssistantMessagePartStart,
			AssistantMessagePartLLMUpdate,
			AssistantMessagePartToolUpdate,
			AssistantMessagePartEnd,
		]),
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.messageUpdate),
			message: Message.MessageSchema,
		}),
		Type.Object({
			type: Type.Literal(AgentEventTypeEnum.messageEnd),
			message: Message.MessageSchema,
		}),
		//
		// Tool execution lifecycle
		ToolExecutionStartSchema,
		ToolExecutionUpdateSchema,
		ToolExecutionEndSchema,
	]);
	export type AgentEvent = Static<typeof AgentEventSchema>;
}
