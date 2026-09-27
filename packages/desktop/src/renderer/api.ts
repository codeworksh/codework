import type { ChatMessage, LiveEvent, RepoRow, RepoState, SessionRow, Status } from "../bridge.ts";

export const DefaultUrl = "ws://127.0.0.1:7433/rpc";
export const UnlinkedRepo = "__unlinked__";
export type { ChatMessage, LiveEvent, RepoRow, RepoState, SessionRow, Status };

export const sessionsFor = (rows: ReadonlyArray<SessionRow>, repo: string | undefined): ReadonlyArray<SessionRow> => {
	if (repo === undefined) return [];
	if (repo === UnlinkedRepo) return rows.filter((row) => row.hostDir === undefined);
	return rows.filter((row) => row.hostDir === repo);
};

const replaceLast = (thread: ReadonlyArray<ChatMessage>, message: ChatMessage) => [...thread.slice(0, -1), message];

const mergeAssistant = (current: string, incoming: string): string => {
	if (incoming === "" || current === incoming) return current;
	if (current === "" || incoming.startsWith(current)) return incoming;
	return `${current}${incoming}`;
};

export const applyEvent = (thread: ReadonlyArray<ChatMessage>, event: LiveEvent): ReadonlyArray<ChatMessage> => {
	if (event.kind === "ended") return thread;
	if (event.kind === "delta") {
		const last = thread.at(-1);
		if (last?.role !== "assistant") {
			return [...thread, { id: event.sessionId, role: "assistant", content: event.delta }];
		}
		const content = mergeAssistant(last.content, event.delta);
		return content === last.content ? thread : replaceLast(thread, { ...last, content });
	}
	const next: ChatMessage = {
		id: event.id,
		role: event.kind === "user" ? "user" : "assistant",
		content: event.content,
	};
	const existing = thread.findIndex((message) => message.id === event.id);
	if (existing >= 0) {
		const current = thread[existing];
		if (current === undefined) return thread;
		const content = next.role === "assistant" ? mergeAssistant(current.content, next.content) : next.content;
		return thread.map((message, index) => (index === existing ? { ...next, content } : message));
	}
	if (event.kind === "user") {
		const lastUser = thread.findLast((message) => message.role === "user");
		if (lastUser?.content === event.content) {
			return thread.map((message) => (message.id === lastUser.id ? next : message));
		}
	}
	const last = thread.at(-1);
	if (event.kind === "assistant" && last?.role === "assistant") {
		const content = mergeAssistant(last.content, event.content);
		return content === last.content
			? replaceLast(thread, { ...last, id: event.id })
			: replaceLast(thread, { ...last, id: event.id, content });
	}
	return [...thread, next];
};
