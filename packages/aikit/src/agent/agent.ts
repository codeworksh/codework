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
	export type ToolUpdateCallback<U = any> = (result: ToolRunningResult<U>) => Promise<void> | void;

	export interface AgentTool<TParameters extends TSchema = TSchema, U = any, R = U> extends Message.Tool<TParameters> {
		// A human-readable label for the tool for display
		label: string;
		execute: (
			callID: string,
			params: Static<TParameters>,
			signal?: AbortSignal,
			onUpdate?: ToolUpdateCallback<U>,
		) => Promise<ToolTerminalResult<R>>;
	}
	export type AnyAgentTool = AgentTool<any, any, any>;

	export interface State<TTool extends AnyAgentTool = AnyAgentTool> {
		systemPrompt: string;
		model: Model.Value;
		thinkingLevel: Stream.ThinkingLevel;
		tools: TTool[];
		messages: Message.Message[];
		isStreaming: boolean;
		streamMessage: Message.Message | null;
		pendingToolCalls: Set<string>;
		error?: string;
	}

	// AgentContext is like Message.Context but uses AgentTool
	export interface AgentContext<TTool extends AnyAgentTool = AnyAgentTool> {
		systemPrompt: string;
		messages: Message.Message[];
		tools?: TTool[];
	}

	export const ToolCallInFlightSchema = Type.Object({
		callID: Type.String(),
		name: Type.String(),
		rawArgs: Type.Record(Type.String(), Type.Any()),
		args: Type.Optional(Type.Any()), // post validation
	});
	export type ToolCallInFlight = Static<typeof ToolCallInFlightSchema>;
}
