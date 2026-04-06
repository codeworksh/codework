import { type Static, Type } from "@sinclair/typebox";
import { Agent } from "../agent/agent";
import { Message } from "../message/message";

// TODO @sanchitrk:
// for delta events we can have metadata KV that a provider can use for internal state
// similar to index what anthropic does
export namespace Event {
	export const LLMMessageEventType = {
		start: "start",

		textStart: "text.start",
		textDelta: "text.delta",
		textEnd: "text.end",

		thinkingStart: "thinking.start",
		thinkingDelta: "thinking.delta",
		thinkingEnd: "thinking.end",

		toolcallStart: "toolcall.start",
		toolcallDelta: "toolcall.delta",
		toolcallEnd: "toolcall.end",

		done: "done",
		error: "error",
	} as const;
	export type LLMMessageEventType = (typeof LLMMessageEventType)[keyof typeof LLMMessageEventType];

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
			type: Type.Literal(LLMMessageEventType.start),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.textStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.textDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.textEnd),
			partIndex: Type.Number(),
			content: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.thinkingStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.thinkingDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.thinkingEnd),
			partIndex: Type.Number(),
			content: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.toolcallStart),
			partIndex: Type.Number(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.toolcallDelta),
			partIndex: Type.Number(),
			delta: Type.String(),
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.toolcallEnd),
			partIndex: Type.Number(),
			toolCall: Message.ToolCallSchema,
			partial: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.done),
			reason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
			message: Message.AssistantMessageSchema,
		}),
		Type.Object({
			type: Type.Literal(LLMMessageEventType.error),
			reason: Type.Union([Type.Literal("aborted"), Type.Literal("error")]),
			error: Message.AssistantMessageSchema,
		}),
	]);
	export type LLMMessageEvent = Static<typeof LLMMessageEventSchema>;

	export const AgentEventType = {
		// Agent lifecycle
		agentStart: "agent.start",
		agentEnd: "agent.end",
		// Turn lifecycle - a turn is one assistant response + any tool calls/results
		turnStart: "turn.start",
		turnEnd: "turn.end",
		// Message lifecycle - emitted for user, assistant message and corresponding parts
		messageStart: "message.start",

		messagePartStart: "message.part.start",
		messagePartUpdate: "message.part.update",
		messagePartEnd: "message.part.end",

		messageUpdate: "message.update",
		messageEnd: "message.end",
		// Tool execution lifecycle
		toolExecutionStart: "tool.execution.start",
		toolExecutionUpdate: "tool.execution.update",
		toolExecutionEnd: "tool.execution.end",
	} as const;
	export type AgentEventType = (typeof AgentEventType)[keyof typeof AgentEventType];

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
		type: Type.Literal(AgentEventType.messagePartStart),
		message: Message.UserMessageSchema,
		partIndex: Type.Number(),
		part: UserMessagePart,
	});
	// part end
	const UserMessagePartEnd = Type.Object({
		type: Type.Literal(AgentEventType.messagePartEnd),
		message: Message.UserMessageSchema,
		partIndex: Type.Number(),
		part: UserMessagePart,
	});

	//
	// assistant message part
	// part start
	const AssistantMessagePartStart = Type.Object({
		type: Type.Literal(AgentEventType.messagePartStart),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
	});
	// part update llm
	const AssistantMessagePartLLMUpdate = Type.Object({
		type: Type.Literal(AgentEventType.messagePartUpdate),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
		source: Type.Literal("llm"),
	});
	// part update tool
	const AssistantMessagePartToolUpdate = Type.Object({
		type: Type.Literal(AgentEventType.messagePartUpdate),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
		source: Type.Literal("tool"),
	});
	// part end
	const AssistantMessagePartEnd = Type.Object({
		type: Type.Literal(AgentEventType.messagePartEnd),
		message: Message.AssistantMessageSchema,
		partIndex: Type.Number(),
		part: AssistantMessagePart,
	});

	//
	// tool exection
	const ToolExecutionStartSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventType.toolExecutionStart),
		}),
	]);
	export type ToolExecutionStart = Static<typeof ToolExecutionStartSchema>;

	const ToolExecutionUpdateSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventType.toolExecutionUpdate),
		}),
		Message.ToolRunningSchema,
	]);
	export type ToolExecutionUpdate = Static<typeof ToolExecutionUpdateSchema>;

	const ToolExecutionEndSchema = Type.Composite([
		Agent.ToolCallInFlightSchema,
		Type.Object({
			type: Type.Literal(AgentEventType.toolExecutionEnd),
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
			type: Type.Literal(AgentEventType.agentStart),
		}),
		Type.Object({
			type: Type.Literal(AgentEventType.agentEnd),
			messages: Type.Array(Message.MessageSchema),
		}),
		//
		// Turn lifecycle - a turn is one assistant response + any tool calls/results
		Type.Object({
			type: Type.Literal(AgentEventType.turnStart),
		}),
		Type.Object({
			type: Type.Literal(AgentEventType.turnEnd),
			message: Message.AssistantMessageSchema,
		}),
		//
		// Message lifecycle - emitted for user, assistant and corresponding parts
		Type.Object({
			type: Type.Literal(AgentEventType.messageStart),
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
			type: Type.Literal(AgentEventType.messageUpdate),
			message: Message.MessageSchema,
		}),
		Type.Object({
			type: Type.Literal(AgentEventType.messageEnd),
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
