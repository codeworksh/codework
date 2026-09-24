import type { SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk";
import type { EventSchema } from "@codeworksh/harness/effect";
import { Stream } from "effect";

export interface SessionUpdateItem {
	readonly sessionId: string;
	readonly update: SessionUpdate;
}

const toolKind = (name: string): ToolKind => {
	const lower = name.toLowerCase();
	if (lower.includes("read") || lower.includes("view") || lower.includes("cat") || lower === "get") return "read";
	if (lower.includes("write") || lower.includes("edit") || lower.includes("patch") || lower.includes("replace"))
		return "edit";
	if (lower.includes("delete") || lower.includes("remove") || lower.includes("rm")) return "delete";
	if (lower.includes("search") || lower.includes("grep") || lower.includes("find") || lower.includes("glob"))
		return "search";
	if (
		lower.includes("bash") ||
		lower.includes("exec") ||
		lower.includes("command") ||
		lower.includes("terminal") ||
		lower.includes("proc") ||
		lower.includes("run")
	)
		return "execute";
	if (lower.includes("fetch") || lower.includes("curl") || lower.includes("http") || lower.includes("url"))
		return "fetch";
	if (lower.includes("think")) return "think";
	return "other";
};

const toolTitle = (name: string, rawArgs?: unknown): string => {
	if (rawArgs && typeof rawArgs === "object") {
		const args = rawArgs as Record<string, unknown>;
		if (typeof args.command === "string") return `Run: ${args.command}`;
		if (typeof args.CommandLine === "string") return `Run: ${args.CommandLine}`;
		if (typeof args.path === "string") return `${name}: ${args.path}`;
		if (typeof args.AbsolutePath === "string") return `${name}: ${args.AbsolutePath}`;
		if (typeof args.TargetFile === "string") return `${name}: ${args.TargetFile}`;
		if (typeof args.query === "string") return `Search: ${args.query}`;
		if (typeof args.Query === "string") return `Search: ${args.Query}`;
		if (typeof args.url === "string") return `Fetch: ${args.url}`;
		if (typeof args.Url === "string") return `Fetch: ${args.Url}`;
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
	const data = event.data as Record<string, unknown>;
	const sessionId = (data?.sessionId ?? event.metadata?.sessionId) as string | undefined;
	if (!sessionId) return undefined;

	if (event.type.startsWith("session.llm.text.delta")) {
		const delta = typeof data.delta === "string" ? data.delta : undefined;
		if (!delta) return undefined;
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

	if (event.type.startsWith("session.llm.thinking.delta")) {
		const delta = typeof data.delta === "string" ? data.delta : undefined;
		if (!delta) return undefined;
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

	if (event.type.startsWith("session.llm.failed")) {
		const errorMsg =
			(typeof data.errorMessage === "string" ? data.errorMessage : undefined) ??
			(typeof (data.failure as Record<string, unknown>)?.message === "string"
				? ((data.failure as Record<string, unknown>).message as string)
				: undefined) ??
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

	if (event.type.startsWith("session.tool.started")) {
		const callId = typeof data.callID === "string" ? data.callID : undefined;
		const name = typeof data.name === "string" ? data.name : "tool";
		if (!callId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: callId,
				title: toolTitle(name),
				name,
				kind: toolKind(name),
				status: "in_progress",
			},
		};
	}

	if (event.type.startsWith("session.tool.progress")) {
		const callId = typeof data.callID === "string" ? data.callID : undefined;
		if (!callId) return undefined;
		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: callId,
				status: "in_progress",
				rawOutput: data.partial,
			},
		};
	}

	if (event.type.startsWith("session.tool.settled")) {
		const callId = typeof data.callID === "string" ? data.callID : undefined;
		if (!callId) return undefined;
		const part = (data.part && typeof data.part === "object" ? data.part : {}) as Record<string, unknown>;
		const statusStr = typeof part.status === "string" ? part.status : "completed";
		const isError = statusStr !== "completed";
		const name = typeof part.name === "string" ? part.name : "tool";
		const args = part.arguments;
		const content = toolContent(part.result);

		return {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: callId,
				title: toolTitle(name, args),
				name,
				kind: toolKind(name),
				status: isError ? "failed" : "completed",
				rawInput: args,
				rawOutput: part.result,
				...(content ? { content } : {}),
			},
		};
	}

	return undefined;
};

/**
 * Filter and transform an event stream into ACP updates.
 */
export const streamUpdates = <E>(stream: Stream.Stream<EventSchema.Payload, E>): Stream.Stream<SessionUpdateItem, E> =>
	stream.pipe(
		Stream.map(toSessionUpdate),
		Stream.filter((item): item is SessionUpdateItem => item !== undefined),
	);

export * as Feed from "./feed.ts";
