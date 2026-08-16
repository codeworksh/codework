import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import { Context } from "../src/context/context.ts";
import { Control } from "../src/control.ts";
import { Database } from "../src/db/db.ts";
import { SessionInputRow } from "../src/db/schema.sql.ts";
import { Event } from "../src/event/event.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxInstance } from "../src/sandbox/instance.ts";
import { AbsolutePath } from "../src/schema.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { testEffect } from "./utils/effect.ts";

const assistant = (
	input: LLM.Input,
	index: number,
	overrides: Partial<Message.AssistantMessage> = {},
): Message.AssistantMessage =>
	Message.createAssistantMessage({
		messageId: `assistant_${index}`,
		role: "assistant",
		protocol: "openai",
		provider: { id: input.provider, name: input.provider, source: "custom", env: [] },
		model: input.model,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		time: { created: index, completed: index },
		parts: [{ type: "text", text: `response ${index}` }],
		...overrides,
	});

const immediateOpen = (contexts: Message.Context[] = []): LLM.Open => {
	let responseIndex = 0;
	return (input) =>
		Effect.sync(() => {
			responseIndex += 1;
			contexts.push(input.context);
			const message = assistant(input, responseIndex);
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: message });
			events.push({ type: "text.start", partIndex: 0, partial: message });
			events.push({ type: "text.delta", partIndex: 0, delta: `response ${responseIndex}`, partial: message });
			events.push({ type: "text.end", partIndex: 0, content: `response ${responseIndex}`, partial: message });
			events.push({ type: "done", reason: "stop", message });
			return events;
		});
};

const runtime = (options: { readonly open?: LLM.Open; readonly contexts?: Message.Context[] } = {}) => {
	const database = Database.layer(":memory:");
	const request = LLM.make(options.open ?? immediateOpen(options.contexts));
	return Control.layer.pipe(
		Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(Loop.layer({ request })))),
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
		directory: AbsolutePath.make("/repo"),
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
		"does not promote an input twice; an explicit resume still performs one forced request",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_once", sessionId, delivery: "steer" });

			yield* execution.resume(sessionId);
			yield* execution.resume(sessionId);

			expect(yield* delivered(sessionId)).toEqual([{ id: "msg_once", promotedSeq: 1 }]);
			expect((yield* sessions.path(sessionId)).map((item) => item.entry.type)).toEqual([
				"user",
				"assistant",
				"assistant",
			]);
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
		"aborts aikit, durably projects its terminal failure, then propagates interruption",
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
			expect(JSON.parse(path[1]!.entry.data)).toMatchObject({ stopReason: "aborted" });
			expect(JSON.parse(path[1]!.parts[0]!.data)).toEqual({ type: "text", text: "partial" });
			expect(Array.from(yield* execution.active)).toEqual([]);
		}),
		{ timeout: 10_000 },
	);
});

describe("runner loop — provider failure", () => {
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			const failed = assistant(input, 1, {
				stopReason: "error",
				errorMessage: "provider failed",
				parts: [{ type: "text", text: "partial" }],
			});
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: failed });
			events.push({ type: "error", reason: "error", error: failed });
			return events;
		});
	const { effect: it } = testEffect(runtime({ open }));

	it(
		"commits the failed assistant before failing the turn",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_failed", sessionId, delivery: "steer" });

			const exit = yield* execution.resume(sessionId).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);

			const path = yield* sessions.path(sessionId);
			expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant"]);
			expect(JSON.parse(path[1]!.entry.data)).toMatchObject({
				stopReason: "error",
				errorMessage: "provider failed",
			});
		}),
	);
});
