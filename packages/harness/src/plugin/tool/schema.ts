import { type Effect, Schema } from "effect";
import * as EventSchema from "../../event/schema.ts";
import { SessionMessageSchema } from "../../session/message/schema.ts";
import { SessionSchema } from "../../session/schema.ts";
import { type AnyToolDef, type ModelContent, type RegisteredTool, ToolCallContext } from "../../tools/tool.ts";

export const ToolBefore = Schema.Struct({
	...ToolCallContext.fields,
	sessionId: SessionSchema.ID,
	messageId: SessionMessageSchema.ID,
	params: Schema.Unknown,
});
export type ToolBefore = typeof ToolBefore.Type;
export const ToolAfter = Schema.Struct({ ...ToolBefore.fields, terminal: EventSchema.AikitToolCallTerminalPart });
export type ToolAfter = typeof ToolAfter.Type;
export const ToolBeforeResult = Schema.Struct({ block: Schema.Boolean, reason: Schema.optional(Schema.String) });
export type ToolBeforeResult = typeof ToolBeforeResult.Type;
export type ToolResultContent = ModelContent;
export interface ToolAfterResult {
	readonly content?: ToolResultContent;
	readonly details?: unknown;
	readonly isError?: boolean;
}
export type HookReturn<A> = A | void | Promise<A | void> | Effect.Effect<A | void, unknown>;
export type ToolBeforeFn = (call: ToolBefore) => HookReturn<ToolBeforeResult>;
export type ToolAfterFn = (call: ToolAfter) => HookReturn<ToolAfterResult>;
export interface ToolAddOptions {
	readonly beforeToolCall?: ToolBeforeFn;
	readonly afterToolCall?: ToolAfterFn;
}
export interface ToolDefPatch {
	readonly description?: string;
	readonly label?: string;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: ReadonlyArray<string>;
}
export interface ToolRegistry {
	readonly add: (tool: RegisteredTool, options?: ToolAddOptions) => void;
	readonly update: (name: string, patch: ToolDefPatch) => void;
	readonly list: () => ReadonlyArray<AnyToolDef>;
	readonly get: (name: string) => AnyToolDef | undefined;
	readonly has: (name: string) => boolean;
}
