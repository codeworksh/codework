// Helpers for MCP tests that run real turns against a scripted model.
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContextCodec } from "../../../src/context/codec.ts";
import type { Session } from "../../../src/effect/session.ts";
import { Event } from "../../../src/event/event.ts";
import { EventList } from "../../../src/event/list.ts";
import { toolSearchPlugin } from "../../../src/plugin/builtin/tool/toolsearch.ts";
import type { LLM } from "../../../src/runner/llm.ts";
import { assistant } from "../llm.ts";

const fixtures = fileURLToPath(new URL("./", import.meta.url));

/** A stdio server running `fixture` (by default the session fixture), with `extra` config and `env`. */
export const stdio = (
	extra: Record<string, unknown> = {},
	env: Record<string, string> = {},
	fixture = "session.mjs",
) => ({
	command: process.execPath,
	args: [join(fixtures, fixture)],
	env: { E2E_GREETING: "hello", ...env },
	...extra,
});

export const write = async (file: string, value: unknown) => {
	await fs.mkdir(join(file, ".."), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, 2));
};

/** `toolsearch` turns on by itself only with deferred tools; the entry after it keeps it on regardless. */
export const toolSearch = [toolSearchPlugin, { plugin: toolSearchPlugin.id, enabled: true }] as const;

/**
 * A scripted model: per thread, one reply per request, in order; an empty one ends the turn. Replies
 * are numbered after `answered`, the replies a thread got from a model in an earlier process.
 */
export const scripted = (answered = 0) => {
	const script = new Map<string, Array<ReadonlyArray<Message.ToolCallPendingPart>>>();
	const requests: Array<LLM.Input> = [];
	let responses = answered;
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			requests.push(input);
			const calls = script.get(input.threadId)?.shift() ?? [];
			responses += 1;
			const message = assistant(
				input,
				responses,
				calls.length > 0 ? { stopReason: "toolUse", parts: [...calls] } : {},
			);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: calls.length > 0 ? "toolUse" : "stop", message });
			return stream;
		});
	/** Queue a turn on a thread: tool calls for each request, then a closing reply. */
	const turn = (threadId: string, ...requests: ReadonlyArray<ReadonlyArray<Message.ToolCallPendingPart>>) => {
		const queue = script.get(threadId) ?? [];
		queue.push(...requests, []);
		script.set(threadId, queue);
	};
	/** Drop what is left of a thread's script, as an interrupted turn leaves it. */
	const clear = (threadId: string) => script.delete(threadId);
	/** The tools the model was declared in its latest request. */
	const declared = () => (requests.at(-1)?.context.tools ?? []).map((tool) => tool.name);
	return { open, turn, clear, requests, declared };
};

/** Threads and servers connect concurrently; their keys are sorted so the artifact does not depend on it. */
export const byName = <A>(record: Record<string, A>) =>
	Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Every `mcp.server.status` event, by thread label and server, in order; `read` takes a copy. */
export const statusEvents = (label: (threadId: string) => string) =>
	Effect.gen(function* () {
		const seen: Record<string, Record<string, Array<EventList.McpServerState>>> = {};
		const events = yield* Event.Service;
		yield* events.listen((event) =>
			Effect.sync(() => {
				if (event.type !== EventList.McpServerStatus.type) return;
				const { threadId, status } = (event as unknown as EventList.McpServerStatus).data;
				const byServer = (seen[label(threadId)] ??= {});
				(byServer[status.server] ??= []).push(status);
			}),
		);
		return {
			read: () =>
				byName(Object.fromEntries(Object.entries(seen).map(([thread, servers]) => [thread, byName(servers)]))),
		};
	});

/** The text of each settled tool call of a thread, by call id. */
export const results = (thread: Session.ThreadHandle) =>
	Effect.gen(function* () {
		const line = yield* thread.history();
		const out: Record<string, string> = {};
		for (const hydrated of line) {
			if (hydrated.entry.type !== "assistant") continue;
			const message = yield* ContextCodec.decodeMessage(hydrated);
			if (message.role !== "assistant") continue;
			for (const part of message.parts)
				if (part.type === "toolCall" && "result" in part)
					out[part.callID] = part.result.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("");
		}
		return out;
	});

/** Tool changes the transcript declared, as names. */
export const changes = (messages: ReadonlyArray<Message.Message>) =>
	messages.flatMap((message) =>
		message.role === "system"
			? [
					{
						added: (message.toolsAdded ?? []).map((tool) => tool.name),
						removed: (message.toolsRemoved ?? []).map((tool) => tool.name),
					},
				]
			: [],
	);

/** Polls `read` every 20 ms, for up to 5 s, until `done`; returns the last value either way. */
export const waitFor = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
	Effect.gen(function* () {
		for (let tries = 0; tries < 250; tries++) {
			const value = yield* read;
			if (done(value)) return value;
			yield* Effect.sleep("20 millis");
		}
		return yield* read;
	});

export const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/** The pids an `E2E_STARTS` file recorded, one per start. */
export const startedPids = (file: string) =>
	fs
		.readFile(file, "utf8")
		.catch(() => "")
		.then((text) => text.split("\n").filter(Boolean).map(Number));

/** How long `self` took, in milliseconds. */
export const elapsed = <A, E, R>(self: Effect.Effect<A, E, R>) =>
	Effect.gen(function* () {
		const start = Date.now();
		yield* self;
		return Date.now() - start;
	});
