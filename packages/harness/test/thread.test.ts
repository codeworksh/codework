import "./utils/env.ts";
import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Cause, DateTime, Deferred, Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Context } from "../src/context/context.ts";
import { Control } from "../src/control.ts";
import { Database } from "../src/db/db.ts";
import { Document } from "../src/document/document.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { EventRegistry } from "../src/event/registry.ts";
import { Global } from "../src/global.ts";
import { builtins } from "../src/plugin/builtin.ts";
import type { Plugin } from "../src/plugin/plugin.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { Hooks } from "../src/runner/hooks.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { Settings } from "../src/settings/settings.ts";
import { State } from "../src/state/state.ts";
import { ThreadSchema } from "../src/thread/schema.ts";
import { Thread } from "../src/thread/thread.ts";
import * as Tool from "../src/tool/tool.ts";
import { assistant } from "./fixtures/llm.ts";
import { pooled } from "./fixtures/pool.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

/** What the model is asked to do next, per thread: reply, call `find`, or wait on a gate. */
type Step =
	| { readonly _tag: "reply"; readonly text: string }
	| { readonly _tag: "find" }
	| { readonly _tag: "gate"; readonly gate: Deferred.Deferred<void>; readonly opened: Deferred.Deferred<void> };

const script = new Map<string, Array<Step>>();
const contexts: Array<{ readonly threadId: string; readonly roles: ReadonlyArray<string>; readonly texts: string }> =
	[];
let responses = 0;

const textOf = (message: Message.Context["messages"][number]) =>
	"parts" in message ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") : "";

const open: LLM.Open = (input, signal) =>
	Effect.gen(function* () {
		const step = script.get(input.threadId)?.shift() ?? { _tag: "reply", text: "ok" };
		contexts.push({
			threadId: input.threadId,
			roles: input.context.messages.map((message) => message.role),
			texts: input.context.messages.map(textOf).join(" | "),
		});
		responses += 1;
		const message =
			step._tag === "find"
				? assistant(input, responses, {
						messageId: `assistant_${responses}`,
						stopReason: "toolUse",
						parts: [
							{
								type: "toolCall",
								callID: "call_find",
								name: "find_tool",
								arguments: { name: "web_fetch" },
								status: "pending",
								time: { start: 1, end: 1 },
							},
						],
					})
				: assistant(input, responses, {
						messageId: `assistant_${responses}`,
						parts: [{ type: "text", text: step._tag === "reply" ? step.text : "released" }],
					});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		const done = Effect.sync(() =>
			stream.push({ type: "done", reason: step._tag === "find" ? "toolUse" : "stop", message }),
		);
		if (step._tag !== "gate") yield* done;
		else {
			// Held after `start`, so the turn's draft is open while the gate is shut; a stop aborts it.
			yield* Effect.forkDetach(Deferred.await(step.gate).pipe(Effect.andThen(done)));
			const abort = () =>
				stream.push({ type: "error", reason: "aborted", error: { ...message, stopReason: "aborted", parts: [] } });
			signal.addEventListener("abort", abort, { once: true });
		}
		if (step._tag === "gate") yield* Deferred.succeed(step.opened, undefined);
		return stream;
	});

// Stands in for `tool_search`: it changes the calling thread's `agent` inside its turn.
let configureFromTool: ((name: string) => Effect.Effect<void>) | undefined;
const findTool: Plugin = {
	id: "test.tool.find",
	kind: "tool",
	setup: (ctx) => {
		const sessionId = ctx.sessionId;
		const threadId = ctx.threadId;
		ctx.plugin.tools.add(
			Tool.register(
				Tool.make({
					name: "find_tool",
					description: "offers a deferred tool",
					parameters: Schema.Struct({ name: Schema.String }),
					success: Schema.String,
					handler: ({ name }) => (configureFromTool?.(name) ?? Effect.void).pipe(Effect.as(`found ${name}`)),
				}),
			),
		);
		active = { sessionId, threadId };
	},
};
let active: { readonly sessionId: SessionSchema.ID; readonly threadId: ThreadSchema.ID } | undefined;

const layer = () => {
	const database = Database.layer(":memory:");
	const sandbox = SandboxController.layer({ hostCwd: "/" }).pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	const seeded = pooled([...builtins, findTool]);
	return Control.layer.pipe(
		Layer.provideMerge(
			RunnerExecute.layer.pipe(Layer.provide(Loop.layer({ request: LLM.make(open) }).pipe(Layer.provide(Hooks.layer)))),
		),
		Layer.provideMerge(State.layer({}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild)),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(Layer.succeed(Settings.Service, { load: () => Effect.succeed(Settings.defaults) })),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.storeLayer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
	);
};

const { effect: it } = testEffect(layer());

const reset = Effect.sync(() => {
	script.clear();
	contexts.length = 0;
	responses = 0;
	configureFromTool = undefined;
	active = undefined;
});

const createSession = Effect.gen(function* () {
	const sessions = yield* Session.Service;
	const { spaceId, location } = yield* seedSpace({ location: process.cwd(), projectId: "p" });
	const { session, thread } = yield* sessions.create({ spaceId, directory: location });
	return { sessionId: SessionSchema.ID.make(session.id), main: ThreadSchema.ID.make(thread.id) };
});

const configure = (sessionId: SessionSchema.ID, threadId: ThreadSchema.ID, change: EventList.ThreadConfigured["data"]["change"]) =>
	Effect.gen(function* () {
		const events = yield* Event.Service;
		yield* events.publish(EventList.ThreadConfigured, { timestamp: yield* DateTime.now, sessionId, threadId, change });
	});

const run = (sessionId: SessionSchema.ID, threadId: ThreadSchema.ID, text: string) =>
	Effect.gen(function* () {
		const control = yield* Control.Service;
		return yield* control.run({ sessionId, threadId, prompt: PromptSchema.Prompt.fromText(text), delivery: "followUp" });
	});

/** Ids in the order first seen, so artifacts read `T1`, `E3` rather than uuids. */
const aliases = () => {
	const names = new Map<string, string>();
	const counters = new Map<string, number>();
	return (prefix: string, id: string) => {
		const known = names.get(id);
		if (known !== undefined) return known;
		const next = (counters.get(prefix) ?? 0) + 1;
		counters.set(prefix, next);
		const name = `${prefix}${next}`;
		names.set(id, name);
		return name;
	};
};

const snapshot = Effect.fnUntraced(function* (sessionId: SessionSchema.ID) {
	const sql = yield* SqlClient.SqlClient;
	const name = aliases();
	const threads = yield* sql<{
		id: string;
		originKind: string;
		originThreadId: string | null;
		originEntryId: string | null;
		createdSeq: number;
		title: string | null;
	}>`SELECT * FROM thread WHERE session_id = ${sessionId} ORDER BY created_seq`;
	for (const thread of threads) name("T", thread.id);
	const entries = yield* sql<{
		id: string;
		threadId: string;
		seq: number;
		committedSeq: number | null;
		type: string;
		state: string;
	}>`SELECT * FROM entry WHERE session_id = ${sessionId} ORDER BY seq`;
	for (const entry of entries) name("E", entry.id);
	const documents = yield* sql<{ id: string; threadId: string; kind: string; createdSeq: number }>`
		SELECT * FROM document WHERE session_id = ${sessionId} ORDER BY created_seq
	`;
	const log = yield* sql<{ seq: number; type: string; data: string }>`
		SELECT seq, type, data FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq
	`;
	return {
		events: log.map((event) => {
			const data = JSON.parse(event.data) as { readonly threadId?: string };
			return `${event.seq} ${event.type}${data.threadId === undefined ? "" : ` ${name("T", data.threadId)}`}`;
		}),
		threads: threads.map((thread) => ({
			thread: name("T", thread.id),
			origin:
				thread.originKind === "main"
					? "main"
					: `${thread.originKind} ${name("T", thread.originThreadId!)} at ${name("E", thread.originEntryId!)}`,
			createdSeq: thread.createdSeq,
			title: thread.title,
		})),
		entries: entries.map(
			(entry) =>
				`${name("E", entry.id)} ${name("T", entry.threadId)} ${entry.type} seq=${entry.seq} committed=${entry.committedSeq} ${entry.state}`,
		),
		documents: yield* Effect.forEach(documents, (document) =>
			Effect.gen(function* () {
				const revisions = yield* sql<{ seq: number; value: string }>`
					SELECT seq, value FROM revision WHERE document_id = ${document.id} ORDER BY seq
				`;
				return {
					thread: name("T", document.threadId),
					kind: document.kind,
					revisions: revisions.map((revision) => `${revision.seq} ${revision.value}`),
				};
			}),
		),
	};
});

const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
	Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

const artifact = (name: string, value: unknown) =>
	Effect.promise(() => expect(`${JSON.stringify(value, null, "\t")}\n`).toMatchFileSnapshot(`./__artifacts__/${name}`));

describe("threads", () => {
	it(
		"walkthrough: a fork cuts at the committed seq and copies agent as of the cut",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const documents = yield* Document.Service;
			const { sessionId, main } = yield* createSession;

			yield* configure(sessionId, main, { model: { provider: "openai", id: "gpt-5.4" } });
			const events = yield* Event.Service;
			configureFromTool = (name) =>
				Effect.gen(function* () {
					const current = yield* documents.agent(active!.threadId);
					yield* events.publish(EventList.ThreadConfigured, {
						timestamp: yield* DateTime.now,
						sessionId: active!.sessionId,
						threadId: active!.threadId,
						change: { modelTools: { add: [...(current.modelTools?.add ?? []), name] } },
					});
				});
			script.set(main, [{ _tag: "find" }, { _tag: "reply", text: "login added" }, { _tag: "reply", text: "tests added" }]);
			yield* run(sessionId, main, "Add login");
			yield* run(sessionId, main, "Now add tests");

			const line = yield* threads.line(main);
			expect(line.map(({ entry }) => entry.type)).toEqual(["user", "assistant", "assistant", "user", "assistant"]);
			const [, e2, e3] = line;
			const forked = yield* threads.fork({ threadId: main, entryId: e3!.entry.id });
			const t2 = ThreadSchema.ID.make(forked.thread.id);

			// The fork's agent is the source's as of E3's commit: gpt, with the tool found during E2.
			expect(yield* documents.agent(t2)).toEqual({
				model: { provider: "openai", id: "gpt-5.4" },
				modelTools: { add: ["web_fetch"] },
			});
			// What E2's request was built with: gpt, no tool yet.
			expect(yield* documents.agentAsOf(main, e2!.entry.seq)).toEqual({
				model: { provider: "openai", id: "gpt-5.4" },
			});

			script.set(t2, [{ _tag: "reply", text: "oauth it is" }]);
			yield* run(sessionId, t2, "Use OAuth instead");
			yield* configure(sessionId, t2, { model: { provider: "anthropic", id: "claude-sonnet-4-5" } });
			expect((yield* documents.agent(t2)).model?.provider).toBe("anthropic");
			expect((yield* documents.agent(main)).model?.provider).toBe("openai");

			// Forking at E2 cuts at its commit, after the tool's change.
			const atE2 = yield* threads.fork({ threadId: main, entryId: e2!.entry.id });
			expect((yield* documents.agent(ThreadSchema.ID.make(atE2.thread.id))).modelTools).toEqual({
				add: ["web_fetch"],
			});

			// T2 sees T1 through E3, then its own prompt; T1's later entries are not its history.
			const t2Context = contexts.filter((one) => one.threadId === t2).at(-1)!;
			expect(t2Context.texts.includes("Now add tests")).toBe(false);
			yield* artifact("thread.walkthrough.json", {
				...(yield* snapshot(sessionId)),
				t2Context: t2Context.roles,
			});
		}),
	);

	it(
		"fork rules: refuses drafts and aborted entries, re-points inherited origins, and before()",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const control = yield* Control.Service;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "first");
			yield* run(sessionId, main, "second");
			const [e1, e2, e3, e4] = yield* threads.line(main);

			// An inherited entry re-points the origin to the thread that wrote it.
			const t2 = ThreadSchema.ID.make((yield* threads.fork({ threadId: main, entryId: e4!.entry.id })).thread.id);
			const fromInherited = yield* threads.fork({ threadId: t2, entryId: e1!.entry.id });
			expect(fromInherited.thread.originThreadId).toEqual(Option.some(main));

			// before(): stops at the predecessor and hands back the prompt to edit.
			const before = yield* threads.fork({ threadId: main, entryId: e3!.entry.id, mode: "before" });
			expect(before.thread.originEntryId).toEqual(Option.some(e2!.entry.id));
			expect(before.text).toBe("second");
			const firstOfMain = yield* threads.fork({ threadId: main, entryId: e1!.entry.id, mode: "before" }).pipe(Effect.exit);
			const notUser = yield* threads.fork({ threadId: main, entryId: e4!.entry.id, mode: "before" }).pipe(Effect.exit);
			const elsewhere = yield* threads.fork({ threadId: main, entryId: "missing" }).pipe(Effect.exit);

			// A draft is still changing: no fork of in-flight state.
			const gate = yield* Deferred.make<void>();
			const opened = yield* Deferred.make<void>();
			script.set(main, [{ _tag: "gate", gate, opened }]);
			yield* control.prompt({ sessionId, threadId: main, prompt: PromptSchema.Prompt.fromText("third") });
			yield* Deferred.await(opened);
			const draft = yield* threads.draft(main).pipe(
				Effect.tap(() => Effect.yieldNow),
				Effect.repeat({ until: Option.isSome }),
				Effect.map(Option.getOrThrow),
			);
			const atDraft = yield* threads.fork({ threadId: main, entryId: draft.entry.id }).pipe(Effect.exit);

			// An interrupted draft is aborted: not part of the context, so not a fork point either.
			yield* control.interrupt(main, { awaitSettlement: true });
			const aborted = yield* threads.entry(draft.entry.id).pipe(Effect.map(Option.getOrThrow));
			const atAborted = yield* threads.fork({ threadId: main, entryId: draft.entry.id }).pipe(Effect.exit);

			const reasons = [firstOfMain, notUser, elsewhere, atDraft, atAborted].map(
				(exit) => (failureOf(exit) as Thread.ForkError | undefined)?.reason,
			);
			expect(reasons).toEqual([
				"nothing_before_entry",
				"not_a_user_entry",
				"entry_not_found",
				"entry_not_committed",
				"entry_not_committed",
			]);
			expect(aborted.entry.state).toBe("aborted");
			yield* artifact("thread.fork.json", { reasons, ...(yield* snapshot(sessionId)) });
		}),
	);

	it(
		"two threads of one session run at the same time",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "base");
			const [first] = yield* threads.line(main);
			const t2 = ThreadSchema.ID.make((yield* threads.fork({ threadId: main, entryId: first!.entry.id })).thread.id);

			const gates = yield* Effect.forEach([main, t2], (threadId, index) =>
				Effect.gen(function* () {
					const gate = yield* Deferred.make<void>();
					const opened = yield* Deferred.make<void>();
					script.set(threadId, [{ _tag: "gate", gate, opened }]);
					yield* control.prompt({ sessionId, threadId, prompt: PromptSchema.Prompt.fromText(`go ${index + 1}`) });
					return { gate, opened };
				}),
			);
			// Both requests are open at once: neither thread waits on the other.
			yield* Effect.forEach(gates, ({ opened }) => Deferred.await(opened));
			const both = yield* execution.active;
			expect(both.has(main) && both.has(t2)).toBe(true);
			yield* Effect.forEach(gates, ({ gate }) => Deferred.succeed(gate, undefined));
			yield* Effect.forEach([main, t2], (threadId) => control.wait(threadId));

			const own = (threadId: ThreadSchema.ID) =>
				threads.line(threadId).pipe(
					Effect.map((line) =>
						line
							.filter(({ entry }) => entry.threadId === threadId)
							.map(({ entry }) => `${entry.type} ${entry.state}`),
					),
				);
			const result = { bothActive: true, main: yield* own(main), fork: yield* own(t2) };
			expect(result.main).toEqual(["user committed", "assistant committed", "user committed", "assistant committed"]);
			expect(result.fork).toEqual(["user committed", "assistant committed"]);
			// Seqs interleave between the two runs, so the artifact holds per-thread facts only.
			yield* artifact("thread.concurrent.json", result);
		}),
	);

	it(
		"a reset starts the context over, carrying its handoff",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const events = yield* Event.Service;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "before the reset");
			// No reset event exists yet; the entry is written at a seq of its own, as an event would.
			const seq = (yield* events.latestSequence(sessionId)) + 1;
			yield* events.advance(sessionId, seq);
			yield* threads.append({
				id: "reset_1",
				threadId: main,
				seq,
				type: "reset",
				data: JSON.stringify({ handoff: "keep the login work" }),
			});
			yield* run(sessionId, main, "after the reset");
			const last = contexts.at(-1)!;
			expect(last.roles).toEqual(["user", "user"]);
			expect(last.texts.includes("before the reset")).toBe(false);
			expect(last.texts.includes("keep the login work")).toBe(true);
			yield* artifact("thread.reset.json", { context: { roles: last.roles, texts: last.texts }, ...(yield* snapshot(sessionId)) });
		}),
	);

	it(
		"recovery fails a thread's open draft as interrupted and answers again",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const control = yield* Control.Service;
			const events = yield* Event.Service;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "base");
			const [first] = yield* threads.line(main);
			const t2 = ThreadSchema.ID.make((yield* threads.fork({ threadId: main, entryId: first!.entry.id })).thread.id);

			// What a process dying mid-turn leaves: a promoted prompt, an open draft, the run still marked.
			const timestamp = yield* DateTime.now;
			const prompt = PromptSchema.Prompt.fromText("cut off");
			const messageId = SessionMessageSchema.ID.make("prompt_cut");
			const base = { timestamp, sessionId, threadId: t2, messageId, prompt, delivery: "followUp" as const };
			yield* events.publish(EventList.PromptAdmitted, base);
			yield* events.publish(EventList.Prompted, base);
			yield* events.publish(EventList.LLMStarted, {
				timestamp,
				sessionId,
				threadId: t2,
				messageId: SessionMessageSchema.ID.make("dangling"),
				message: Message.createAssistantMessage({
					messageId: "dangling",
					role: "assistant",
					protocol: "openai",
					provider: { id: "test", name: "test", source: "custom", env: [] },
					model: "test",
					thinkingLevel: "off",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					time: { created: 0, completed: 0 },
					parts: [{ type: "text", text: "half a rep" }],
				}),
			});
			yield* threads.markRunning(t2);

			script.set(t2, [{ _tag: "reply", text: "answered again" }]);
			yield* control.resumeUnfinished;

			const own = (yield* threads.line(t2))
				.filter(({ entry }) => entry.threadId === t2)
				.map(({ entry }) => `${entry.type} ${entry.state}`);
			expect(own).toEqual(["user committed", "assistant aborted", "assistant committed"]);
			const thread = Option.getOrThrow(yield* threads.get(t2));
			expect(Option.getOrUndefined(thread.execution)).toBeUndefined();
			expect(thread.restarts).toBe(0);
			// Only the thread that was cut off ran again, from its committed entries: the inherited
			// prompt and its own, without the aborted draft.
			expect(contexts.filter((one) => one.threadId === main)).toHaveLength(1);
			expect(contexts.at(-1)!.roles).toEqual(["user", "user"]);
			yield* artifact("thread.recovery.json", yield* snapshot(sessionId));
		}),
	);

	it(
		"constraints refuse a second main, two entries per thread per event, two revisions per document per event",
		Effect.gen(function* () {
			yield* reset;
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, main } = yield* createSession;
			yield* run(sessionId, main, "hello");
			const entry = (yield* sql<{ seq: number; sessionId: string }>`SELECT * FROM entry WHERE thread_id = ${main}`)[0]!;
			const document = (yield* sql<{ id: string }>`SELECT id FROM document WHERE thread_id = ${main}`)[0]!;
			const refused = (statement: Effect.Effect<unknown, unknown>) =>
				statement.pipe(
					Effect.exit,
					Effect.map((exit) =>
						Exit.isFailure(exit)
							? (/constraint failed[^\n]*/.exec(Cause.pretty(exit.cause))?.[0] ?? Cause.pretty(exit.cause))
							: "accepted",
					),
				);
			const results = {
				secondMain: yield* refused(sql`
					INSERT INTO thread (id, session_id, origin_kind, created_seq, created_at, updated_at)
					VALUES ('thr_second', ${sessionId}, 'main', 99, 0, 0)
				`),
				twoEntriesOneEvent: yield* refused(sql`
					INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, created_at, updated_at)
					VALUES ('entry_twin', ${sessionId}, ${main}, ${entry.seq}, ${entry.seq}, 'custom', 'committed', '{}', 0, 0)
				`),
				twoRevisionsOneEvent: yield* refused(sql`
					INSERT INTO revision (document_id, seq, version, value) VALUES (${document.id}, 1, 1, '{}')
				`),
				draftWithCommit: yield* refused(sql`
					INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, created_at, updated_at)
					VALUES ('entry_draft', ${sessionId}, ${main}, 500, 500, 'assistant', 'draft', '{}', 0, 0)
				`),
				forkWithoutCut: yield* refused(sql`
					INSERT INTO thread (id, session_id, origin_kind, origin_thread_id, created_seq, created_at, updated_at)
					VALUES ('thr_nocut', ${sessionId}, 'fork', ${main}, 99, 0, 0)
				`),
			};
			expect(Object.values(results).every((result) => result.includes("constraint failed"))).toBe(true);
			yield* artifact("thread.constraints.json", results);
		}),
	);
});
