import { Schema } from "effect";

/*
 * A stored message part as clients see it: aikit's part JSON (persisted verbatim by the harness),
 * narrowed to what a client renders. Provider replay data (signatures, namespaces) and tool
 * `details` are left out, so decoding a stored part drops them.
 */

export const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
export const ImageContent = Schema.Struct({
	type: Schema.Literal("image"),
	data: Schema.String,
	mimeType: Schema.String,
});
export const ThinkingContent = Schema.Struct({
	type: Schema.Literal("thinking"),
	thinking: Schema.String,
	/** The provider withheld the reasoning; `thinking` is then empty. */
	redacted: Schema.optionalKey(Schema.Boolean),
});

/** aikit's ToolStatusEnum. */
export const ToolStatus = Schema.Literals(["pending", "running", "completed", "error", "skipped", "aborted"]);

export const ToolResult = Schema.Struct({
	content: Schema.Array(Schema.Union([TextContent, ImageContent])),
	isError: Schema.Boolean,
});

export const ToolCall = Schema.Struct({
	type: Schema.Literal("toolCall"),
	callID: Schema.String,
	name: Schema.String,
	arguments: Schema.Record(Schema.String, Schema.Json),
	status: ToolStatus,
	/** Present once the call settled (completed, error, skipped, aborted). */
	result: Schema.optionalKey(ToolResult),
	/** Epoch milliseconds: started, and last lifecycle update. */
	time: Schema.optionalKey(Schema.Struct({ start: Schema.Finite, end: Schema.Finite })),
});
export type ToolCall = typeof ToolCall.Type;

export const Part = Schema.Union([TextContent, ImageContent, ThinkingContent, ToolCall]);
export type Part = typeof Part.Type;

/** A stored part row's JSON, or none when it is not a part a client renders. */
export const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Part));

export * as MessagePart from "./part.ts";
