import { Schema } from "effect";

export { ToolExecutionError } from "@codeworksh/plugin/tool/error";

/** A call to a registered tool this request does not offer, such as a deferred tool not loaded yet. */
export class ToolUnavailable extends Schema.TaggedError<ToolUnavailable>()("ToolUnavailable", {
	name: Schema.String,
}) {
	override get message(): string {
		return `Tool "${this.name}" is not available in this thread.`;
	}
}
