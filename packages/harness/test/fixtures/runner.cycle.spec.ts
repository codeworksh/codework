import "../utils/env.ts";

import type { Message } from "@codeworksh/aikit";
import { Effect, Layer, Queue, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { describe, expect, it as vitestIt } from "vite-plus/test";
import { Context } from "../../src/context/context.ts";
import { ContextCodec } from "../../src/context/codec.ts";
import { Control } from "../../src/control.ts";
import { Database } from "../../src/db/db.ts";
import { Event } from "../../src/event/event.ts";
import { RunnerExecute } from "../../src/runner/execute.ts";
import { Loop } from "../../src/runner/loop.ts";
import { SandboxController } from "../../src/sandbox/control.ts";
import { SandboxDriver } from "../../src/sandbox/driver.ts";
import { VercelSandboxDriver } from "../../src/sandbox/drivers/vercel.ts";
import { AbsolutePath } from "../../src/schema.ts";
import { SessionLive } from "../../src/session/live.ts";
import { SessionRuntime } from "../../src/session/runtime.ts";
import type { SessionSchema } from "../../src/session/schema.ts";
import { Session } from "../../src/session/session.ts";
import { State } from "../../src/state/state.ts";

const database = Database.layer(":memory:");
const vercel = VercelSandboxDriver.make();
const sandbox = SandboxController.layer().pipe(
	Layer.provideMerge(SandboxDriver.layer(vercel)),
	Layer.provideMerge(database),
);
const runtime = Control.layer.pipe(
	Layer.provideMerge(RunnerExecute.layer.pipe(Layer.provide(Loop.layer()))),
	Layer.provideMerge(State.layer()),
	Layer.provideMerge(SessionRuntime.layer),
	Layer.provideMerge(sandbox),
	Layer.provideMerge(Context.layer),
	Layer.provideMerge(SessionLive.layer),
	Layer.provideMerge(Event.layer),
	Layer.provideMerge(database),
);

const liveIt = process.env.OPENAI_API_KEY ? vitestIt : vitestIt.skip;

const eventTypesFor = (sql: SqlClient.SqlClient) =>
	SqlSchema.findAll({
		Request: Schema.String,
		Result: Schema.Struct({ type: Schema.String }),
		execute: (sessionId) => sql`SELECT type FROM event WHERE aggregate_id = ${sessionId} ORDER BY seq`,
	});

const inputStateFor = (sql: SqlClient.SqlClient) =>
	SqlSchema.findOne({
		Request: Schema.String,
		Result: Schema.Struct({ count: Schema.Int, pending: Schema.Int }),
		execute: (sessionId) => sql`
			SELECT
				COUNT(*) AS count,
				SUM(CASE WHEN promoted_seq IS NULL THEN 1 ELSE 0 END) AS pending
			FROM session_input
			WHERE session_id = ${sessionId}
		`,
	});

const textOf = (message: Message.Message): string =>
	message.parts
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n")
		.trim();

const thinkingOf = (message: Message.Message): string =>
	message.parts
		.flatMap((part) => (part.type === "thinking" ? [part.thinking] : []))
		.join("\n")
		.trim();

const waitUntilIdle = (control: Control.Interface, sessionId: SessionSchema.ID) =>
	Effect.gen(function* () {
		while ((yield* control.active).has(sessionId)) yield* Effect.sleep("10 millis");
	}).pipe(Effect.timeout("10 seconds"));

const historyPrompts = [
	"We are building a continuity test around a fictional moon named Velora. In one short sentence, state the color of its sky.",
	"In one short sentence, name Velora's capital and its defining landmark.",
	"In one short sentence, introduce an archivist who lives in that capital.",
	"In one short sentence, state the archivist's central problem.",
	"In one short sentence, name the object that might solve that problem.",
] as const;

export const runnerCycleSpec = (resourceId: () => Promise<string>) =>
	describe("runner cycle — OpenAI + shared Vercel sandbox", () => {
		liveIt(
			"runs durable input through Loop in SandboxIO, tombstones an interrupted response, then recovers",
			{ timeout: 480_000 },
			() =>
				Effect.runPromise(
					Effect.gen(function* () {
						const sql = yield* SqlClient.SqlClient;
						const control = yield* Control.Service;
						const context = yield* Context.Service;
						const events = yield* Event.Service;
						const sessions = yield* Session.Service;
						const sandboxes = yield* SandboxController.Controller;

						const sandboxInstanceId = (yield* sandboxes.register({
							driver: vercel,
							providerResourceId: yield* Effect.promise(resourceId),
							metadata: { test: "runner-cycle" },
						})).id;

						yield* sql`INSERT OR IGNORE INTO project (id, name, created_at, updated_at) VALUES ('local','local',0,0)`;
						const session = yield* sessions.create({
							projectId: "local",
							slug: `runner-cycle-${crypto.randomUUID()}`,
							directory: AbsolutePath.make("/tmp"),
							title: "Live runner cycle",
							tag: "test",
							sandboxInstanceId,
						});

						const terminals = yield* Queue.unbounded<"ended" | "failed">();
						const removeTerminalListener = yield* events.listen((event) => {
							if (typeof event.data !== "object" || event.data === null) return Effect.void;
							const data = event.data as Record<string, unknown>;
							if (data.sessionId !== session.id) return Effect.void;
							if (event.type === "session.llm.ended") return Queue.offer(terminals, "ended").pipe(Effect.asVoid);
							if (event.type === "session.llm.failed")
								return Queue.offer(terminals, "failed").pipe(Effect.asVoid);
							return Effect.void;
						});
						yield* Effect.addFinalizer(() => removeTerminalListener);

						const readLastAssistant = Effect.fnUntraced(function* () {
							const path = yield* sessions.path(session.id);
							const last = path.at(-1);
							if (last === undefined)
								return yield* Effect.die("session path is empty after an LLM terminal event");
							const message = yield* ContextCodec.decodeMessage(last);
							if (message.role !== "assistant") {
								return yield* Effect.die(`last session entry is ${message.role}, not assistant`);
							}
							return message;
						});

						const ask = Effect.fnUntraced(function* (prompt: string) {
							yield* control.prompt({ sessionId: session.id, prompt: { text: prompt } });
							const terminal = yield* Queue.take(terminals).pipe(Effect.timeout("75 seconds"));
							yield* waitUntilIdle(control, session.id);
							expect(terminal).toBe("ended");
							return yield* readLastAssistant();
						});

						const persistedThinking: string[] = [];
						for (const [index, prompt] of historyPrompts.entries()) {
							const assistant = yield* ask(prompt);
							const thinking = thinkingOf(assistant);
							if (thinking.length > 0) persistedThinking.push(thinking);
							expect(textOf(assistant).length).toBeGreaterThan(0);
							const path = yield* sessions.path(session.id);
							expect(path.map((item) => item.entry.type)).toEqual(
								Array.from({ length: (index + 1) * 2 }, (_, position) =>
									position % 2 === 0 ? "user" : "assistant",
								),
							);
							yield* Effect.logInfo("live conversation pair", {
								turn: index + 1,
								user: prompt,
								thinking,
								assistant: textOf(assistant),
							});
						}
						const textDeltas = yield* Queue.unbounded<string>();
						const removeDeltaListener = yield* events.listen((event) => {
							if (typeof event.data !== "object" || event.data === null) return Effect.void;
							const data = event.data as Record<string, unknown>;
							if (data.sessionId !== session.id || typeof data.delta !== "string" || data.delta.length === 0) {
								return Effect.void;
							}
							if (event.type === "session.llm.text.delta") {
								return Queue.offer(textDeltas, data.delta).pipe(Effect.asVoid);
							}
							return Effect.void;
						});
						yield* Effect.addFinalizer(() => removeDeltaListener);

						const storyPrompt =
							"Using every established detail about Velora, write a vivid story of exactly 100 words. Do not preface or explain it.";
						yield* control.prompt({ sessionId: session.id, prompt: { text: storyPrompt } });
						const firstTextDelta = yield* Queue.take(textDeltas).pipe(Effect.timeout("75 seconds"));
						yield* control.interrupt(session.id);
						const interruptedTerminal = yield* Queue.take(terminals).pipe(Effect.timeout("10 seconds"));

						expect(interruptedTerminal).toBe("failed");
						expect(Array.from(yield* control.active)).toEqual([]);
						const interruptedPath = yield* sessions.path(session.id);
						expect(interruptedPath.map((item) => item.entry.type)).toEqual(
							Array.from({ length: 12 }, (_, position) => (position % 2 === 0 ? "user" : "assistant")),
						);
						const aborted = yield* readLastAssistant();
						const abortedText = textOf(aborted);
						const abortedThinking = thinkingOf(aborted);
						expect(aborted.stopReason).toBe("aborted");
						expect(abortedText).toBe("");
						expect(abortedThinking).toBe("");

						const eventTypes = yield* eventTypesFor(sql)(session.id);
						expect(eventTypes.at(-1)?.type).toBe("session.llm.failed.1");
						yield* Effect.logInfo("live interrupted response", {
							turn: 6,
							user: storyPrompt,
							firstTextDelta,
							persistedThinking: abortedThinking,
							persistedText: abortedText,
							stopReason: aborted.stopReason,
							durableTerminal: eventTypes.at(-1)?.type,
						});

						const recoveryPrompt =
							"The previous generation was interrupted. In exactly five words, confirm that you can continue.";
						const recovered = yield* ask(recoveryPrompt);
						expect(recovered.stopReason).toBe("stop");

						const finalPath = yield* sessions.path(session.id);
						expect(finalPath.map((item) => item.entry.type)).toEqual(
							Array.from({ length: 14 }, (_, position) => (position % 2 === 0 ? "user" : "assistant")),
						);
						const snapshot = yield* context.assemble(session.id);
						expect(snapshot.messages).toHaveLength(13);
						expect(snapshot.messages.some((message) => message.messageId === aborted.messageId)).toBe(false);
						expect(snapshot.messages[12]).toMatchObject({ role: "assistant", stopReason: "stop" });

						const inputState = yield* inputStateFor(sql)(session.id);
						expect(inputState).toEqual({ count: 7, pending: 0 });
						const finalEventTypes = yield* eventTypesFor(sql)(session.id);
						expect(finalEventTypes).toHaveLength(34);
						expect(finalEventTypes.at(-1)?.type).toBe("session.turn.ended.1");
						yield* Effect.logInfo("live recovery response", {
							turn: 7,
							user: recoveryPrompt,
							assistant: textOf(recovered),
							pathEntries: finalPath.length,
							durableEvents: finalEventTypes.length,
						});
					}).pipe(Effect.scoped, Effect.provide(runtime)),
				),
		);
	});
