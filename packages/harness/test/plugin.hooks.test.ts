import { Cause, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import { make } from "../src/tools/executor.ts";
import { ToolProgress } from "../src/tools/progress.ts";
import * as Tool from "../src/tools/tool.ts";
import type { ToolAddOptions, ToolAfter } from "../src/plugin/tool/schema.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { SessionMessageSchema } from "../src/session/message/schema.ts";
import { pendingCall } from "./tools.fixture.ts";
import { it } from "./utils/effect.ts";

const options = { sessionId: SessionSchema.ID.create(), messageId: SessionMessageSchema.ID.create() };
const call = pendingCall("echo", { value: "hello" });
const tool = (handler: () => Effect.Effect<string, Error> = () => Effect.succeed("hello")) =>
	Tool.register(
		Tool.make({
			name: "echo",
			description: "Echo",
			parameters: Schema.Struct({ value: Schema.String }),
			success: Schema.String,
			encodeContent: (text: string) => [{ type: "text", text }],
			handler,
		}),
	);
const executor = (hooks: ToolAddOptions, handler?: () => Effect.Effect<string, Error>) =>
	make([{ tool: tool(handler), hooks }]);

describe("per-tool hooks", () => {
	it.effect("runs decoded before, handler cleanup, and encoded after in order", () =>
		Effect.gen(function* () {
			const trace: string[] = [];
			const afters: ToolAfter[] = [];
			const run = executor(
				{
					beforeToolCall: async (input) => {
						expect(input).toMatchObject({
							...options,
							params: { value: "hello" },
							rawArgs: { value: "hello" },
							toolName: "echo",
							callID: call.callID,
						});
						trace.push("before");
					},
					afterToolCall: (input) => {
						trace.push("after");
						afters.push(input);
						return { content: [], details: null, isError: true };
					},
				},
				() =>
					Effect.sync(() => {
						trace.push("handler");
						return "hello";
					}).pipe(
						Effect.ensuring(
							Effect.sync(() => {
								trace.push("cleanup");
							}),
						),
					),
			);
			const result = yield* run.handle(call, options);
			expect(trace).toEqual(["before", "handler", "cleanup", "after"]);
			expect(afters[0]?.terminal).toMatchObject({
				status: "completed",
				result: { content: [{ type: "text", text: "hello" }], isError: false },
			});
			expect(result).toMatchObject({
				callID: call.callID,
				arguments: call.arguments,
				status: "error",
				result: { content: [], details: null, isError: true },
			});
		}),
	);
	it.effect("skips hooks for unknown or invalid calls and skips handler/after when blocked", () =>
		Effect.gen(function* () {
			const trace: string[] = [];
			const run = executor(
				{
					beforeToolCall: () => {
						trace.push("before");
						return { block: true, reason: "Denied" };
					},
					afterToolCall: () => {
						trace.push("after");
					},
				},
				() =>
					Effect.sync(() => {
						trace.push("handler");
						return "hello";
					}),
			);
			expect((yield* run.handle(pendingCall("missing"), options)).status).toBe("error");
			expect((yield* run.handle(pendingCall("echo"), options)).status).toBe("error");
			expect(trace).toEqual([]);
			expect(yield* run.handle(call, options)).toMatchObject({
				status: "error",
				result: { content: [{ type: "text", text: "Denied" }] },
			});
			expect(trace).toEqual(["before"]);
		}),
	);
	it.effect("normalizes thrown, rejected and Effect hook failures", () =>
		Effect.gen(function* () {
			for (const beforeToolCall of [
				() => {
					throw new Error("sync");
				},
				() => Promise.reject(new Error("promise")),
				() => Effect.fail(new Error("effect")),
			]) {
				expect((yield* executor({ beforeToolCall }).handle(call, options)).status).toBe("error");
			}
			expect(
				(yield* executor({
					afterToolCall: () => {
						throw new Error("after");
					},
				}).handle(call, options)).status,
			).toBe("error");
		}),
	);
	it.effect("passes undeclared handler errors and encoder defects to after for recovery", () =>
		Effect.gen(function* () {
			for (const handler of [
				() => Effect.fail(new Error("failed")),
				() => Effect.die(new Error("defect")),
				() => {
					throw new Error("thrown");
				},
			]) {
				const result = yield* executor(
					{
						afterToolCall: ({ terminal }) => {
							expect(terminal.status).toBe("error");
							return { isError: false };
						},
					},
					handler,
				).handle(call, options);
				expect(result).toMatchObject({ status: "completed", result: { isError: false } });
			}
			const broken = Tool.register(
				Tool.make({
					name: "echo",
					description: "broken encoder",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					handler: () => Effect.succeed("ok"),
					encodeContent: () => {
						throw new Error("encode");
					},
				}),
			);
			let seen = false;
			const result = yield* make([
				{
					tool: broken,
					hooks: {
						afterToolCall: ({ terminal }) => {
							seen = true;
							expect(terminal.status).toBe("error");
						},
					},
				},
			]).handle(call, options);
			expect(seen).toBe(true);
			expect(result.status).toBe("error");
		}),
	);
	it.effect("cancelling before skips handler and after", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			let count = 0;
			const run = executor(
				{
					beforeToolCall: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
					afterToolCall: () => {
						count++;
					},
				},
				() =>
					Effect.sync(() => {
						count++;
						return "ok";
					}),
			);
			const fiber = yield* run.handle(call, options).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(fiber);
			expect(count).toBe(0);
		}),
	);
	it.effect("notifies aborted once with partial output and ignores patches", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const observed: ToolAfter[] = [];
			const streaming = Tool.register(
				Tool.make({
					name: "echo",
					description: "stream",
					parameters: Schema.Struct({ value: Schema.String }),
					success: Schema.String,
					handler: () =>
						Effect.gen(function* () {
							const progress = yield* ToolProgress;
							yield* progress.report({ content: [{ type: "text", text: "partial" }], details: { part: 1 } });
							yield* Deferred.succeed(entered, undefined);
							return yield* Effect.never;
						}),
				}),
			);
			const run = make([
				{
					tool: streaming,
					hooks: {
						afterToolCall: (input) => {
							observed.push(input);
							return { isError: false, content: [] };
						},
					},
				},
			]);
			const fiber = yield* run.handle(call, options).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(fiber);
			expect(observed).toHaveLength(1);
			expect(observed[0]?.terminal).toMatchObject({
				status: "aborted",
				result: { content: [{ type: "text", text: "partial" }], details: { part: 1 } },
			});
			const exit = yield* Fiber.await(fiber);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		}),
	);
	it.effect("times out cooperative abort notification and runs its finalizer", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			const afterEntered = yield* Deferred.make<void>();
			let finalized = false;
			const run = executor(
				{
					afterToolCall: () =>
						Deferred.succeed(afterEntered, undefined).pipe(
							Effect.andThen(Effect.never),
							Effect.ensuring(
								Effect.sync(() => {
									finalized = true;
								}),
							),
						),
				},
				() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
			);
			const fiber = yield* run.handle(call, options).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
			yield* Deferred.await(afterEntered);
			yield* TestClock.adjust("1 second");
			yield* Fiber.join(interrupt);
			expect(finalized).toBe(true);
		}),
	);
	it.effect("interrupts normal after without invoking it again for abort", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			let count = 0;
			const run = executor({
				afterToolCall: () =>
					Effect.gen(function* () {
						count++;
						yield* Deferred.succeed(entered, undefined);
						yield* Effect.never;
					}),
			});
			const fiber = yield* run.handle(call, options).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(fiber);
			expect(count).toBe(1);
		}),
	);
	it.effect("preserves interruption mixed with failing handler cleanup", () =>
		Effect.gen(function* () {
			const entered = yield* Deferred.make<void>();
			let status: string | undefined;
			const run = executor(
				{
					afterToolCall: ({ terminal }) => {
						status = terminal.status;
					},
				},
				() =>
					Deferred.succeed(entered, undefined).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(Effect.die(new Error("cleanup"))),
					),
			);
			const fiber = yield* run.handle(call, options).pipe(Effect.forkChild);
			yield* Deferred.await(entered);
			yield* Fiber.interrupt(fiber);
			const exit = yield* Fiber.await(fiber);
			expect(status).toBe("aborted");
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		}),
	);
});
