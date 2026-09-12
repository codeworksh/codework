import { Schema } from "effect";

/** A typed wrapper for a tool failure crossing the heterogeneous registry boundary. */
export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()("ToolExecutionError", {
	toolName: Schema.String,
	cause: Schema.Defect(),
}) {}
