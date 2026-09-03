import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Context } from "../src/context/context.ts";
import { Control } from "../src/control.ts";
import { Database } from "../src/db/db.ts";
import { SessionInputRow } from "../src/db/schema.sql.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import { State } from "../src/state/state.ts";
import * as Tool from "../src/tools/tool.ts";
import { assistant, immediateOpen } from "./fixtures/llm.ts";
import { testEffect } from "./utils/effect.ts";

const runtime = (
	options: { readonly open?: LLM.Open; readonly contexts?: Message.Context[]; readonly state?: State.Options } = {},
) => {
	const database = Database.layer(":memory:");
	const request = LLM.make(options.open ?? immediateOpen(options.contexts));
	const sandbox = SandboxController.layer().pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	return Control.layer.pipe(
		Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(Loop.layer({ request })))),
		Layer.provideMerge(State.layer(options.state)),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.layer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(database),
	);
};

const inputsFor = (sql: SqlClient.SqlClient) =>
	SqlSchema.findAll({
		Request: Schema.String,
		Result: SessionInputRow,
		execute: (sessionId) => sql`
			SELECT * FROM session_input WHERE session_id = ${sessionId} ORDER BY admitted_seq
		`,
	});

const delivered = Effect.fnUntraced(function* (sessionId: string) {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* inputsFor(sql)(sessionId);
	return rows.map((row) => ({ id: row.id, promotedSeq: Option.getOrNull(row.promotedSeq) }));
});

const seedSession = Effect.fnUntraced(function* (slug = "runner-loop") {
	const sql = yield* SqlClient.SqlClient;
	const sessions = yield* Session.Service;
	yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('p', 'p', 0, 0)`;
	const session = yield* sessions.create({
		projectId: "p",
		slug: `${slug}-${crypto.randomUUID()}`,
		directory: AbsolutePath.make(process.cwd()),
		title: "runner loop",
		sandboxInstanceId: SandboxInstance.ID.local,
	});
	return session.id;
});

const admit = Effect.fnUntraced(function* (input: {
	readonly id: string;
	readonly sessionId: SessionSchema.ID;
	readonly delivery: "steer" | "followUp";
	readonly text?: string;
}) {
	const inputs = yield* SessionInput.make;
	return yield* inputs.admit({
		id: SessionMessageSchema.ID.make(input.id),
		sessionId: input.sessionId,
		prompt: { text: input.text ?? input.id },
		delivery: input.delivery,
	});
});

describe("runner loop — aikit input/output", () => {
	const contexts: Message.Context[] = [];
	const { effect: it } = testEffect(runtime({ contexts }));

	it(
		"drains steers before follow-ups and persists each terminal assistant",
		Effect.gen(function* () {
			contexts.length = 0;
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();

			yield* admit({ id: "msg_follow", sessionId, delivery: "followUp" });
			yield* admit({ id: "msg_steer", sessionId, delivery: "steer" });
			yield* execution.resume(sessionId);

			const rows = yield* delivered(sessionId);
			const bySeq = [...rows].sort((left, right) => (left.promotedSeq ?? 0) - (right.promotedSeq ?? 0));
			expect(bySeq.map((row) => row.id)).toEqual(["msg_steer", "msg_follow"]);
			expect((yield* sessions.path(sessionId)).map((item) => item.entry.type)).toEqual([
				"user",
				"assistant",
				"user",
				"assistant",
			]);

			// Every request is rebuilt from durable history. The second request sees
			// the first terminal assistant and the newly promoted follow-up.
			expect(contexts.map((context) => context.messages.map((message) => message.role))).toEqual([
				["user"],
				["user", "assistant", "user"],
			]);
		}),
	);

	it(
		"does not promote an input twice and the leaf guard skips a settled reply",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_once", sessionId, delivery: "steer" });

			yield* execution.resume(sessionId);
			yield* execution.resume(sessionId);

			expect(yield* delivered(sessionId)).toEqual([{ id: "msg_once", promotedSeq: 1 }]);
			expect((yield* sessions.path(sessionId)).map((item) => item.entry.type)).toEqual(["user", "assistant"]);
		}),
	);

	it(
		"keeps promotion and output scoped per session",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const first = yield* seedSession("first");
			const second = yield* seedSession("second");
			yield* admit({ id: "msg_first", sessionId: first, delivery: "steer" });
			yield* admit({ id: "msg_second", sessionId: second, delivery: "steer" });

			yield* execution.resume(first);
			yield* execution.resume(second);

			expect(yield* delivered(first)).toEqual([{ id: "msg_first", promotedSeq: 1 }]);
			expect(yield* delivered(second)).toEqual([{ id: "msg_second", promotedSeq: 1 }]);
			expect((yield* sessions.path(first)).map((item) => item.entry.type)).toEqual(["user", "assistant"]);
			expect((yield* sessions.path(second)).map((item) => item.entry.type)).toEqual(["user", "assistant"]);
		}),
	);

	it(
		"promotes all current steers as one request, then follow-ups one per request",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_s1", sessionId, delivery: "steer" });
			yield* admit({ id: "msg_f1", sessionId, delivery: "followUp" });
			yield* admit({ id: "msg_s2", sessionId, delivery: "steer" });
			yield* admit({ id: "msg_f2", sessionId, delivery: "followUp" });
			yield* admit({ id: "msg_s3", sessionId, delivery: "steer" });

			yield* execution.resume(sessionId);

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual([
				"user",
				"user",
				"user",
				"assistant",
				"user",
				"assistant",
				"user",
				"assistant",
			]);
			expect(path.filter((item) => item.entry.type === "user").map((item) => item.entry.id)).toEqual([
				"msg_s1",
				"msg_s2",
				"msg_s3",
				"msg_f1",
				"msg_f2",
			]);
		}),
	);

	it(
		"fails for a session that does not exist",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const exit = yield* execution.resume(SessionSchema.ID.create()).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
		}),
	);

	it(
		"fails the SandboxIO infrastructure envelope before the loop can start",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sql = yield* SqlClient.SqlClient;
			yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('p', 'p', 0, 0)`;
			const session = yield* sessions.create({
				projectId: "p",
				slug: `missing-sandbox-cwd-${crypto.randomUUID()}`,
				directory: AbsolutePath.make(`/definitely-missing-${crypto.randomUUID()}`),
				title: "missing sandbox cwd",
				sandboxInstanceId: SandboxInstance.ID.local,
			});

			const exit = yield* execution.resume(session.id).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(failure) && failure.value._tag).toBe("Runner.SandboxDirectoryNotFoundError");
			}
			const durable = yield* sql`SELECT type FROM event WHERE aggregate_id = ${session.id}`;
			expect(durable).toEqual([]);
		}),
	);
});

describe("runner loop — tool continuation and lifecycle gate", () => {
	const contexts: Message.Context[] = [];
	let snapshots = 0;
	const echo = Tool.register(
		Tool.make({
			name: "echo",
			description: "echoes text",
			parameters: Schema.Struct({ value: Schema.String }),
			success: Schema.String,
			encodeContent: (value: string) => [{ type: "text", text: value }],
			handler: ({ value }) => Effect.succeed(value),
		}),
	);
	let responseIndex = 0;
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			responseIndex += 1;
			contexts.push(input.context);
			const message =
				responseIndex === 1
					? assistant(input, responseIndex, {
							stopReason: "toolUse",
							parts: [
								{
									type: "toolCall",
									callID: "call_echo",
									name: "echo",
									arguments: { value: "hello" },
									status: "pending",
									time: { start: 1, end: 1 },
								},
							],
						})
					: assistant(input, responseIndex);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({
				type: "done",
				reason: responseIndex === 1 ? "toolUse" : "stop",
				message,
			});
			return stream;
		});
	const { effect: it } = testEffect(
		runtime({
			open,
			state: {
				tools: [echo],
				promptSystemOverride: ({ systemPrompt }) => {
					snapshots += 1;
					return systemPrompt;
				},
			},
		}),
	);

	it(
		"continues after toolUse with no steer, pins state, and never moves the assistant seq",
		Effect.gen(function* () {
			contexts.length = 0;
			snapshots = 0;
			responseIndex = 0;
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* seedSession("tool-continuation");
			yield* admit({ id: "msg_tool", sessionId, delivery: "steer" });

			yield* execution.resume(sessionId);

			expect(contexts).toHaveLength(2);
			expect(snapshots).toBe(1);
			const firstTool = contexts[1]!.messages[1]!.parts.find((part) => part.type === "toolCall");
			expect(firstTool).toMatchObject({ callID: "call_echo", status: "completed" });

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => [item.entry.type, item.entry.state])).toEqual([
				["user", "committed"],
				["assistant", "committed"],
				["assistant", "committed"],
			]);
			const eventRows = (yield* sql`
				SELECT type, seq FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq
			`) as ReadonlyArray<{ readonly type: string; readonly seq: number }>;
			const firstStarted = eventRows.find((row) => row.type === "session.llm.started.1")!;
			const firstEnded = eventRows.find((row) => row.type === "session.llm.ended.1")!;
			expect(path[1]!.entry.seq).toBe(firstStarted.seq);
			expect(path[1]!.entry.seq).toBeLessThan(firstEnded.seq);
			expect(path.filter((item) => item.entry.id === "assistant_1")).toHaveLength(1);
		}),
	);
});

describe("runner loop — crash healing", () => {
	const contexts: Message.Context[] = [];
	let snapshots = 0;
	const { effect: it } = testEffect(
		runtime({
			contexts,
			state: {
				promptSystemOverride: ({ systemPrompt }) => {
					snapshots += 1;
					return systemPrompt;
				},
			},
		}),
	);

	it(
		"heals a dangling draft before eligibility, then idles without capturing state",
		Effect.gen(function* () {
			contexts.length = 0;
			snapshots = 0;
			const events = yield* Event.Service;
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession("heal");
			const input: LLM.Input = {
				sessionId,
				context: { messages: [] },
				provider: "openai",
				model: "gpt-5.5",
			};
			const draft = assistant(input, 99, { parts: [] });
			yield* events.publish(EventList.LLMStarted, {
				timestamp: DateTime.makeUnsafe(1),
				sessionId,
				messageId: SessionMessageSchema.ID.from(draft.messageId),
				message: draft,
			});

			yield* execution.wake(sessionId);
			while ((yield* execution.active).has(sessionId)) yield* Effect.yieldNow;

			const path = yield* sessions.path(sessionId);
			expect(path).toHaveLength(1);
			expect(path[0]!.entry.state).toBe("aborted");
			expect(path[0]!.parts).toEqual([]);
			expect(contexts).toEqual([]);
			expect(snapshots).toBe(0);
		}),
	);
});

describe("runner loop — tool interruption", () => {
	let toolGate: Deferred.Deferred<string> | undefined;
	const blocking = Tool.register(
		Tool.make({
			name: "blocking",
			description: "waits until interrupted",
			parameters: Schema.Struct({ id: Schema.String }),
			success: Schema.String,
			handler: () =>
				toolGate === undefined ? Effect.die("tool gate was not initialized") : Deferred.await(toolGate),
		}),
	);
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			const call = (id: string): Message.ToolCallPendingPart => ({
				type: "toolCall",
				callID: id,
				name: "blocking",
				arguments: { id },
				status: "pending",
				time: { start: 1, end: 1 },
			});
			const message = assistant(input, 1, {
				stopReason: "toolUse",
				parts: [call("call_a"), call("call_b")],
			});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "toolUse", message });
			return stream;
		});
	const { live: it } = testEffect(runtime({ open, state: { tools: [blocking], toolExecution: "parallel" } }));

	it(
		"settles every unfinished call as aborted and commits before rethrowing interrupt",
		Effect.gen(function* () {
			toolGate = yield* Deferred.make<string>();
			const execution = yield* RunnerExecution.Service;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* seedSession("tool-interrupt");
			yield* admit({ id: "msg_interrupt_tools", sessionId, delivery: "steer" });

			const bothStarted = yield* Deferred.make<void>();
			let started = 0;
			yield* events.listen((event) =>
				event.type === "session.tool.started"
					? Effect.sync(() => {
							started += 1;
							if (started === 2) Deferred.doneUnsafe(bothStarted, Effect.void);
						})
					: Effect.void,
			);

			const running = yield* execution.resume(sessionId).pipe(Effect.forkChild);
			yield* Deferred.await(bothStarted);
			yield* execution.interrupt(sessionId);
			const exit = yield* Fiber.await(running);
			expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);

			const path = yield* sessions.path(sessionId);
			expect(path[1]!.entry.state).toBe("committed");
			expect(path[1]!.parts.map((part) => Option.getOrThrow(part.status))).toEqual(["aborted", "aborted"]);
			for (const part of path[1]!.parts) {
				expect(JSON.parse(part.data)).toMatchObject({
					status: "aborted",
					result: { content: [{ type: "text", text: "Tool Execution Interrupted" }], isError: true },
				});
			}
			const durable = (yield* sql`
				SELECT type FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq
			`) as ReadonlyArray<{ readonly type: string }>;
			expect(durable.map((row) => row.type)).toContain("session.turn.ended.1");
			expect(durable.map((row) => row.type)).not.toContain("session.llm.failed.1");
		}),
		{ timeout: 10_000 },
	);
});

describe("runner loop — provider interruption", () => {
	let responseIndex = 0;
	const open: LLM.Open = (input, signal) =>
		Effect.sync(() => {
			responseIndex += 1;
			const partial = assistant(input, responseIndex, { parts: [{ type: "text", text: "partial" }] });
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial });
			events.push({ type: "text.delta", partIndex: 0, delta: "partial", partial });

			const fail = () => {
				const failed = assistant(input, responseIndex, {
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					parts: [{ type: "text", text: "partial" }],
				});
				events.push({ type: "error", reason: "aborted", error: failed });
			};
			if (signal.aborted) fail();
			else signal.addEventListener("abort", fail, { once: true });
			return events;
		});
	const { live: it } = testEffect(runtime({ open }));

	it(
		"aborts the whole draft as a partless tombstone, then propagates interruption",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_interrupted", sessionId, delivery: "steer" });

			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				event.type === "session.llm.text.delta"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);
			const waiting = yield* execution.resume(sessionId).pipe(Effect.forkChild);
			yield* Deferred.await(streaming);

			yield* execution.interrupt(sessionId);
			const exit = yield* Fiber.await(waiting);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant"]);
			expect(path[1]!.entry.state).toBe("aborted");
			expect(JSON.parse(path[1]!.entry.data)).toMatchObject({ stopReason: "aborted" });
			expect(path[1]!.parts).toEqual([]);
			expect(Array.from(yield* execution.active)).toEqual([]);
		}),
		{ timeout: 10_000 },
	);
});

describe("runner loop — provider failure", () => {
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			const failed = Object.assign(
				assistant(input, 1, {
					stopReason: "error",
					errorMessage: "provider failed",
					parts: [{ type: "text", text: "partial" }],
				}),
				{
					failure: {
						_tag: "Authentication",
						reason: "missing",
						message: "provider failed",
						retryable: false,
					} as const,
				},
			);
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: failed });
			events.push({ type: "error", reason: "error", error: failed });
			return events;
		});
	const { effect: it } = testEffect(runtime({ open }));

	it(
		"aborts a provider-failed assistant before failing the turn",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_failed", sessionId, delivery: "steer" });

			const exit = yield* execution.resume(sessionId).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(failure) && failure.value._tag).toBe("Runner.ProviderError");
				if (Option.isSome(failure) && failure.value._tag === "Runner.ProviderError") {
					expect(failure.value.reason._tag).toBe("Runner.ProviderAuthenticationError");
					expect(failure.value.message).toBe("openai/gpt-5.5: provider failed");
				}
			}

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant"]);
			expect(path[1]!.entry.state).toBe("aborted");
			expect(path[1]!.parts).toEqual([]);
			expect(JSON.parse(path[1]!.entry.data)).toMatchObject({
				stopReason: "error",
				errorMessage: "provider failed",
				failure: { _tag: "Authentication", reason: "missing", retryable: false },
			});
		}),
	);
});
