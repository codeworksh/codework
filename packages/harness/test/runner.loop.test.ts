import "./utils/env.ts";
import type { Plugin } from "../src/plugin/plugin.ts";
import { Global } from "../src/global.ts";
import { builtins as plugins } from "../src/plugin/builtin.ts";
import type { Info } from "../src/settings/schema.ts";
import { Settings } from "../src/settings/settings.ts";
import { createAssistantMessageEventStream, Message } from "@codeworksh/aikit";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";
import { describe, expect } from "vite-plus/test";
import { Context } from "../src/context/context.ts";
import { Control } from "../src/control.ts";
import { Session as SessionApi } from "../src/effect/session.ts";
import { Database } from "../src/db/db.ts";
import { SessionInputRow } from "../src/db/schema.sql.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { EventRegistry } from "../src/event/registry.ts";
import type { EventSchema } from "../src/event/schema.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { SessionInput } from "../src/session/input/input.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { Session } from "../src/session/session.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import { State } from "../src/state/state.ts";
import { pooled } from "./fixtures/pool.ts";
import * as Tool from "../src/tool/tool.ts";
import { assistant, immediateOpen } from "./fixtures/llm.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

const runtime = (
	options: {
		readonly open?: LLM.Open;
		readonly contexts?: Message.Context[];
		readonly state?: State.Options;
		readonly plugins?: ReadonlyArray<Plugin>;
		readonly settings?: Info;
		/** Runs as each turn's snapshot loads settings: after the loop checks for pending input, before it promotes. */
		readonly beforeSettings?: { run: Effect.Effect<void> };
	} = {},
) => {
	const database = Database.layer(":memory:");
	const request = LLM.make(options.open ?? immediateOpen(options.contexts));
	const sandbox = SandboxController.layer({ hostCwd: "/" }).pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	return Control.layer.pipe(
		Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(Loop.layer({ request })))),
		Layer.provideMerge(
			((seeded) => State.layer(options.state ?? {}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild))(
				pooled(options.plugins ?? plugins),
			),
		),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(
			Layer.succeed(Settings.Service, {
				load: () =>
					Effect.suspend(() => options.beforeSettings?.run ?? Effect.void).pipe(
						Effect.as(options.settings ?? Settings.defaults),
					),
			}),
		),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.layer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
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

const seedSession = Effect.fnUntraced(function* () {
	const sessions = yield* Session.Service;
	const { spaceId, location } = yield* seedSpace({ location: process.cwd(), projectId: "p" });
	const session = yield* sessions.create({
		spaceId,
		directory: location,
		title: "runner loop",
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
		prompt: { parts: [{ type: "text", text: input.text ?? input.id }] },
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
		"fails the SandboxIO infrastructure envelope before the loop can start",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const sessions = yield* Session.Service;
			const sql = yield* SqlClient.SqlClient;
			// The space row records where the directory was; the mount finds it gone.
			const { spaceId, location } = yield* seedSpace({
				location: `/definitely-missing-${crypto.randomUUID()}`,
				projectId: "p",
			});
			const session = yield* sessions.create({
				spaceId,
				directory: location,
				title: "missing sandbox cwd",
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
			plugins: [
				...plugins,
				{
					id: "test.tool.echo",
					kind: "tool",
					setup: (ctx) => {
						snapshots += 1;
						ctx.plugin.tools.add(echo);
					},
				},
			],
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
			const sessionId = yield* seedSession();
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
			plugins: [
				...plugins,
				{
					id: "test.prompt.count",
					kind: "prompt",
					setup: () => {
						snapshots += 1;
					},
				},
			],
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
			const sessionId = yield* seedSession();
			const input: LLM.Input = {
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
				sessionId,
				context: { messages: [] },
				provider: "openai",
				model: "gpt-6-luna",
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
	const { live: it } = testEffect(
		runtime({
			open,
			state: { toolExecution: "parallel" },
			plugins: [
				...plugins,
				{ id: "test.tool.blocking", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(blocking) },
			],
		}),
	);

	it(
		"settles every unfinished call as aborted and commits before rethrowing interrupt",
		Effect.gen(function* () {
			toolGate = yield* Deferred.make<string>();
			const execution = yield* RunnerExecution.Service;
			const events = yield* Event.Service;
			const sessions = yield* Session.Service;
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* seedSession();
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
			const lifecycle: EventSchema.Payload[] = [];
			yield* events.listen((event) =>
				Effect.sync(() => {
					if (event.type === EventList.ExecutionInterrupted.type) lifecycle.push(event);
				}),
			);
			yield* execution.interrupt(sessionId, "user", { awaitSettlement: true });
			const exit = yield* Fiber.await(running);
			expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
			// The reason is the caller's, not something inferred from the cause.
			const interrupted = lifecycle[0];
			expect(interrupted).toBeDefined();
			if (interrupted !== undefined && Schema.is(EventList.ExecutionInterrupted)(interrupted))
				expect(interrupted.data.reason).toBe("user");

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
					expect(failure.value.message).toBe(
						`${Settings.defaults.model.provider}/${Settings.defaults.model.id}: provider failed`,
					);
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

	it(
		"publishes the busy period as started then failed, with the failure's category",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const events = yield* Event.Service;
			const lifecycle: EventSchema.Payload[] = [];
			yield* events.listen((event) =>
				Effect.sync(() => {
					if (event.type.startsWith("session.execution.")) lifecycle.push(event);
				}),
			);
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_failed_lifecycle", sessionId, delivery: "steer" });

			yield* execution.resume(sessionId).pipe(Effect.exit);

			expect(lifecycle.map((event) => event.type)).toEqual([
				EventList.ExecutionStarted.type,
				EventList.ExecutionFailed.type,
			]);
			const failed = lifecycle[1]!;
			expect(Schema.is(EventList.ExecutionFailed)(failed)).toBe(true);
			if (Schema.is(EventList.ExecutionFailed)(failed)) {
				expect(failed.data.error.type).toBe("provider-authentication-error");
				expect(failed.data.error.message).toContain("provider failed");
			}
		}),
	);
});

describe("runner loop — retry", () => {
	type Failure = { readonly _tag: string; readonly retryable: boolean; readonly retryAfterMs?: number };

	/** Each call takes the next script entry: a failure (optionally after streaming text), else success. */
	const scripted = (
		script: ReadonlyArray<{ readonly failure: Failure; readonly streamed?: string } | "ok">,
		contexts: Message.Context[] = [],
	): LLM.Open => {
		let index = 0;
		return (input) =>
			Effect.sync(() => {
				index += 1;
				contexts.push(structuredClone(input.context));
				const step = script[index - 1] ?? "ok";
				const events = createAssistantMessageEventStream();
				if (step === "ok") {
					const message = assistant(input, index);
					events.push({ type: "start", partial: message });
					events.push({ type: "done", reason: "stop", message });
					return events;
				}
				const failed = Object.assign(
					assistant(input, index, {
						stopReason: "error",
						errorMessage: `${step.failure._tag} failure`,
						parts: step.streamed === undefined ? [] : [{ type: "text", text: step.streamed }],
					}),
					{ failure: { ...step.failure, message: `${step.failure._tag} failure` } },
				);
				events.push({ type: "start", partial: failed });
				if (step.streamed !== undefined) {
					events.push({ type: "text.delta", partIndex: 0, delta: step.streamed, partial: failed });
				}
				events.push({ type: "error", reason: "error", error: failed });
				return events;
			});
	};

	const settings = (retry: Partial<Info["retry"]>): Info => ({
		...Settings.defaults,
		retry: { ...Settings.defaults.retry, ...retry },
	});

	/** The turn's lifecycle as a client sees it, without timestamps or ids. */
	const journal = Effect.fnUntraced(function* () {
		const events = yield* Event.Service;
		const seen: Array<Record<string, unknown>> = [];
		yield* events.listen((event) =>
			Effect.sync(() => {
				if (!event.type.startsWith("session.")) return;
				if (event.type.startsWith("session.prompt.") || event.type.startsWith("session.execution.")) return;
				const data = event.data as Record<string, unknown>;
				const picked = Object.fromEntries(
					["messageId", "attempt", "maxRetries", "delayMs", "success", "reason", "cause", "message"]
						.filter((key) => data[key] !== undefined && (key !== "message" || typeof data[key] === "string"))
						.map((key) => [key, data[key]]),
				);
				seen.push({ type: event.type, ...picked });
			}),
		);
		return seen;
	});

	const pathOf = Effect.fnUntraced(function* (sessionId: SessionSchema.ID) {
		const sessions = yield* Session.Service;
		return (yield* sessions.path(sessionId)).map((item) => ({
			id: item.entry.id,
			type: item.entry.type,
			state: item.entry.state,
			parts: item.parts.length,
		}));
	});

	describe("transient failures, then success", () => {
		const contexts: Message.Context[] = [];
		const open = scripted(
			[
				{ failure: { _tag: "Unavailable", retryable: true } },
				{ failure: { _tag: "Transport", retryable: true }, streamed: "half an answ" },
			],
			contexts,
		);
		const { live: it } = testEffect(runtime({ open, settings: settings({ baseDelayMs: 5, maxDelayMs: 8 }) }));

		it(
			"settles each failed draft, retries with backoff, and commits the third attempt",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const seen = yield* journal();
				const sessionId = yield* seedSession();
				yield* admit({ id: "msg_retry", sessionId, delivery: "steer" });

				yield* execution.resume(sessionId);

				const path = yield* pathOf(sessionId);
				expect(path.map((entry) => entry.state)).toEqual(["committed", "aborted", "aborted", "committed"]);
				// Every attempt is sent the original context: the failed drafts and their partial text never leak in.
				expect(contexts).toHaveLength(3);
				expect(contexts[1]).toEqual(contexts[0]);
				expect(contexts[2]).toEqual(contexts[0]);
				yield* Effect.promise(() =>
					expect({ events: seen, path }).toMatchFileSnapshot("./__artifacts__/runner.retry.json"),
				);
			}),
		);
	});

	describe("interrupt during backoff", () => {
		const open = scripted([{ failure: { _tag: "RateLimit", retryable: true } }]);
		const { live: it } = testEffect(runtime({ open, settings: settings({ baseDelayMs: 60_000 }) }));

		it(
			"cancels the sleep without leaving a draft open",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const events = yield* Event.Service;
				const seen = yield* journal();
				const sessionId = yield* seedSession();
				yield* admit({ id: "msg_retry_interrupt", sessionId, delivery: "steer" });

				const scheduled = yield* Deferred.make<void>();
				yield* events.listen((event) =>
					event.type === EventList.RetryScheduled.type
						? Deferred.succeed(scheduled, undefined).pipe(Effect.asVoid)
						: Effect.void,
				);
				const waiting = yield* execution.resume(sessionId).pipe(Effect.forkChild);
				yield* Deferred.await(scheduled);
				yield* execution.interrupt(sessionId);
				const exit = yield* Fiber.await(waiting);
				expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

				expect((yield* pathOf(sessionId)).map((entry) => entry.state)).toEqual(["committed", "aborted"]);
				expect(seen.slice(-2)).toEqual([
					{ type: EventList.RetryFinished.type, attempt: 1, success: false, message: "interrupted" },
					{ type: EventList.TurnAborted.type, cause: { _tag: "interrupted" } },
				]);
			}),
			{ timeout: 10_000 },
		);
	});

	describe("failures that are not retried", () => {
		const cases = [
			["a quota error, even when marked retryable", { _tag: "Quota", retryable: true }],
			["a retry-after longer than maxDelayMs", { _tag: "RateLimit", retryable: true, retryAfterMs: 120_000 }],
			["a non-retryable error", { _tag: "InvalidRequest", retryable: false }],
		] as const;
		for (const [name, failure] of cases) {
			const { live: it } = testEffect(
				runtime({ open: scripted([{ failure }]), settings: settings({ baseDelayMs: 1 }) }),
			);
			it(
				`fails the turn on ${name}`,
				Effect.gen(function* () {
					const execution = yield* RunnerExecution.Service;
					const seen = yield* journal();
					const sessionId = yield* seedSession();
					yield* admit({ id: "msg_no_retry", sessionId, delivery: "steer" });

					const exit = yield* execution.resume(sessionId).pipe(Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);
					expect(seen.some((event) => String(event.type).startsWith("session.retry."))).toBe(false);
					expect((yield* pathOf(sessionId)).map((entry) => entry.state)).toEqual(["committed", "aborted"]);
				}),
			);
		}
	});
});

/**
 * A provider that follows a script, one step per request: "fail" fails it the way a provider does,
 * "hang" streams until the run is interrupted; past the script every request answers. `during`
 * runs at the start of the next request, while the run is still working.
 */
const scriptedProvider = () => {
	const contexts: Message.Context[] = [];
	/** What each provider request does, in order; past the end every request answers. */
	const script: Array<"answer" | "fail" | "hang"> = [];
	/** Runs at the start of the next request, while the run is still working. */
	const during = { run: Effect.void as Effect.Effect<void> };
	const answer = immediateOpen(contexts);
	const open: LLM.Open = (input, signal) => {
		const step = script.shift();
		const hook = during.run;
		during.run = Effect.void;
		if (step === undefined || step === "answer") return Effect.andThen(hook, answer(input, signal));
		return Effect.andThen(
			hook,
			Effect.sync(() => {
				contexts.push(input.context);
				const events = createAssistantMessageEventStream();
				if (step === "fail") {
					const failed = Object.assign(
						assistant(input, 0, { stopReason: "error", errorMessage: "provider failed" }),
						{
							failure: {
								_tag: "Authentication",
								reason: "missing",
								message: "provider failed",
								retryable: false,
							} as const,
						},
					);
					events.push({ type: "start", partial: failed });
					events.push({ type: "error", reason: "error", error: failed });
					return events;
				}
				// Streams until the run is interrupted.
				const partial = assistant(input, 0, { parts: [{ type: "text", text: "partial" }] });
				events.push({ type: "start", partial });
				events.push({ type: "text.delta", partIndex: 0, delta: "partial", partial });
				const abort = () =>
					events.push({
						type: "error",
						reason: "aborted",
						error: assistant(input, 0, { stopReason: "aborted", errorMessage: "Request was aborted" }),
					});
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
				return events;
			}),
		);
	};
	const reset = Effect.sync(() => {
		contexts.length = 0;
		script.length = 0;
		during.run = Effect.void;
	});
	return { contexts, script, during, open, reset };
};

const texts = (context: Message.Context) =>
	context.messages.flatMap((message) =>
		message.role === "user" ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
	);

/** A user prompt as a client sends one: admitted, then the session woken. */
const send = (sessionId: SessionSchema.ID, id: string, delivery: "steer" | "followUp" = "steer") =>
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* control.prompt({
			sessionId,
			id: SessionMessageSchema.ID.make(id),
			prompt: PromptSchema.Prompt.fromText(id),
			delivery,
		});
	});

const settle = (sessionId: SessionSchema.ID) =>
	Effect.gen(function* () {
		const execution = yield* RunnerExecution.Service;
		yield* execution.awaitIdle(sessionId);
	});

/** The busy periods' outcomes, in order. */
const outcomes = Effect.gen(function* () {
	const events = yield* Event.Service;
	const seen: string[] = [];
	yield* events.listen((event) =>
		Effect.sync(() => {
			if (event.type === EventList.ExecutionSucceeded.type) seen.push("succeeded");
			if (event.type === EventList.ExecutionFailed.type) seen.push("failed");
			if (event.type === EventList.ExecutionInterrupted.type) seen.push("interrupted");
		}),
	);
	return seen;
});

describe("runner loop — queued input", () => {
	const provider = scriptedProvider();
	const { contexts, script, during } = provider;
	const beforeSettings = { run: Effect.void as Effect.Effect<void> };
	const { effect: it } = testEffect(runtime({ open: provider.open, beforeSettings }));

	const reset = provider.reset.pipe(
		Effect.andThen(
			Effect.sync(() => {
				beforeSettings.run = Effect.void;
			}),
		),
	);

	/** Cancels `id` the first time a turn loads settings: inside the window between the pending check and promotion. */
	const cancelBeforePromotion = Effect.fnUntraced(function* (sessionId: SessionSchema.ID, id: string) {
		const services = yield* Effect.context<SqlClient.SqlClient | Event.Service>();
		beforeSettings.run = Effect.gen(function* () {
			beforeSettings.run = Effect.void;
			const inputs = yield* SessionInput.make;
			yield* inputs.cancel(sessionId, SessionMessageSchema.ID.make(id));
		}).pipe(Effect.provideContext(services));
	});

	it(
		"asks the model nothing when the only pending prompt is cancelled before promotion",
		Effect.gen(function* () {
			yield* reset;
			const sessions = yield* Session.Service;
			const inputs = yield* SessionInput.make;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			yield* admit({ id: "msg_withdrawn", sessionId, delivery: "steer" });
			yield* cancelBeforePromotion(sessionId, "msg_withdrawn");

			// A wake, as a prompt sends: a forced resume would answer regardless.
			const execution = yield* RunnerExecution.Service;
			yield* execution.wake(sessionId);
			yield* settle(sessionId);

			expect(seen).toEqual(["succeeded"]);
			expect(
				Option.getOrThrow(yield* inputs.find(SessionMessageSchema.ID.make("msg_withdrawn"))).cancelledSeq,
			).toBeDefined();
			expect(contexts).toEqual([]);
			expect(yield* sessions.path(sessionId)).toEqual([]);
		}),
	);

	it(
		"still runs a queued follow-up when the steer that started the run is cancelled before promotion",
		Effect.gen(function* () {
			yield* reset;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			yield* send(sessionId, "A");
			yield* settle(sessionId);

			yield* admit({ id: "B", sessionId, delivery: "followUp" });
			yield* admit({ id: "S", sessionId, delivery: "steer" });
			yield* cancelBeforePromotion(sessionId, "S");
			const execution = yield* RunnerExecution.Service;
			yield* execution.wake(sessionId);
			yield* settle(sessionId);

			expect(seen).toEqual(["succeeded", "succeeded"]);
			expect(contexts.map(texts)).toEqual([["A"], ["A", "B"]]);
		}),
	);

	// A prompt's wake survives the failure, so what was sent while the run failed goes out after it.
	it(
		"runs prompts sent while a run fails right after it, steers first",
		Effect.gen(function* () {
			yield* reset;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			const services = yield* Effect.context<Control.Service>();
			script.push("fail");
			during.run = Effect.all([send(sessionId, "F1", "followUp"), send(sessionId, "S1")]).pipe(
				Effect.asVoid,
				Effect.orDie,
				Effect.provideContext(services),
			);

			yield* send(sessionId, "A");
			yield* settle(sessionId);

			expect(seen).toEqual(["failed", "succeeded"]);
			expect(contexts.map(texts)).toEqual([["A"], ["A", "S1"], ["A", "S1", "F1"]]);
		}),
	);

	// A stop claims the wakes of what was sent during the run: it stays queued, and the next prompt
	// places it, steers with that prompt and follow-ups after.
	it(
		"keeps prompts sent before a stop queued until the next prompt places them",
		Effect.gen(function* () {
			yield* reset;
			const events = yield* Event.Service;
			const execution = yield* RunnerExecution.Service;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			script.push("hang");
			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				event.type === "session.llm.text.delta"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);

			yield* send(sessionId, "A");
			yield* Deferred.await(streaming);
			yield* send(sessionId, "S1");
			yield* send(sessionId, "F1", "followUp");
			yield* execution.interrupt(sessionId, "user", { awaitSettlement: true });
			yield* settle(sessionId);

			expect(seen).toEqual(["interrupted"]);
			expect((yield* delivered(sessionId)).map((row) => [row.id, row.promotedSeq !== null])).toEqual([
				["A", true],
				["S1", false],
				["F1", false],
			]);

			yield* send(sessionId, "N");
			yield* settle(sessionId);

			expect(seen).toEqual(["interrupted", "succeeded"]);
			expect(contexts.map(texts).slice(1)).toEqual([
				["A", "S1", "N"],
				["A", "S1", "N", "F1"],
			]);
		}),
	);
});

describe("runner loop — resume after restart", () => {
	const provider = scriptedProvider();
	const { contexts, script } = provider;
	const { effect: it } = testEffect(runtime({ open: provider.open }));

	const stateOf = (sessionId: SessionSchema.ID) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [row] = yield* sql<{ execution: string | null; restarts: number }>`
				SELECT execution, restarts FROM session WHERE id = ${sessionId}
			`;
			return row;
		});

	/** The session's state each time a run starts, as it starts. */
	const atEachStart = (sessionId: SessionSchema.ID) =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const sql = yield* SqlClient.SqlClient;
			const seen: Array<{ execution: string | null; restarts: number } | undefined> = [];
			yield* events.listen((event) =>
				Schema.is(EventList.ExecutionStarted)(event) && event.data.sessionId === sessionId
					? stateOf(sessionId).pipe(
							Effect.map((state) => {
								seen.push(state);
							}),
							Effect.orDie,
							Effect.provideService(SqlClient.SqlClient, sql),
						)
					: Effect.void,
			);
			return seen;
		});

	/** Resolves once a request that streams until stopped is streaming. */
	const hanging = Effect.gen(function* () {
		const events = yield* Event.Service;
		const streaming = yield* Deferred.make<void>();
		yield* events.listen((event) =>
			Schema.is(EventList.LLMTextDelta)(event) && event.data.delta === "partial"
				? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
				: Effect.void,
		);
		return Deferred.await(streaming);
	});

	/**
	 * What a process that died mid-reply leaves: the prompt in the conversation, the reply it was
	 * streaming still a draft, and the run still marked running.
	 */
	const crashedMidReply = Effect.fnUntraced(function* (sessionId: SessionSchema.ID, id: string) {
		const events = yield* Event.Service;
		const sessions = yield* Session.Service;
		const inputs = yield* SessionInput.make;
		yield* admit({ id, sessionId, delivery: "steer" });
		yield* inputs.promoteSteers(sessionId, Number.MAX_SAFE_INTEGER);
		const input: LLM.Input = {
			resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
			sessionId,
			context: { messages: [] },
			provider: "openai",
			model: "gpt-6-luna",
		};
		const draft = assistant(input, 99, { parts: [{ type: "text", text: "half a reply" }] });
		yield* events.publish(EventList.LLMStarted, {
			timestamp: DateTime.makeUnsafe(1),
			sessionId,
			messageId: SessionMessageSchema.ID.from(draft.messageId),
			message: draft,
		});
		yield* sessions.markRunning(sessionId);
	});

	it(
		"does not resume a run the user stopped",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(sessionId, "A");
			yield* streaming;
			yield* send(sessionId, "S1");
			yield* execution.interrupt(sessionId, "user", { awaitSettlement: true });
			yield* settle(sessionId);

			// The stop is the user's: what was queued behind it stays queued, unmarked.
			expect(yield* stateOf(sessionId)).toEqual({ execution: null, restarts: 0 });
			yield* control.resumeUnfinished;

			expect(seen).toEqual(["interrupted"]);
			expect(contexts.map(texts)).toEqual([["A"]]);
			expect((yield* delivered(sessionId)).map((row) => [row.id, row.promotedSeq !== null])).toEqual([
				["A", true],
				["S1", false],
			]);
		}),
	);

	// A shutdown is no crash: the run resumes uncounted, and what was queued behind it runs too.
	it(
		"resumes a run a shutdown closed without counting a restart, and runs its queue",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const seen = yield* outcomes;
			const sessionId = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(sessionId, "A");
			yield* streaming;
			yield* send(sessionId, "S1");
			yield* send(sessionId, "F1", "followUp");
			yield* execution.interrupt(sessionId, "shutdown", { awaitSettlement: true });
			yield* settle(sessionId);

			expect(yield* stateOf(sessionId)).toEqual({ execution: "closed", restarts: 0 });
			const atStart = yield* atEachStart(sessionId);
			yield* control.resumeUnfinished;

			expect(atStart).toEqual([{ execution: "running", restarts: 0 }]);
			expect(seen).toEqual(["interrupted", "succeeded"]);
			expect(contexts.map(texts).slice(1)).toEqual([
				["A", "S1"],
				["A", "S1", "F1"],
			]);
			expect(yield* stateOf(sessionId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	// Pi resends the cut-off request as it was; a follow-up queued behind it waits for the answer.
	it(
		"answers the reply a shutdown cut off before a queued follow-up goes in",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(sessionId, "A");
			yield* streaming;
			yield* send(sessionId, "B", "followUp");
			yield* execution.interrupt(sessionId, "shutdown", { awaitSettlement: true });
			yield* settle(sessionId);

			yield* control.resumeUnfinished;

			expect(contexts.map(texts).slice(1)).toEqual([["A"], ["A", "B"]]);
		}),
	);

	it(
		"resumes a run a crash cut off, counting one restart, and answers the prompt again",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const sessions = yield* Session.Service;
			const sessionId = yield* seedSession();
			yield* crashedMidReply(sessionId, "A");
			const atStart = yield* atEachStart(sessionId);

			yield* control.resumeUnfinished;

			expect(atStart).toEqual([{ execution: "running", restarts: 1 }]);
			expect(contexts.map(texts)).toEqual([["A"]]);
			const path = yield* sessions.path(sessionId);
			expect(path.map((entry) => [entry.entry.type, entry.entry.state])).toEqual([
				["user", "committed"],
				["assistant", "aborted"],
				["assistant", "committed"],
			]);
			expect(yield* stateOf(sessionId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	// Recovery chose the session, then the user ran and stopped it: the stop cleared the mark, and the
	// recovered run must find nothing to resume rather than force another turn.
	it(
		"runs nothing when a session recovery chose was stopped before its run began",
		Effect.gen(function* () {
			yield* provider.reset;
			const sessions = yield* Session.Service;
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession();
			yield* crashedMidReply(sessionId, "A");
			yield* sessions.endExecution(sessionId, "stopped");

			yield* execution.recover(sessionId);

			expect(contexts).toEqual([]);
			expect(yield* stateOf(sessionId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	it(
		"parks a session at the restart limit, and its next prompt runs it again",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* seedSession();
			yield* crashedMidReply(sessionId, "A");
			yield* sql`UPDATE session SET restarts = ${Control.RESTART_LIMIT - 1} WHERE id = ${sessionId}`;

			yield* control.resumeUnfinished;

			expect(contexts).toEqual([]);
			expect(yield* stateOf(sessionId)).toEqual({ execution: "running", restarts: Control.RESTART_LIMIT });
			expect((yield* (yield* SessionApi.get(sessionId).pipe(Effect.map(Option.getOrThrow))).info).parked).toBe(true);

			yield* send(sessionId, "B");
			yield* settle(sessionId);

			expect(contexts.map(texts)).toEqual([["A", "B"]]);
			expect(yield* stateOf(sessionId)).toEqual({ execution: null, restarts: 0 });
			expect((yield* (yield* SessionApi.get(sessionId).pipe(Effect.map(Option.getOrThrow))).info).parked).toBe(
				false,
			);
		}),
	);

	// A run that makes progress has not crash-looped, so its count starts over mid-run.
	it(
		"starts the restart count over once a turn commits, while the run goes on",
		Effect.gen(function* () {
			yield* provider.reset;
			const sql = yield* SqlClient.SqlClient;
			const execution = yield* RunnerExecution.Service;
			const sessionId = yield* seedSession();
			yield* sql`UPDATE session SET restarts = 3 WHERE id = ${sessionId}`;
			const streaming = yield* hanging;
			const services = yield* Effect.context<Control.Service>();
			script.push("answer", "hang");
			provider.during.run = send(sessionId, "S").pipe(Effect.orDie, Effect.provideContext(services));

			yield* send(sessionId, "A");
			yield* streaming;

			expect(yield* stateOf(sessionId)).toEqual({ execution: "running", restarts: 0 });
			yield* execution.interrupt(sessionId, "user", { awaitSettlement: true });
		}),
	);
});

describe("runner loop — cancel and unfinished replies", () => {
	const provider = scriptedProvider();
	const { effect: it } = testEffect(runtime({ open: provider.open }));

	// A shutdown cut off the reply to A while B waited. Cancelling B must not drop A's unfinished
	// reply: the session stays marked for the next start.
	it(
		"keeps a session marked when cancelling the last queued prompt leaves a reply cut off",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const events = yield* Event.Service;
			const sql = yield* SqlClient.SqlClient;
			const sessionId = yield* seedSession();
			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				Schema.is(EventList.LLMTextDelta)(event) && event.data.delta === "partial"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);
			provider.script.push("hang");
			yield* send(sessionId, "A");
			yield* Deferred.await(streaming);
			yield* send(sessionId, "B", "followUp");
			yield* execution.interrupt(sessionId, "shutdown", { awaitSettlement: true });
			yield* settle(sessionId);

			yield* control.cancel(sessionId, SessionMessageSchema.ID.make("B"));

			const [row] = yield* sql<{ execution: string | null }>`SELECT execution FROM session WHERE id = ${sessionId}`;
			expect(row?.execution).toBe("closed");
		}),
	);
});
