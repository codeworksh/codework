import { Cause, Schema } from "effect";

/** A typed wrapper for a tool failure crossing the heterogeneous registry boundary. */
export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()("ToolExecutionError", {
	toolName: Schema.String,
	cause: Schema.Defect(),
}) {}

/**
 * One line of model-facing text for a cause.
 *
 * Shared by the executor's outcome stage and the loop's outer catch so the same defect
 * reads the same either way. Never `Cause.pretty`: that joins stack traces, which would
 * put host paths and hundreds of tokens into the next request.
 */
export const errorMessage = <E>(cause: Cause.Cause<E>): string => {
	const squashed = Cause.squash(cause);
	if (squashed instanceof Error && squashed.message.trim().length > 0) return squashed.message;
	if (typeof squashed === "string" && squashed.trim().length > 0) return squashed;
	if (typeof squashed === "object" && squashed !== null && "_tag" in squashed) return String(squashed._tag);
	return "an unknown error";
};
