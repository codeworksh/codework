import type { SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import { EventList, type EventSchema, type SessionStore } from "@codeworksh/harness/effect";
import { Option, Schema } from "effect";

export interface SessionUpdateItem {
	readonly sessionId: string;
	readonly update: SessionUpdate;
}

type EventCandidate = {
	readonly type: string;
	readonly data?: unknown;
	readonly durable?: unknown;
};

const isTextDelta = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.LLMTextDelta> =>
	Schema.is(EventList.LLMTextDelta)(event) || event.type === EventList.LLMTextDelta.type;
const isThinkingDelta = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.LLMThinkingDelta> =>
	Schema.is(EventList.LLMThinkingDelta)(event) || event.type === EventList.LLMThinkingDelta.type;
const isLLMFailed = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.LLMFailed> =>
	Schema.is(EventList.LLMFailed)(event) || event.type === EventList.LLMFailed.type;
const isToolStarted = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.ToolStarted> =>
	Schema.is(EventList.ToolStarted)(event) || event.type === EventList.ToolStarted.type;
const isToolProgress = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.ToolProgress> =>
	Schema.is(EventList.ToolProgress)(event) || event.type === EventList.ToolProgress.type;
const isToolSettled = (event: EventCandidate): event is Schema.Schema.Type<typeof EventList.ToolSettled> =>
	Schema.is(EventList.ToolSettled)(event) || event.type === EventList.ToolSettled.type;

const toolKind = (name: string): ToolKind => {
	switch (name.toLowerCase()) {
		case "bash":
		case "exec":
		case "terminal":
			return "execute";
		case "read_file":
		case "view_file":
			return "read";
		case "write_file":
		case "edit_file":
		case "replace_file_content":
			return "edit";
		case "search_web":
		case "search":
			return "search";
		case "fetch":
			return "fetch";
		default:
			return "other";
	}
};

const toolTitle = (name: string, rawArgs?: unknown): string => {
	if (rawArgs && typeof rawArgs === "object") {
		const args = rawArgs as Record<string, unknown>;
		if (typeof args.command === "string") return `Run: ${args.command}`;
		if (typeof args.commandLine === "string") return `Run: ${args.commandLine}`;
		if (typeof args.script === "string") return `Run: ${args.script}`;
		if (typeof args.path === "string") return `${name}: ${args.path}`;
		if (typeof args.query === "string") return `Search: ${args.query}`;
		if (typeof args.url === "string") return `Fetch: ${args.url}`;
	}
	return name;
};

const toolContent = (result: unknown): Array<ToolCallContent> | undefined => {
	if (result === undefined || result === null) return undefined;
	if (typeof result === "string" && result.length > 0) {
		return [{ type: "content", content: { type: "text", text: result } }];
	}
	if (typeof result === "object") {
		const res = result as Record<string, unknown>;
		if (Array.isArray(res.content)) {
			const text = res.content
				.map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
				.filter(Boolean)
				.join("\n");
			if (text) {
				return [{ type: "content", content: { type: "text", text } }];
			}
		}
		if (typeof res.message === "string" && res.message.length > 0) {
			return [{ type: "content", content: { type: "text", text: res.message } }];
		}
		if (typeof res.error === "string" && res.error.length > 0) {
			return [{ type: "content", content: { type: "text", text: res.error } }];
		}
	}
	return undefined;
};

/**
 * Maps Codework harness event payloads to ACP session update notifications.
 */
export const toSessionUpdate = (event: EventSchema.Payload): SessionUpdateItem | undefined => {
	if (isTextDelta(event)) {
		const data = event.data as Record<string, unknown>;
		const delta = typeof data.delta === "string" ? data.delta : undefined;
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!delta || !sessionId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: delta,
				},
			},
		};
	}

	if (isThinkingDelta(event)) {
		const data = event.data as Record<string, unknown>;
		const delta = typeof data.delta === "string" ? data.delta : undefined;
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!delta || !sessionId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "agent_thought_chunk",
				content: {
					type: "text",
					text: delta,
				},
			},
		};
	}

	if (isLLMFailed(event)) {
		const data = event.data as Record<string, unknown>;
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!sessionId) return undefined;

		// Do not emit error messages for aborted requests (F1)
		if (data.reason === "aborted") return undefined;

		const errorMsg =
			(data.message as { errorMessage?: string })?.errorMessage ??
			(typeof data.errorMessage === "string" ? data.errorMessage : undefined) ??
			"LLM request failed";

		return {
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: `\n\n❌ **Error**: ${errorMsg}\n`,
				},
			},
		};
	}

	if (isToolStarted(event)) {
		const data = event.data as Record<string, unknown>;
		const callID = typeof data.callID === "string" ? data.callID : undefined;
		const name = typeof data.name === "string" ? data.name : "tool";
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!callID || !sessionId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: callID,
				title: toolTitle(name),
				name,
				kind: toolKind(name),
				status: "in_progress",
			},
		};
	}

	if (isToolProgress(event)) {
		const data = event.data as Record<string, unknown>;
		const callID = typeof data.callID === "string" ? data.callID : undefined;
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!callID || !sessionId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: callID,
				status: "in_progress",
				rawOutput: data.partial,
			},
		};
	}

	if (isToolSettled(event)) {
		const data = event.data as Record<string, unknown>;
		const callID = typeof data.callID === "string" ? data.callID : undefined;
		const sessionId = (data.sessionId ?? (event as Record<string, unknown>).sessionId) as string;
		if (!callID || !sessionId) return undefined;
		const part = (data.part && typeof data.part === "object" ? data.part : {}) as Record<string, unknown>;
		const statusStr = typeof part.status === "string" ? part.status : "completed";
		const isError = statusStr !== "completed";
		const name = typeof part.name === "string" ? part.name : "tool";
		const content = toolContent(part.result);

		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: callID,
				title: toolTitle(name, part.arguments),
				name,
				kind: toolKind(name),
				status: isError ? "failed" : "completed",
				rawInput: part.arguments,
				rawOutput: part.result,
				...(content ? { content } : {}),
			},
		};
	}

	return undefined;
};

/**
 * Maps a stored session entry and its parts into ACP session update notifications
 * for conversation history replay (used during session/load).
 */
export const entryToSessionUpdates = (entry: SessionStore.HydratedEntry): Array<SessionUpdate> => {
	const updates: Array<SessionUpdate> = [];
	const messageId = entry.entry.id;

	if (entry.entry.type === "user") {
		for (const part of entry.parts) {
			if (part.type === "text") {
				try {
					const parsed = JSON.parse(part.data) as { text?: string };
					if (parsed.text) {
						updates.push({
							sessionUpdate: "user_message_chunk",
							messageId,
							content: {
								type: "text",
								text: parsed.text,
							},
						});
					}
				} catch {
					if (part.data) {
						updates.push({
							sessionUpdate: "user_message_chunk",
							messageId,
							content: {
								type: "text",
								text: part.data,
							},
						});
					}
				}
			}
		}

		if (updates.length === 0) {
			const label = Option.getOrUndefined(entry.entry.label);
			let fallbackText = label;
			if (!fallbackText && entry.entry.data) {
				try {
					const parsed = JSON.parse(entry.entry.data) as { prompt?: string; text?: string };
					fallbackText = parsed.prompt ?? parsed.text;
				} catch {}
			}
			if (fallbackText) {
				updates.push({
					sessionUpdate: "user_message_chunk",
					messageId,
					content: {
						type: "text",
						text: fallbackText,
					},
				});
			}
		}
	} else if (entry.entry.type === "assistant") {
		for (const part of entry.parts) {
			switch (part.type) {
				case "thinking": {
					try {
						const parsed = JSON.parse(part.data) as { thinking?: string; text?: string };
						const text = parsed.thinking ?? parsed.text;
						if (text) {
							updates.push({
								sessionUpdate: "agent_thought_chunk",
								messageId,
								content: {
									type: "text",
									text,
								},
							});
						}
					} catch {
						if (part.data) {
							updates.push({
								sessionUpdate: "agent_thought_chunk",
								messageId,
								content: {
									type: "text",
									text: part.data,
								},
							});
						}
					}
					break;
				}
				case "text": {
					try {
						const parsed = JSON.parse(part.data) as { text?: string };
						if (parsed.text) {
							updates.push({
								sessionUpdate: "agent_message_chunk",
								messageId,
								content: {
									type: "text",
									text: parsed.text,
								},
							});
						}
					} catch {
						if (part.data) {
							updates.push({
								sessionUpdate: "agent_message_chunk",
								messageId,
								content: {
									type: "text",
									text: part.data,
								},
							});
						}
					}
					break;
				}
				case "toolCall": {
					try {
						const parsed = JSON.parse(part.data) as {
							callID?: string;
							name?: string;
							arguments?: Record<string, unknown>;
							status?: string;
							result?: unknown;
						};
						const callId = parsed.callID ?? Option.getOrElse(part.callId, () => part.id);
						const name = parsed.name ?? Option.getOrElse(part.toolName, () => "tool");
						const rawArgs = parsed.arguments;
						const statusStr = parsed.status ?? Option.getOrElse(part.status, () => "completed");
						const isError = statusStr !== "completed";
						const content = toolContent(parsed.result);

						updates.push({
							sessionUpdate: "tool_call",
							toolCallId: callId,
							title: toolTitle(name, rawArgs),
							name,
							kind: toolKind(name),
							status: "in_progress",
							rawInput: rawArgs,
						});

						updates.push({
							sessionUpdate: "tool_call_update",
							toolCallId: callId,
							title: toolTitle(name, rawArgs),
							name,
							kind: toolKind(name),
							status: isError ? "failed" : "completed",
							rawInput: rawArgs,
							rawOutput: parsed.result,
							...(content ? { content } : {}),
						});
					} catch {}
					break;
				}
			}
		}

		if (updates.length === 0 && entry.entry.data) {
			try {
				const parsed = JSON.parse(entry.entry.data) as { text?: string; content?: string };
				const text = parsed.text ?? parsed.content;
				if (text) {
					updates.push({
						sessionUpdate: "agent_message_chunk",
						messageId,
						content: {
							type: "text",
							text,
						},
					});
				}
			} catch {}
		}
	}

	return updates;
};

export * as Feed from "./feed.ts";
