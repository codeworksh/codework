import { createAssistantMessageEventStream } from "@codeworksh/aikit";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Sandbox } from "../src/effect/sandbox.ts";
import { Event } from "../src/event/event.ts";
import { LLM } from "../src/runner/llm.ts";
import * as Tool from "../src/tools/tool.ts";
import { assistant } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const file = (dir: string, thinkingLevel: string) =>
	writeFile(
		join(dir, "settings.json"),
		JSON.stringify({ model: { thinkingLevel, options: { headers: { revision: thinkingLevel } } } }),
	);

const terminal = (input: LLM.Input, index: number, tool = false) => {
	const message = assistant(
		input,
		index,
		tool
			? {
					stopReason: "toolUse",
					parts: [
						{
							type: "toolCall",
							callID: "wait",
							name: "wait",
							arguments: {},
							status: "pending",
							time: { start: 1, end: 1 },
						},
					],
				}
			: {},
	);
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "start", partial: message });
	stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message });
	return stream;
};

describe("settings at exchange boundaries", () => {
	it("pins settings through a blocked request, tool continuation and steer; refreshes follow-up and idle prompts", () =>
		withSettings(async ({ root, custom, local }) => {
			await file(custom, "low");
			// This belongs to the session directory, not host startup, and must not be loaded.
			await file(local, "max");
			const inputs: LLM.Input[] = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const requestEntered = yield* Deferred.make<void>();
					const requestRelease = yield* Deferred.make<void>();
					const toolEntered = yield* Deferred.make<void>();
					const toolRelease = yield* Deferred.make<void>();
					const wait = Tool.register(
						Tool.make({
							name: "wait",
							description: "Wait for test",
							parameters: Schema.Struct({}),
							success: Schema.String,
							encodeContent: (text: string) => [{ type: "text", text }],
							handler: () =>
								Deferred.succeed(toolEntered, undefined).pipe(
									Effect.andThen(Deferred.await(toolRelease)),
									Effect.as("ready"),
								),
						}),
					);
					const open: LLM.Open = Effect.fn(function* (input) {
						inputs.push(input);
						const index = inputs.length;
						if (index === 1) {
							yield* Deferred.succeed(requestEntered, undefined);
							yield* Deferred.await(requestRelease);
						}
						return terminal(input, index, index === 1);
					});
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [], extras: [wait] } });
						yield* handle.prompt("first");
						yield* Deferred.await(requestEntered);
						yield* Effect.promise(() => file(custom, "medium"));
						yield* Deferred.succeed(requestRelease, undefined);
						yield* Deferred.await(toolEntered);
						yield* Effect.promise(() => file(custom, "high"));
						yield* handle.prompt({ text: "steer", delivery: "steer" });
						yield* handle.prompt({ text: "later", delivery: "followUp" });
						yield* Deferred.succeed(toolRelease, undefined);
						yield* handle.wait();
						expect(inputs.map((input) => input.thinkingLevel)).toEqual(["low", "low", "high"]);
						expect(inputs.map((input) => input.options?.headers?.revision)).toEqual(["low", "low", "high"]);
						expect(inputs[1]?.context.systemPrompt).toBe(inputs[0]?.context.systemPrompt);
						yield* Effect.promise(() => file(custom, "off"));
						yield* handle.run("idle steer");
						expect(inputs.at(-1)?.thinkingLevel).toBe("off");
						// A virtual sandbox uses the same host settings, without any virtual settings file.
						const sandbox = yield* Sandbox.create({ driver: "memory" });
						const virtual = yield* Session.create({ sandbox, tools: { builtins: [] } });
						yield* virtual.run("virtual");
						expect(inputs.at(-1)?.thinkingLevel).toBe("off");
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("pins matching parallel tool execution through continuations and refreshes it next exchange", () =>
		withSettings(async ({ root, custom }) => {
			const configure = (toolExecution: string) =>
				writeFile(
					join(custom, "settings.json"),
					JSON.stringify({
						model: { toolExecution: "sequential", providerOptions: { openai: { "*": { toolExecution } } } },
					}),
				);
			await configure("parallel");
			await Effect.runPromise(
				Effect.gen(function* () {
					const gates = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
					const starts = [0, 0, 0];
					const trace: string[] = [];
					let request = 0;
					const pair = Tool.register(
						Tool.make({
							name: "pair",
							description: "Check tool scheduling",
							parameters: Schema.Struct({ batch: Schema.Number }),
							success: Schema.String,
							encodeContent: (text: string) => [{ type: "text", text }],
							handler: ({ batch }) =>
								Effect.gen(function* () {
									starts[batch] = (starts[batch] ?? 0) + 1;
									trace.push(`${batch}:start`);
									if (batch === 0 && starts[batch] === 1) yield* Effect.promise(() => configure("sequential"));
									const gate = gates[batch];
									if (gate !== undefined) {
										// A sequential scheduler deadlocks here: both calls must enter before either finishes.
										if (starts[batch] === 2) yield* Deferred.succeed(gate, undefined);
										yield* Deferred.await(gate);
									}
									yield* Effect.yieldNow;
									trace.push(`${batch}:end`);
									return "ready";
								}),
						}),
					);
					const open: LLM.Open = (input) =>
						Effect.sync(() => {
							request += 1;
							const batch = request === 1 ? 0 : request === 2 ? 1 : request === 4 ? 2 : undefined;
							if (batch === undefined) return terminal(input, request);
							const message = assistant(input, request, {
								stopReason: "toolUse",
								parts: [0, 1].map((id) => ({
									type: "toolCall" as const,
									callID: `pair-${batch}-${id}`,
									name: "pair",
									arguments: { batch },
									status: "pending" as const,
									time: { start: 1, end: 1 },
								})),
							});
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: "toolUse", message });
							return stream;
						});
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [], extras: [pair] } });
						yield* handle.run("parallel, including continuation");
						yield* handle.run("fresh sequential");
						expect(starts).toEqual([2, 2, 2]);
						expect(trace.filter((item) => item.startsWith("2:"))).toEqual([
							"2:start",
							"2:end",
							"2:start",
							"2:end",
						]);
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("captures fresh settings after interruption and resume", () =>
		withSettings(async ({ root, custom }) => {
			await file(custom, "low");
			const inputs: LLM.Input[] = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const open: LLM.Open = (input, signal) =>
						Effect.sync(() => {
							inputs.push(input);
							if (inputs.length > 1) return terminal(input, inputs.length);
							const stream = createAssistantMessageEventStream();
							stream.push({ type: "start", partial: assistant(input, 1) });
							const abort = () =>
								stream.push({
									type: "error",
									reason: "aborted",
									error: assistant(input, 1, { stopReason: "aborted", errorMessage: "Interrupted" }),
								});
							if (signal.aborted) abort();
							else signal.addEventListener("abort", abort, { once: true });
							return stream;
						});
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [] } });
						const events = yield* Event.Service;
						yield* events.listen((event) =>
							event.type === "session.llm.started"
								? Deferred.succeed(entered, undefined).pipe(Effect.asVoid)
								: Effect.void,
						);
						const running = yield* handle.run("first").pipe(Effect.forkScoped);
						yield* Deferred.await(entered);
						yield* handle.interrupt();
						yield* Fiber.join(running);
						expect(yield* handle.active).toBe(false);
						yield* Effect.promise(() => file(custom, "high"));
						yield* handle.resume();
						expect(inputs.map((input) => input.thinkingLevel)).toEqual(["low", "high"]);
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("applies a session binding change at the next capture, not inside the running exchange", () =>
		withSettings(async ({ root, custom }) => {
			await file(custom, "low");
			const inputs: LLM.Input[] = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const toolEntered = yield* Deferred.make<void>();
					const toolRelease = yield* Deferred.make<void>();
					const wait = Tool.register(
						Tool.make({
							name: "wait",
							description: "Wait for test",
							parameters: Schema.Struct({}),
							success: Schema.String,
							encodeContent: (text: string) => [{ type: "text", text }],
							handler: () =>
								Deferred.succeed(toolEntered, undefined).pipe(
									Effect.andThen(Deferred.await(toolRelease)),
									Effect.as("ready"),
								),
						}),
					);
					const open: LLM.Open = (input) =>
						Effect.sync(() => {
							inputs.push(input);
							return terminal(input, inputs.length, inputs.length === 1);
						});
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [], extras: [wait] } });
						yield* handle.prompt("first");
						yield* Deferred.await(toolEntered);
						// A binding set mid-exchange must not disturb the snapshot already pinned.
						yield* Session.attach({ sessionId: handle.id, thinkingLevel: "max" });
						yield* Deferred.succeed(toolRelease, undefined);
						yield* handle.wait();
						expect(inputs.map((input) => input.thinkingLevel)).toEqual(["low", "low"]);
						yield* handle.run("second");
						// The next capture reads it, and a binding outranks the file.
						expect(inputs.at(-1)?.thinkingLevel).toBe("max");
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("rereads files on restart and does not restore process-local overrides", () =>
		withSettings(async ({ root, custom }) => {
			await file(custom, "low");
			const inputs: LLM.Input[] = [];
			const open: LLM.Open = (input) =>
				Effect.sync(() => {
					inputs.push(input);
					return terminal(input, inputs.length);
				});
			const database = join(root, "sessions.db");
			const runtime = () => Harness.layer({ home: join(root, "home"), database, agentConfigDir: custom, llm: open });
			await Effect.runPromise(
				Effect.gen(function* () {
					const sessionId = yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [] } });
						// A binding is process-local; the file is not.
						yield* Session.attach({ sessionId: handle.id, thinkingLevel: "max" });
						yield* handle.run("first");
						expect(inputs.at(-1)?.thinkingLevel).toBe("max");
						return handle.id;
					}).pipe(Effect.provide(runtime()), Effect.scoped);

					yield* Effect.promise(() => file(custom, "medium"));

					yield* Effect.gen(function* () {
						const handle = yield* Session.attach({ sessionId });
						yield* handle.run("second");
						// The binding is gone with the old process; the edited file is read again.
						expect(inputs.at(-1)?.thinkingLevel).toBe("medium");
						expect(inputs.at(-1)?.options?.headers?.revision).toBe("medium");
					}).pipe(Effect.provide(runtime()), Effect.scoped);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("keeps turn failure behavior for an unselectable model and picks up a corrected selection", () =>
		withSettings(async ({ root, custom }) => {
			const select = (provider: string, id: string) =>
				writeFile(join(custom, "settings.json"), JSON.stringify({ model: { provider, id } }));
			await select("openai", "no-such-model");
			const inputs: LLM.Input[] = [];
			const open: LLM.Open = (input, signal) => {
				inputs.push(input);
				return input.model === "no-such-model"
					? LLM.open(input, signal)
					: Effect.sync(() => terminal(input, inputs.length));
			};
			await Effect.runPromise(
				Effect.gen(function* () {
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [] } });
						yield* handle.run("first");
						// The lookup fails before a draft exists, so the prompt is left unanswered.
						expect((yield* handle.path()).map(({ entry }) => [entry.type, entry.state])).toEqual([
							["user", "committed"],
						]);
						expect(inputs.at(-1)?.model).toBe("no-such-model");

						yield* Effect.promise(() => select("openai", "gpt-5.6-luna"));
						yield* handle.resume();
						expect(inputs.at(-1)?.model).toBe("gpt-5.6-luna");
						const answered = yield* handle.path();
						expect(answered.filter(({ entry }) => entry.type === "user")).toHaveLength(1);
						expect(answered.at(-1)?.entry.type).toBe("assistant");
						expect(answered.at(-1)?.entry.state).toBe("committed");
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));

	it("tracks a settings file edited forward and reverted across successive runs", () =>
		withSettings(async ({ root, custom }) => {
			const write = (model: object) => writeFile(join(custom, "settings.json"), JSON.stringify({ model }));
			// A carries a header and a retry count that B does not mention at all.
			const A = { thinkingLevel: "low", options: { maxRetries: 7, headers: { only: "a" } } };
			const B = { thinkingLevel: "high", options: { headers: { shared: "b" } } };
			const inputs: LLM.Input[] = [];
			await write(A);
			await Effect.runPromise(
				Effect.gen(function* () {
					const open: LLM.Open = (input) =>
						Effect.sync(() => {
							inputs.push(input);
							return terminal(input, inputs.length);
						});
					yield* Effect.gen(function* () {
						const handle = yield* Session.create({ directory: root, tools: { builtins: [] } });

						yield* handle.run("with A");
						expect(inputs.at(-1)?.thinkingLevel).toBe("low");
						expect(inputs.at(-1)?.options?.headers).toEqual({ only: "a" });
						expect(inputs.at(-1)?.options?.maxRetries).toBe(7);

						yield* Effect.promise(() => write(B));
						yield* handle.run("with B");
						expect(inputs.at(-1)?.thinkingLevel).toBe("high");
						// A's header and retry count are gone, not merged forward.
						expect(inputs.at(-1)?.options?.headers).toEqual({ shared: "b" });
						expect(inputs.at(-1)?.options?.maxRetries).toBe(2);

						yield* Effect.promise(() => write(A));
						yield* handle.run("back to A");
						expect(inputs.at(-1)?.thinkingLevel).toBe("low");
						// And B leaves nothing behind on the way back.
						expect(inputs.at(-1)?.options?.headers).toEqual({ only: "a" });
						expect(inputs.at(-1)?.options?.maxRetries).toBe(7);
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								agentConfigDir: custom,
								llm: open,
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped, Effect.timeout("10 seconds")),
			);
		}));
});
