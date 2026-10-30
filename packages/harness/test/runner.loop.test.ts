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
import { InboxRow } from "../src/db/schema.sql.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { EventRegistry } from "../src/event/registry.ts";
import type { EventSchema } from "../src/event/schema.ts";
import { RunnerExecute } from "../src/runner/execute.ts";
import { RunnerExecution } from "../src/runner/execution.ts";
import { Hooks } from "../src/runner/hooks.ts";
import { Inbox } from "../src/inbox/inbox.ts";
import { LLM } from "../src/runner/llm.ts";
import { Loop } from "../src/runner/loop.ts";
import { SandboxController } from "../src/sandbox/control.ts";
import { SandboxDriverRegistry } from "../src/sandbox/registry.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { PromptSchema } from "../src/session/prompt/schema.ts";
import { SessionProjector } from "../src/session/projector.ts";
import { Session } from "../src/session/session.ts";
import { SessionRuntime } from "../src/session/runtime.ts";
import { State } from "../src/state/state.ts";
import type { ThreadSchema } from "../src/thread/schema.ts";
import { Thread } from "../src/thread/thread.ts";
import { pooled } from "./fixtures/pool.ts";
import * as Tool from "../src/tool/tool.ts";
import { assistant, immediateOpen, toolTurn } from "./fixtures/llm.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { Process } from "../src/sandbox/utils/process.ts";

const runtime = (
	options: {
		readonly open?: LLM.Open;
		readonly contexts?: Message.Context[];
		readonly state?: State.Options;
		readonly plugins?: ReadonlyArray<Plugin>;
		readonly settings?: Info;
		readonly hooks?: Hooks.Interface;
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
		Layer.provideMerge(
			RunnerExecute.layer.pipe(
				Layer.provide(
					Loop.layer({ request }).pipe(
						Layer.provide(
							options.hooks === undefined ? Hooks.layer : Layer.succeed(Hooks.Service, options.hooks),
						),
					),
				),
			),
		),
		Layer.provideMerge(
			((seeded) => State.layer(options.state ?? {}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild))(
				pooled(options.plugins ?? plugins),
			),
		),
		Layer.provideMerge(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
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
		Layer.provideMerge(Session.storeLayer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
	);
};

/** Hooks that do nothing, except where overridden. */
const hooksOf = (overrides: Partial<Hooks.Interface>): Hooks.Interface => ({
	prepareNextTurn: (_turn, next) => Effect.succeed(next),
	prepareRequest: (request) => Effect.succeed(request),
	finishTurn: () => Effect.undefined,
	...overrides,
});

const inputsFor = (sql: SqlClient.SqlClient) =>
	SqlSchema.findAll({
		Request: Schema.String,
		Result: InboxRow,
		execute: (threadId) => sql`
			SELECT * FROM inbox WHERE thread_id = ${threadId} ORDER BY admitted_seq
		`,
	});

const delivered = Effect.fnUntraced(function* (threadId: string) {
	const sql = yield* SqlClient.SqlClient;
	const rows = yield* inputsFor(sql)(threadId);
	return rows.map((row) => ({ id: row.id, promotedSeq: Option.getOrNull(row.promotedSeq) }));
});

const seedSession = Effect.fnUntraced(function* () {
	const sessions = yield* Session.Service;
	const { spaceId, location } = yield* seedSpace({ location: process.cwd(), projectId: "p" });
	const { session, thread } = yield* sessions.create({
		spaceId,
		directory: location,
		title: "runner loop",
	});
	return { sessionId: session.id, threadId: thread.id };
});

const sessionOf = Effect.fnUntraced(function* (threadId: ThreadSchema.ID) {
	const threads = yield* Thread.Service;
	return Option.getOrThrow(yield* threads.get(threadId)).sessionId;
});

const admit = Effect.fnUntraced(function* (input: {
	readonly id: string;
	readonly threadId: ThreadSchema.ID;
	readonly delivery: "steer" | "followUp";
	readonly text?: string;
}) {
	const inputs = yield* Inbox.make;
	return yield* inputs.admit({
		id: SessionMessageSchema.ID.make(input.id),
		sessionId: yield* sessionOf(input.threadId),
		threadId: input.threadId,
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
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();

			yield* admit({ id: "msg_follow", threadId, delivery: "followUp" });
			yield* admit({ id: "msg_steer", threadId, delivery: "steer" });
			yield* execution.resume(threadId);

			const rows = yield* delivered(threadId);
			const bySeq = [...rows].sort((left, right) => (left.promotedSeq ?? 0) - (right.promotedSeq ?? 0));
			expect(bySeq.map((row) => row.id)).toEqual(["msg_steer", "msg_follow"]);
			expect((yield* threads.line(threadId)).map((item) => item.entry.type)).toEqual([
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
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_once", threadId, delivery: "steer" });

			yield* execution.resume(threadId);
			yield* execution.resume(threadId);

			expect(yield* delivered(threadId)).toEqual([{ id: "msg_once", promotedSeq: 3 }]);
			expect((yield* threads.line(threadId)).map((item) => item.entry.type)).toEqual(["user", "assistant"]);
		}),
	);

	it(
		"promotes all current steers as one request, then follow-ups one per request",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_s1", threadId, delivery: "steer" });
			yield* admit({ id: "msg_f1", threadId, delivery: "followUp" });
			yield* admit({ id: "msg_s2", threadId, delivery: "steer" });
			yield* admit({ id: "msg_f2", threadId, delivery: "followUp" });
			yield* admit({ id: "msg_s3", threadId, delivery: "steer" });

			yield* execution.resume(threadId);

			const path = yield* threads.line(threadId);
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
			const { session, thread } = yield* sessions.create({
				spaceId,
				directory: location,
				title: "missing sandbox cwd",
			});

			const exit = yield* execution.resume(thread.id).pipe(Effect.exit);
			expect(Exit.isFailure(exit)).toBe(true);
			if (Exit.isFailure(exit)) {
				const failure = Cause.findErrorOption(exit.cause);
				expect(Option.isSome(failure) && failure.value._tag).toBe("Runner.SandboxDirectoryNotFoundError");
			}
			const durable = yield* sql`SELECT type FROM event WHERE aggregate_id = ${session.id}`;
			expect(durable).toEqual([{ type: "session.created.1" }]);
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
		"continues after toolUse with no steer, re-snapshots each turn, and never moves the assistant seq",
		Effect.gen(function* () {
			contexts.length = 0;
			snapshots = 0;
			responseIndex = 0;
			const execution = yield* RunnerExecution.Service;
			const threads = yield* Thread.Service;
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, threadId } = yield* seedSession();
			yield* admit({ id: "msg_tool", threadId, delivery: "steer" });

			yield* execution.resume(threadId);

			expect(contexts).toHaveLength(2);
			expect(snapshots).toBe(2);
			const second = contexts[1]!.messages[1]!;
			const firstTool =
				second.role === "assistant" ? second.parts.find((part) => part.type === "toolCall") : undefined;
			expect(firstTool).toMatchObject({ callID: "call_echo", status: "completed" });

			const path = yield* threads.line(threadId);
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
			const threads = yield* Thread.Service;
			const { sessionId, threadId } = yield* seedSession();
			const input: LLM.Input = {
				resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
				threadId,
				context: { messages: [] },
				provider: "openai",
				model: "gpt-6-luna",
			};
			const draft = assistant(input, 99, { parts: [] });
			yield* events.publish(EventList.LLMStarted, {
				timestamp: DateTime.makeUnsafe(1),
				sessionId,
				threadId,
				messageId: SessionMessageSchema.ID.from(draft.messageId),
				message: draft,
			});

			yield* execution.wake(threadId);
			while ((yield* execution.active).has(threadId)) yield* Effect.yieldNow;

			const path = yield* threads.line(threadId);
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
			const threads = yield* Thread.Service;
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, threadId } = yield* seedSession();
			yield* admit({ id: "msg_interrupt_tools", threadId, delivery: "steer" });

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

			const running = yield* execution.resume(threadId).pipe(Effect.forkChild);
			yield* Deferred.await(bothStarted);
			const lifecycle: EventSchema.Payload[] = [];
			yield* events.listen((event) =>
				Effect.sync(() => {
					if (event.type === EventList.ExecutionInterrupted.type) lifecycle.push(event);
				}),
			);
			yield* execution.interrupt(threadId, "user", { awaitSettlement: true });
			const exit = yield* Fiber.await(running);
			expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
			// The reason is the caller's, not something inferred from the cause.
			const interrupted = lifecycle[0];
			expect(interrupted).toBeDefined();
			if (interrupted !== undefined && Schema.is(EventList.ExecutionInterrupted)(interrupted))
				expect(interrupted.data.reason).toBe("user");

			const path = yield* threads.line(threadId);
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
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_interrupted", threadId, delivery: "steer" });

			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				event.type === "session.llm.text.delta"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);
			const waiting = yield* execution.resume(threadId).pipe(Effect.forkChild);
			yield* Deferred.await(streaming);

			yield* execution.interrupt(threadId);
			const exit = yield* Fiber.await(waiting);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

			const path = yield* threads.line(threadId);
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
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_failed", threadId, delivery: "steer" });

			const exit = yield* execution.resume(threadId).pipe(Effect.exit);
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

			const path = yield* threads.line(threadId);
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
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_failed_lifecycle", threadId, delivery: "steer" });

			yield* execution.resume(threadId).pipe(Effect.exit);

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

type Failure = { readonly _tag: string; readonly retryable: boolean; readonly retryAfterMs?: number };

/** Each call takes the next script entry: a failure (optionally after streaming text), else success. */
const scripted = (
	script: ReadonlyArray<{ readonly failure: Failure; readonly streamed?: string } | "ok">,
	contexts: Message.Context[] = [],
	models: string[] = [],
): LLM.Open => {
	let index = 0;
	return (input) =>
		Effect.sync(() => {
			index += 1;
			contexts.push(structuredClone(input.context));
			models.push(input.model);
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

describe("runner loop — retry", () => {
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

	const pathOf = Effect.fnUntraced(function* (threadId: ThreadSchema.ID) {
		const threads = yield* Thread.Service;
		return (yield* threads.line(threadId)).map((item) => ({
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
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_retry", threadId, delivery: "steer" });

				yield* execution.resume(threadId);

				const path = yield* pathOf(threadId);
				expect(path.map((entry) => entry.state)).toEqual(["committed", "aborted", "aborted", "committed"]);
				// Every attempt is sent the original context: the failed drafts and their partial text never leak in.
				expect(contexts).toHaveLength(3);
				expect(contexts[1]).toEqual(contexts[0]);
				expect(contexts[2]).toEqual(contexts[0]);
				yield* Effect.promise(() =>
					expect(`${JSON.stringify({ events: seen, path }, null, "\t")}\n`).toMatchFileSnapshot(
						"./__artifacts__/runner.retry.json",
					),
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
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_retry_interrupt", threadId, delivery: "steer" });

				const scheduled = yield* Deferred.make<void>();
				yield* events.listen((event) =>
					event.type === EventList.RetryScheduled.type
						? Deferred.succeed(scheduled, undefined).pipe(Effect.asVoid)
						: Effect.void,
				);
				const waiting = yield* execution.resume(threadId).pipe(Effect.forkChild);
				yield* Deferred.await(scheduled);
				yield* execution.interrupt(threadId);
				const exit = yield* Fiber.await(waiting);
				expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);

				expect((yield* pathOf(threadId)).map((entry) => entry.state)).toEqual(["committed", "aborted"]);
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
					const { threadId } = yield* seedSession();
					yield* admit({ id: "msg_no_retry", threadId, delivery: "steer" });

					const exit = yield* execution.resume(threadId).pipe(Effect.exit);
					expect(Exit.isFailure(exit)).toBe(true);
					expect(seen.some((event) => String(event.type).startsWith("session.retry."))).toBe(false);
					expect((yield* pathOf(threadId)).map((entry) => entry.state)).toEqual(["committed", "aborted"]);
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
const send = (threadId: ThreadSchema.ID, id: string, delivery: "steer" | "followUp" = "steer") =>
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* control.prompt({
			sessionId: yield* sessionOf(threadId),
			threadId,
			id: SessionMessageSchema.ID.make(id),
			prompt: PromptSchema.Prompt.fromText(id),
			delivery,
		});
	});

const settle = (threadId: ThreadSchema.ID) =>
	Effect.gen(function* () {
		const execution = yield* RunnerExecution.Service;
		yield* execution.awaitIdle(threadId);
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
	const cancelBeforePromotion = Effect.fnUntraced(function* (threadId: ThreadSchema.ID, id: string) {
		const services = yield* Effect.context<SqlClient.SqlClient | Event.Service>();
		beforeSettings.run = Effect.gen(function* () {
			beforeSettings.run = Effect.void;
			const inputs = yield* Inbox.make;
			yield* inputs.cancel(threadId, SessionMessageSchema.ID.make(id));
		}).pipe(Effect.provideContext(services));
	});

	it(
		"asks the model nothing when the only pending prompt is cancelled before promotion",
		Effect.gen(function* () {
			yield* reset;
			const threads = yield* Thread.Service;
			const inputs = yield* Inbox.make;
			const seen = yield* outcomes;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_withdrawn", threadId, delivery: "steer" });
			yield* cancelBeforePromotion(threadId, "msg_withdrawn");

			// A wake, as a prompt sends: a forced resume would answer regardless.
			const execution = yield* RunnerExecution.Service;
			yield* execution.wake(threadId);
			yield* settle(threadId);

			expect(seen).toEqual(["succeeded"]);
			expect(
				Option.getOrThrow(yield* inputs.find(SessionMessageSchema.ID.make("msg_withdrawn"))).cancelledSeq,
			).toBeDefined();
			expect(contexts).toEqual([]);
			expect(yield* threads.line(threadId)).toEqual([]);
		}),
	);

	it(
		"still runs a queued follow-up when the steer that started the run is cancelled before promotion",
		Effect.gen(function* () {
			yield* reset;
			const seen = yield* outcomes;
			const { threadId } = yield* seedSession();
			yield* send(threadId, "A");
			yield* settle(threadId);

			yield* admit({ id: "B", threadId, delivery: "followUp" });
			yield* admit({ id: "S", threadId, delivery: "steer" });
			yield* cancelBeforePromotion(threadId, "S");
			const execution = yield* RunnerExecution.Service;
			yield* execution.wake(threadId);
			yield* settle(threadId);

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
			const { threadId } = yield* seedSession();
			const services = yield* Effect.context<Control.Service | Thread.Service>();
			script.push("fail");
			during.run = Effect.all([send(threadId, "F1", "followUp"), send(threadId, "S1")]).pipe(
				Effect.asVoid,
				Effect.orDie,
				Effect.provideContext(services),
			);

			yield* send(threadId, "A");
			yield* settle(threadId);

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
			const { threadId } = yield* seedSession();
			script.push("hang");
			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				event.type === "session.llm.text.delta"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);

			yield* send(threadId, "A");
			yield* Deferred.await(streaming);
			yield* send(threadId, "S1");
			yield* send(threadId, "F1", "followUp");
			yield* execution.interrupt(threadId, "user", { awaitSettlement: true });
			yield* settle(threadId);

			expect(seen).toEqual(["interrupted"]);
			expect((yield* delivered(threadId)).map((row) => [row.id, row.promotedSeq !== null])).toEqual([
				["A", true],
				["S1", false],
				["F1", false],
			]);

			yield* send(threadId, "N");
			yield* settle(threadId);

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

	const stateOf = (threadId: ThreadSchema.ID) =>
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const [row] = yield* sql<{ execution: string | null; restarts: number }>`
				SELECT execution, restarts FROM thread WHERE id = ${threadId}
			`;
			return row;
		});

	/** The thread's state each time a run starts, as it starts. */
	const atEachStart = (threadId: ThreadSchema.ID) =>
		Effect.gen(function* () {
			const events = yield* Event.Service;
			const sql = yield* SqlClient.SqlClient;
			const seen: Array<{ execution: string | null; restarts: number } | undefined> = [];
			yield* events.listen((event) =>
				Schema.is(EventList.ExecutionStarted)(event) && event.data.threadId === threadId
					? stateOf(threadId).pipe(
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
	const crashedMidReply = Effect.fnUntraced(function* (threadId: ThreadSchema.ID, id: string) {
		const events = yield* Event.Service;
		const threads = yield* Thread.Service;
		const inputs = yield* Inbox.make;
		yield* admit({ id, threadId, delivery: "steer" });
		yield* inputs.promoteSteers(threadId, Number.MAX_SAFE_INTEGER);
		const input: LLM.Input = {
			resolvedModel: yield* LLM.resolve({ provider: "openai", model: "gpt-4o-mini" }),
			threadId,
			context: { messages: [] },
			provider: "openai",
			model: "gpt-6-luna",
		};
		const draft = assistant(input, 99, { parts: [{ type: "text", text: "half a reply" }] });
		yield* events.publish(EventList.LLMStarted, {
			timestamp: DateTime.makeUnsafe(1),
			sessionId: yield* sessionOf(threadId),
			threadId,
			messageId: SessionMessageSchema.ID.from(draft.messageId),
			message: draft,
		});
		yield* threads.markRunning(threadId);
	});

	it(
		"does not resume a run the user stopped",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const seen = yield* outcomes;
			const { threadId } = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(threadId, "A");
			yield* streaming;
			yield* send(threadId, "S1");
			yield* execution.interrupt(threadId, "user", { awaitSettlement: true });
			yield* settle(threadId);

			// The stop is the user's: what was queued behind it stays queued, unmarked.
			expect(yield* stateOf(threadId)).toEqual({ execution: null, restarts: 0 });
			yield* control.resumeUnfinished;

			expect(seen).toEqual(["interrupted"]);
			expect(contexts.map(texts)).toEqual([["A"]]);
			expect((yield* delivered(threadId)).map((row) => [row.id, row.promotedSeq !== null])).toEqual([
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
			const { threadId } = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(threadId, "A");
			yield* streaming;
			yield* send(threadId, "S1");
			yield* send(threadId, "F1", "followUp");
			yield* execution.interrupt(threadId, "shutdown", { awaitSettlement: true });
			yield* settle(threadId);

			expect(yield* stateOf(threadId)).toEqual({ execution: "closed", restarts: 0 });
			const atStart = yield* atEachStart(threadId);
			yield* control.resumeUnfinished;

			expect(atStart).toEqual([{ execution: "running", restarts: 0 }]);
			expect(seen).toEqual(["interrupted", "succeeded"]);
			expect(contexts.map(texts).slice(1)).toEqual([
				["A", "S1"],
				["A", "S1", "F1"],
			]);
			expect(yield* stateOf(threadId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	// The cut-off request is resent as it was; a follow-up queued behind it waits for the answer.
	it(
		"answers the reply a shutdown cut off before a queued follow-up goes in",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const execution = yield* RunnerExecution.Service;
			const { threadId } = yield* seedSession();
			const streaming = yield* hanging;
			script.push("hang");
			yield* send(threadId, "A");
			yield* streaming;
			yield* send(threadId, "B", "followUp");
			yield* execution.interrupt(threadId, "shutdown", { awaitSettlement: true });
			yield* settle(threadId);

			yield* control.resumeUnfinished;

			expect(contexts.map(texts).slice(1)).toEqual([["A"], ["A", "B"]]);
		}),
	);

	it(
		"resumes a run a crash cut off, counting one restart, and answers the prompt again",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const threads = yield* Thread.Service;
			const { threadId } = yield* seedSession();
			yield* crashedMidReply(threadId, "A");
			const atStart = yield* atEachStart(threadId);

			yield* control.resumeUnfinished;

			expect(atStart).toEqual([{ execution: "running", restarts: 1 }]);
			expect(contexts.map(texts)).toEqual([["A"]]);
			const path = yield* threads.line(threadId);
			expect(path.map((entry) => [entry.entry.type, entry.entry.state])).toEqual([
				["user", "committed"],
				["assistant", "aborted"],
				["assistant", "committed"],
			]);
			expect(yield* stateOf(threadId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	// Recovery chose the session, then the user ran and stopped it: the stop cleared the mark, and the
	// recovered run must find nothing to resume rather than force another turn.
	it(
		"runs nothing when a session recovery chose was stopped before its run began",
		Effect.gen(function* () {
			yield* provider.reset;
			const threads = yield* Thread.Service;
			const execution = yield* RunnerExecution.Service;
			const { threadId } = yield* seedSession();
			yield* crashedMidReply(threadId, "A");
			yield* threads.endExecution(threadId, "stopped");

			yield* execution.recover(threadId);

			expect(contexts).toEqual([]);
			expect(yield* stateOf(threadId)).toEqual({ execution: null, restarts: 0 });
		}),
	);

	it(
		"parks a session at the restart limit, and its next prompt runs it again",
		Effect.gen(function* () {
			yield* provider.reset;
			const control = yield* Control.Service;
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, threadId } = yield* seedSession();
			yield* crashedMidReply(threadId, "A");
			yield* sql`UPDATE thread SET restarts = ${Control.RESTART_LIMIT - 1} WHERE id = ${threadId}`;

			yield* control.resumeUnfinished;

			expect(contexts).toEqual([]);
			expect(yield* stateOf(threadId)).toEqual({ execution: "running", restarts: Control.RESTART_LIMIT });
			expect((yield* (yield* SessionApi.get(sessionId).pipe(Effect.map(Option.getOrThrow))).main.info).parked).toBe(
				true,
			);

			yield* send(threadId, "B");
			yield* settle(threadId);

			expect(contexts.map(texts)).toEqual([["A", "B"]]);
			expect(yield* stateOf(threadId)).toEqual({ execution: null, restarts: 0 });
			expect((yield* (yield* SessionApi.get(sessionId).pipe(Effect.map(Option.getOrThrow))).main.info).parked).toBe(
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
			const { threadId } = yield* seedSession();
			yield* sql`UPDATE thread SET restarts = 3 WHERE id = ${threadId}`;
			const streaming = yield* hanging;
			const services = yield* Effect.context<Control.Service | Thread.Service>();
			script.push("answer", "hang");
			provider.during.run = send(threadId, "S").pipe(Effect.orDie, Effect.provideContext(services));

			yield* send(threadId, "A");
			yield* streaming;

			expect(yield* stateOf(threadId)).toEqual({ execution: "running", restarts: 0 });
			yield* execution.interrupt(threadId, "user", { awaitSettlement: true });
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
			const { threadId } = yield* seedSession();
			const streaming = yield* Deferred.make<void>();
			yield* events.listen((event) =>
				Schema.is(EventList.LLMTextDelta)(event) && event.data.delta === "partial"
					? Deferred.succeed(streaming, undefined).pipe(Effect.asVoid)
					: Effect.void,
			);
			provider.script.push("hang");
			yield* send(threadId, "A");
			yield* Deferred.await(streaming);
			yield* send(threadId, "B", "followUp");
			yield* execution.interrupt(threadId, "shutdown", { awaitSettlement: true });
			yield* settle(threadId);

			yield* control.cancel(threadId, SessionMessageSchema.ID.make("B"));

			const [row] = yield* sql<{ execution: string | null }>`SELECT execution FROM thread WHERE id = ${threadId}`;
			expect(row?.execution).toBe("closed");
		}),
	);
});

describe("runner loop — lifecycle hooks", () => {
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
	const late = Tool.register(
		Tool.make({
			name: "echo_late",
			description: "declared from the second snapshot on",
			parameters: Schema.Struct({ value: Schema.String }),
			success: Schema.String,
			encodeContent: (value: string) => [{ type: "text", text: value }],
			handler: ({ value }) => Effect.succeed(value),
		}),
	);
	const echoCall = {
		type: "toolCall" as const,
		callID: "call_echo",
		name: "echo",
		arguments: { value: "hello" },
		status: "pending" as const,
		time: { start: 1, end: 1 },
	};
	/** A fresh tool turn per test, since it counts its own requests. */
	const recording = (contexts: Message.Context[]): LLM.Open => {
		const next = toolTurn(echoCall);
		return (input, signal) => {
			contexts.push(input.context);
			return next(input, signal);
		};
	};
	const toolNames = (context: Message.Context) =>
		(context.tools ?? []).map((tool) => tool.name).filter((name) => name.startsWith("echo"));

	describe("a tool-use chain", () => {
		const contexts: Message.Context[] = [];
		const calls: Array<Record<string, unknown>> = [];
		let snapshots = 0;
		const hooks: Hooks.Interface = {
			prepareNextTurn: (turn, next) =>
				Effect.sync(() => {
					calls.push({
						hook: "prepareNextTurn",
						completed: turn.reason,
						tools: next.tools.defs.map((def) => def.name).filter((name) => name.startsWith("echo")),
					});
					return next;
				}),
			prepareRequest: (request, attempt) =>
				Effect.sync(() => {
					calls.push({ hook: "prepareRequest", retry: attempt.retry });
					return request;
				}),
			finishTurn: (turn) =>
				Effect.sync(() => {
					calls.push({ hook: "finishTurn", reason: turn.reason });
					return undefined;
				}),
		};
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				hooks,
				plugins: [
					...plugins,
					{
						id: "test.tool.echo",
						kind: "tool",
						setup: (ctx) => {
							snapshots += 1;
							ctx.plugin.tools.add(echo);
							// A tool the plugin only declares from the second snapshot on.
							if (snapshots > 1) ctx.plugin.tools.add(late);
						},
					},
				],
			}),
		);

		it(
			"snapshots before each turn, so a tool declared mid-chain reaches the next request",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_chain", threadId, delivery: "steer" });

				yield* execution.resume(threadId);

				expect(snapshots).toBe(2);
				expect(contexts.map(toolNames)).toEqual([["echo"], ["echo", "echo_late"]]);
				yield* Effect.promise(() =>
					expect(
						`${JSON.stringify({ calls, requestTools: contexts.map(toolNames) }, null, "\t")}\n`,
					).toMatchFileSnapshot("./__artifacts__/runner.hooks.json"),
				);
			}),
		);
	});

	describe("pending input", () => {
		const seen: Array<ReadonlyArray<string>> = [];
		const { effect: it } = testEffect(
			runtime({
				open: recording([]),
				hooks: hooksOf({
					finishTurn: (turn) =>
						Effect.sync(() => {
							seen.push(turn.pending.map((item) => `${item.delivery}:${item.id}`));
							return undefined;
						}),
				}),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"shows the queued steers, else the oldest follow-up, without promoting them",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_first", threadId, delivery: "steer" });
				yield* admit({ id: "msg_later", threadId, delivery: "followUp" });
				yield* admit({ id: "msg_next", threadId, delivery: "followUp" });

				yield* execution.resume(threadId);

				// Turn 1 (toolUse), turn 2 (stop), turn 3 (first follow-up), turn 4 (second follow-up).
				expect(seen).toEqual([["followUp:msg_later"], ["followUp:msg_later"], ["followUp:msg_next"], []]);
			}),
		);
	});

	describe("finishTurn end", () => {
		const contexts: Message.Context[] = [];
		let prepared = 0;
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				hooks: hooksOf({
					finishTurn: (turn) => Effect.succeed(turn.reason === "toolUse" ? "end" : undefined),
					prepareNextTurn: (_turn, next) => Effect.sync(() => ((prepared += 1), next)),
				}),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"stops the run after the committed turn and leaves queued input for the next run",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_first", threadId, delivery: "steer" });
				yield* admit({ id: "msg_queued", threadId, delivery: "followUp" });

				yield* execution.resume(threadId);

				expect(contexts).toHaveLength(1);
				expect(prepared).toBe(0);
				const threads = yield* Thread.Service;
				const path = yield* threads.line(threadId);
				expect(path.map((item) => [item.entry.type, item.entry.state])).toEqual([
					["user", "committed"],
					["assistant", "committed"],
				]);
				const tool = path[1]!.parts.find((part) => part.type === "toolCall");
				expect(tool).toBeDefined();
				const rows = yield* delivered(threadId);
				expect(rows.find((row) => row.id === "msg_queued")?.promotedSeq).toBeNull();

				// The next run answers the tool results first, then picks the queued follow-up up.
				yield* execution.resume(threadId);
				expect(contexts).toHaveLength(3);
				expect(contexts[1]!.messages).toHaveLength(2);
				expect(contexts[2]!.messages).toHaveLength(4);
				const next = yield* delivered(threadId);
				expect(next.find((row) => row.id === "msg_queued")?.promotedSeq).not.toBeNull();
			}),
		);
	});

	describe("a steer landing while a resume loads", () => {
		const contexts: Message.Context[] = [];
		const gate: { run: Effect.Effect<void> } = { run: Effect.void };
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				beforeSettings: gate,
				hooks: hooksOf({ finishTurn: (turn) => Effect.succeed(turn.reason === "toolUse" ? "end" : undefined) }),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"joins the reply being answered, ahead of the queued follow-up",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_first", threadId, delivery: "steer" });
				yield* admit({ id: "msg_queued", threadId, delivery: "followUp" });
				yield* execution.resume(threadId);

				const services = yield* Effect.context<Effect.Services<ReturnType<typeof admit>>>();
				gate.run = admit({ id: "msg_late", threadId, delivery: "steer" }).pipe(
					Effect.andThen(
						Effect.sync(() => {
							gate.run = Effect.void;
						}),
					),
					Effect.provideContext(services),
				);
				yield* execution.resume(threadId);

				expect(contexts.map(texts)).toEqual([
					["msg_first"],
					["msg_first", "msg_late"],
					["msg_first", "msg_late", "msg_queued"],
				]);
			}),
		);
	});

	describe("finishTurn continue", () => {
		const contexts: Message.Context[] = [];
		const completed: string[] = [];
		const { effect: it } = testEffect(
			runtime({
				contexts,
				hooks: hooksOf({
					finishTurn: () => Effect.succeed("continue"),
					prepareNextTurn: (turn, next) => Effect.sync(() => (completed.push(turn.reason), next)),
				}),
			}),
		);

		it(
			"sends nothing after a finished reply when nothing was appended",
			Effect.gen(function* () {
				contexts.length = 0;
				completed.length = 0;
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_done", threadId, delivery: "steer" });

				yield* execution.resume(threadId);

				// The decision was honoured (another turn was scheduled) and the leaf guard sent nothing.
				expect(completed).toEqual(["stop"]);
				expect(contexts).toHaveLength(1);
			}),
		);
	});

	describe("finishTurn continue after a tool batch", () => {
		const contexts: Message.Context[] = [];
		const completed: string[] = [];
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				hooks: hooksOf({
					finishTurn: () => Effect.succeed("continue"),
					prepareNextTurn: (turn, next) => Effect.sync(() => (completed.push(turn.reason), next)),
				}),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"is met by the tool-result request and adds none of its own",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_tool", threadId, delivery: "steer" });

				yield* execution.resume(threadId);

				expect(completed).toEqual(["toolUse", "stop"]);
				expect(contexts).toHaveLength(2);
			}),
		);
	});

	describe("prepareNextTurn", () => {
		const contexts: Message.Context[] = [];
		const during: { run: Effect.Effect<void> } = { run: Effect.void };
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				hooks: hooksOf({
					prepareNextTurn: (_turn, next) => during.run.pipe(Effect.as({ ...next, systemPrompt: "replaced" })),
				}),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"its snapshot reaches the next request, with a steer queued while it ran",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_first", threadId, delivery: "steer" });
				const services = yield* Effect.context<Effect.Services<ReturnType<typeof admit>>>();
				during.run = admit({ id: "msg_during", threadId, delivery: "steer" }).pipe(
					Effect.andThen(
						Effect.sync(() => {
							during.run = Effect.void;
						}),
					),
					Effect.provideContext(services),
				);

				yield* execution.resume(threadId);

				expect(contexts.map((context) => context.systemPrompt === "replaced")).toEqual([false, true]);
				expect(contexts.map(texts)).toEqual([["msg_first"], ["msg_first", "msg_during"]]);
			}),
		);
	});

	describe("prepareRequest and queued input", () => {
		const contexts: Message.Context[] = [];
		const seen: Array<ReadonlyArray<string>> = [];
		const during: { run: Effect.Effect<void> } = { run: Effect.void };
		const { effect: it } = testEffect(
			runtime({
				open: recording(contexts),
				hooks: hooksOf({
					prepareRequest: (request) =>
						Effect.sync(() => seen.push(texts(request.context))).pipe(
							Effect.andThen(during.run),
							Effect.as(request),
						),
				}),
				plugins: [...plugins, { id: "test.tool.echo", kind: "tool", setup: (ctx) => ctx.plugin.tools.add(echo) }],
			}),
		);

		it(
			"sees promoted input, and a steer queued while it runs waits for the next turn",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_first", threadId, delivery: "steer" });
				const services = yield* Effect.context<Effect.Services<ReturnType<typeof admit>>>();
				during.run = admit({ id: "msg_during", threadId, delivery: "steer" }).pipe(
					Effect.andThen(
						Effect.sync(() => {
							during.run = Effect.void;
						}),
					),
					Effect.provideContext(services),
				);

				yield* execution.resume(threadId);

				expect(seen).toEqual([["msg_first"], ["msg_first", "msg_during"]]);
				expect(contexts.map(texts)).toEqual(seen);
			}),
		);
	});

	describe("prepareRequest on a retry", () => {
		const models: string[] = [];
		const attempts: Array<{ readonly retry: number; readonly failed?: string }> = [];
		const open = scripted([{ failure: { _tag: "Unavailable", retryable: true } }], [], models);
		const { live: it } = testEffect(
			runtime({
				open,
				settings: settings({ baseDelayMs: 5, maxDelayMs: 8 }),
				hooks: hooksOf({
					prepareRequest: (request, attempt) =>
						Effect.sync(() => {
							attempts.push(attempt);
							return attempt.retry > 0 ? { ...request, model: "routed-model" } : request;
						}),
				}),
			}),
		);

		it(
			"sees the retry number and failure, and its replacement model reaches the request",
			Effect.gen(function* () {
				const execution = yield* RunnerExecution.Service;
				const { threadId } = yield* seedSession();
				yield* admit({ id: "msg_route", threadId, delivery: "steer" });

				yield* execution.resume(threadId);

				expect(attempts).toMatchObject([
					{ retry: 0 },
					{ retry: 1, failed: expect.stringContaining("Unavailable failure") },
				]);
				expect(models[1]).toBe("routed-model");
				expect(models[0]).not.toBe("routed-model");
			}),
		);
	});
});

describe("runner loop — tool exposure", () => {
	const tool = (name: string, exposure?: Tool.ToolExposure) =>
		Tool.register(
			Tool.make({
				name,
				description: `${name} tool`,
				promptSnippet: `${name} snippet`,
				promptGuidelines: [`${name} guideline`],
				...(exposure === undefined ? {} : { exposure }),
				parameters: Schema.Struct({ value: Schema.String }),
				success: Schema.String,
				encodeContent: (value: string) => [{ type: "text", text: value }],
				handler: ({ value }) => Effect.succeed(value),
			}),
		);
	const contexts: Message.Context[] = [];
	const next = toolTurn({
		type: "toolCall",
		callID: "call_deferred",
		name: "x_deferred",
		arguments: { value: "hello" },
		status: "pending",
		time: { start: 1, end: 1 },
	});
	const { effect: it } = testEffect(
		runtime({
			open: (input, signal) => {
				contexts.push(input.context);
				return next(input, signal);
			},
			plugins: [
				...plugins,
				{
					id: "test.tool.exposure",
					kind: "tool",
					setup: (ctx) => {
						ctx.plugin.tools.add(tool("x_direct"));
						ctx.plugin.tools.add(tool("x_model", "model"));
						ctx.plugin.tools.add(tool("x_codemode", "codemode"));
						ctx.plugin.tools.add(tool("x_deferred", "deferred"));
						ctx.plugin.tools.add(tool("x_hidden", "hidden"));
						// Overrides the built-in, so the bash file-ops rule must go with it.
						ctx.plugin.tools.add(tool("bash", "hidden"));
					},
				},
			],
		}),
	);

	it(
		"declares only direct and model tools, in the request and the prompt, and refuses the rest",
		Effect.gen(function* () {
			const execution = yield* RunnerExecution.Service;
			const { threadId } = yield* seedSession();
			yield* admit({ id: "msg_exposure", threadId, delivery: "steer" });

			yield* execution.resume(threadId);

			expect(contexts).toHaveLength(2);
			const section = (name: string) =>
				new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`).exec(contexts[0]!.systemPrompt ?? "")?.[1];
			const reply = contexts[1]!.messages[1]!;
			const call = reply.role === "assistant" ? reply.parts.find((part) => part.type === "toolCall") : undefined;
			const result = {
				requestTools: contexts.map((context) => (context.tools ?? []).map((tool) => tool.name)),
				tools: section("tools"),
				rules: section("rules"),
				deferredCall: call,
			};
			expect(result.requestTools[0]).toContain("x_model");
			expect(result.requestTools[0]).not.toContain("bash");
			yield* Effect.promise(() =>
				expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
					"./__artifacts__/tools.exposure.json",
				),
			);
		}),
	);
});
