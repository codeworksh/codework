import type * as Acp from "@codeworksh/acp/schema-v1";
import { EventList, type EventSchema, type SessionStore } from "@codeworksh/harness/effect";
import { Option, Schema } from "effect";

const isTextDelta = Schema.is(EventList.LLMTextDelta);
const isThinkingDelta = Schema.is(EventList.LLMThinkingDelta);
const isToolStarted = Schema.is(EventList.ToolStarted);
const isToolSettled = Schema.is(EventList.ToolSettled);
const isPluginUpdated = Schema.is(EventList.PluginUpdated);

// Stored parts are aikit message parts; replay reads only the fields it renders.
const TextContent = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ToolResult = Schema.Struct({
	content: Schema.Array(Schema.Union([TextContent, Schema.Struct({ type: Schema.Literal("image") })])),
	isError: Schema.Boolean,
});
const ToolCall = Schema.Struct({
	type: Schema.Literal("toolCall"),
	callID: Schema.String,
	name: Schema.String,
	arguments: Schema.Record(Schema.String, Schema.Json),
	status: Schema.String,
	result: Schema.optional(ToolResult),
});
const StoredPart = Schema.Union([
	TextContent,
	Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
	ToolCall,
]);
const decodePart = Schema.decodeUnknownOption(Schema.fromJsonString(StoredPart));

type ToolCall = typeof ToolCall.Type;

const text = (value: string): Acp.ContentBlock => ({ type: "text", text: value });

// Only `bash` ships built in; plugin tools report `other` until tools declare a kind (COD-87).
const kind = (name: string): Acp.ToolKind => (name === "bash" ? "execute" : "other");

/** The command for `bash`, otherwise the tool's label or name. */
const title = (name: string, args: Readonly<Record<string, unknown>>, label?: string): string =>
	name === "bash" && typeof args.command === "string" ? args.command : (label ?? name);

const settled = (call: Pick<ToolCall, "callID" | "name" | "arguments" | "status" | "result">): Acp.SessionUpdate => {
	const output = call.result?.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
	return {
		sessionUpdate: "tool_call_update",
		toolCallId: call.callID,
		kind: kind(call.name),
		status: call.status === "completed" ? "completed" : "failed",
		rawInput: call.arguments,
		...(call.result === undefined ? {} : { rawOutput: call.result }),
		...(output ? { content: [{ type: "content", content: text(output) }] } : {}),
	};
};

/** The live `session/update` for a harness event, if the client should see one. */
export const update = (event: EventSchema.Payload): Option.Option<Acp.SessionUpdate> => {
	if (isTextDelta(event)) {
		return Option.some({ sessionUpdate: "agent_message_chunk", content: text(event.data.delta) });
	}
	if (isThinkingDelta(event)) {
		return Option.some({ sessionUpdate: "agent_thought_chunk", content: text(event.data.delta) });
	}
	if (isToolStarted(event)) {
		return Option.some({
			sessionUpdate: "tool_call",
			toolCallId: event.data.callID,
			title: title(event.data.name, event.data.arguments, event.data.label),
			kind: kind(event.data.name),
			status: "in_progress",
			rawInput: event.data.arguments,
		});
	}
	if (isToolSettled(event)) return Option.some(settled(event.data.part));
	return Option.none();
};

/**
 * Text for the user about a plugin that failed to load, such as one configured but not installed.
 * It belongs in the conversation because the user may never see this process's logs.
 */
export const notice = (event: EventSchema.Payload): Option.Option<string> =>
	isPluginUpdated(event) && event.data.status === "failed" && event.data.error !== undefined
		? Option.some(event.data.error)
		: Option.none();

/** A notice shown to the user in the agent's message. */
export const noticeUpdate = (notice: string): Acp.SessionUpdate => ({
	sessionUpdate: "agent_message_chunk",
	content: text(`> ⚠ ${notice}\n\n`),
});

/** The `session/update`s that replay one stored entry during `session/load`. */
export const replay = ({ entry, parts }: SessionStore.HydratedEntry): ReadonlyArray<Acp.SessionUpdate> => {
	if (entry.type !== "user" && entry.type !== "assistant") return [];
	return parts.flatMap((row): ReadonlyArray<Acp.SessionUpdate> => {
		const part = decodePart(row.data);
		if (Option.isNone(part)) return [];
		switch (part.value.type) {
			case "text":
				return [
					{
						sessionUpdate: entry.type === "user" ? "user_message_chunk" : "agent_message_chunk",
						content: text(part.value.text),
					},
				];
			case "thinking":
				return [{ sessionUpdate: "agent_thought_chunk", content: text(part.value.thinking) }];
			case "toolCall":
				return [
					{
						sessionUpdate: "tool_call",
						toolCallId: part.value.callID,
						title: title(part.value.name, part.value.arguments),
						kind: kind(part.value.name),
						status: "in_progress",
						rawInput: part.value.arguments,
					},
					settled(part.value),
				];
		}
	});
};

export * as Feed from "./feed.ts";
