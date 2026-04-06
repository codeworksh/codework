import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { Message } from "../message/message";
import type { Model } from "../model/model";
import type { Stream } from "../provider/stream";

export namespace Agent {
	export const ToolTerminalResultSchema = Type.Union([Message.ToolCompletedSchema, Message.ToolErrorSchema]);
	export const ToolResultSchema = Type.Union([
		Message.ToolRunningSchema,
		Message.ToolCompletedSchema,
		Message.ToolErrorSchema,
	]);

	export type ToolRunningResult<T> = Omit<Static<typeof Message.ToolRunningSchema>, "partial"> & {
		partial?: Omit<Static<typeof Message.ToolRunningPartial>, "details"> & {
			details?: T;
		};
	};
	export type ToolCompletedResult<T> = Omit<Static<typeof Message.ToolCompletedSchema>, "result"> & {
		result: Omit<Static<typeof Message.ToolSuccessResult>, "details"> & {
			details?: T;
		};
	};
	export type ToolErrorResult<T> = Omit<Static<typeof Message.ToolErrorSchema>, "result"> & {
		result: Omit<Static<typeof Message.ToolErrorResult>, "details"> & {
			details?: T;
		};
	};
	export type ToolTerminalResult<T> = ToolCompletedResult<T> | ToolErrorResult<T>;

	// callback for tool execution updates.
	// consumers can narrow on status if needed
	// type inference:
	// U - update
	export type ToolUpdateCallback<U = unknown> = (result: ToolRunningResult<U>) => Promise<void> | void;

	// @sanchitrk: does adding state flag makes sense?
	// could be used by caller with name+callID as key for caching results, etc.
	export interface AgentTool<TParameters extends TSchema = TSchema, U = unknown, R = U>
		extends Message.Tool<TParameters> {
		// A human-readable label for the tool for display
		label: string;
		execute: (
			callID: string,
			params: Static<TParameters>,
			signal?: AbortSignal,
			onUpdate?: ToolUpdateCallback<U>,
		) => Promise<ToolTerminalResult<R>>;
	}

	export function defineTool<TParameters extends TSchema, U = unknown, R = U>(
		tool: AgentTool<TParameters, U, R>,
	): AgentTool<TParameters, U, R> {
		return tool;
	}

	export type AnyAgentTool = AgentTool<any, any, any>;

	export interface State {
		systemPrompt: string;
		model: Model.Value;
		thinkingLevel: Stream.ThinkingLevel;
		tools: AnyAgentTool[];
		messages: Message.Message[];
		isStreaming: boolean;
		streamMessage: Message.Message | null;
		pendingToolCalls: Set<string>;
		error?: string;
	}

	// AgentContext is like Message.Context but uses AgentTool
	export interface AgentContext {
		systemPrompt: string;
		messages: Message.Message[];
		tools?: AnyAgentTool[];
	}

	export const ToolCallInFlightSchema = Type.Object({
		callID: Type.String(),
		name: Type.String(),
		rawArgs: Type.Record(Type.String(), Type.Unknown()),
		args: Type.Optional(Type.Unknown()), // post validation
	});
	export type ToolCallInFlight = Static<typeof ToolCallInFlightSchema>;
}
