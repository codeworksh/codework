import "./utils/env.ts";
import { createAssistantMessageEventStream, type Model } from "@codeworksh/aikit";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { join } from "node:path";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import type { SharedPluginContext } from "../src/plugin/context.ts";
import { make } from "../src/plugin/registry.ts";
import * as Tool from "../src/tool/tool.ts";
import { pendingCall } from "./tools.fixture.ts";
import { assistant, immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";

const echo = (value: string) =>
	Tool.register(
		Tool.make({
			name: "echo",
			description: value,
			parameters: Schema.Struct({}),
			success: Schema.String,
			handler: () => Effect.succeed(value),
		}),
	);

describe("plugin domains and exchange host", () => {
	it("replaces tool and hooks together, patches prose, and closes retained buckets", async () => {
		const buckets = make();
		const tools = buckets.registry.tools;
		let stale = 0;
		tools.add(echo("first"), {
			beforeToolCall: () => {
				stale++;
				return { block: true };
			},
		});
		tools.add(echo("winner"));
		tools.update("echo", { description: "patched", promptGuidelines: ["one"] });
		expect(tools.list().map((t) => t.name)).toEqual(["echo"]);
		buckets.registry.prompt.set("");
		const snapshot = buckets.freeze();
		expect(snapshot.systemPrompt).toBe("");
		expect(snapshot.tools.defs[0]?.description).toBe("patched");
		expect(snapshot.tools.wire[0]?.description).toBe("patched");
		expect((await Effect.runPromise(snapshot.tools.handle(pendingCall("echo")))).status).toBe("completed");
		expect(stale).toBe(0);
		expect(() => tools.add(echo("late"))).toThrow();
		expect(() => tools.update("echo", { description: "late" })).toThrow();
		expect(() => buckets.registry.prompt.set("late")).toThrow();
	});
	it("requires a prompt string, preserves full replacement, and rejects unknown tool patches", () => {
		const empty = make();
		expect(empty.registry.prompt.get()).toBeUndefined();
		expect(() => empty.freeze()).toThrow("no prompt plugin set a system prompt");
		const buckets = make();
		buckets.registry.prompt.set("old");
		buckets.registry.prompt.set("new");
		expect(buckets.freeze().systemPrompt).toBe("new");
		expect(() => make().registry.tools.update("unknown", {})).toThrow("Unknown tool");
	});
	it("runs setup in declared order with a fresh context and pinned model each exchange", () =>
		withSettings(async ({ root }) => {
			const contexts: SharedPluginContext[] = [];
			const models: Model.Info[] = [];
			const observed: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({
						directory: root,
						systemPrompt: {
							custom: async (ctx) => `custom:${ctx.plugin.tools.list().length}`,
							append: () => "append",
						},
					});
					yield* session.run("first");
					yield* session.run("second");
					expect(contexts).toHaveLength(2);
					expect(contexts[0]).not.toBe(contexts[1]);
					expect(contexts[0]?.plugin).not.toBe(contexts[1]?.plugin);
					expect(contexts[0]?.model).toBe(models[0]);
					expect(contexts[1]?.model).toBe(models[1]);
					// The body belongs to `codework.prompt.default`; what the host owes is that both
					// slots were awaited against this exchange's bucket and the wrap saw the result.
					expect(observed).toHaveLength(2);
					expect(observed[0]).toBe(observed[1]);
					expect(observed[0]?.startsWith("custom:1\n\n")).toBe(true);
					expect(observed[0]).toContain("\n\nappend\n\n");
					expect(observed[0]?.endsWith("\nwrapped")).toBe(true);
					expect(contexts[0]?.events).not.toHaveProperty("subscribe");
					expect(() => contexts[0]?.plugin.prompt.set("late")).toThrow();
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: (input, signal) => {
								models.push(input.resolvedModel);
								observed.push(input.context.systemPrompt ?? "");
								return open(input, signal);
							},
							plugins: [
								{
									id: "acme.tool.echo",
									setup: (ctx) => {
										contexts.push(ctx);
										ctx.plugin.tools.add(echo("test"));
									},
								},
								"codework.prompt.default",
								{
									id: "acme.prompt.wrap",
									setup: async (ctx) => {
										await Promise.resolve();
										ctx.plugin.prompt.set(`${ctx.plugin.prompt.get()}\nwrapped`);
									},
								},
							],
						}),
					),
					Effect.scoped,
				),
			);
		}));
	it("lets prompt plugins observe only earlier tool registrations", () =>
		withSettings(async ({ root }) => {
			const prompts: string[] = [];
			const open = immediateOpen();
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.run("hello");
					expect(prompts).toEqual(["0"]);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: (input, signal) => {
								prompts.push(input.context.systemPrompt ?? "");
								return open(input, signal);
							},
							plugins: [
								{
									id: "acme.prompt.count",
									setup: (ctx) => ctx.plugin.prompt.set(String(ctx.plugin.tools.list().length)),
								},
								{ id: "acme.tool.echo", setup: (ctx) => ctx.plugin.tools.add(echo("test")) },
							],
						}),
					),
					Effect.scoped,
				),
			);
		}));
	it("runs no setup when preparation fails", () =>
		withSettings(async ({ root }) => {
			let setups = 0;
			const counted = {
				id: "acme.prompt.counted",
				setup: () => {
					setups++;
				},
			};
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.run("hello");
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: immediateOpen(),
							// A malformed entry after a valid one: nothing may run, not even the
							// definition that resolved.
							plugins: [counted, { id: "nope" } as never],
						}),
					),
					Effect.scoped,
					Effect.flip,
				),
			);
			expect(failure).toMatchObject({ _tag: "PluginPreparationError", phase: "definition", index: 1 });
			expect(setups).toBe(0);
		}));
	it("runs no setup when model resolution fails", () =>
		withSettings(async ({ root }) => {
			let setups = 0;
			await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({
						directory: root,
						model: { provider: "openai", id: "no-such-model" },
					});
					yield* session.run("hello");
					expect(setups).toBe(0);
					expect(yield* session.path()).toEqual([]);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [
								{
									id: "acme.prompt.count",
									setup: (ctx) => {
										setups++;
										ctx.plugin.prompt.set("");
									},
								},
							],
						}),
					),
					Effect.scoped,
				),
			);
		}));
	it("stops setup on failure and closes a retained context", () =>
		withSettings(async ({ root }) => {
			for (const failure of [
				() => {
					throw new Error("sync");
				},
				() => Promise.reject(new Error("async")),
				() => Effect.fail(new Error("effect")),
				() => Effect.die(new Error("defect")),
			]) {
				let retained: SharedPluginContext | undefined;
				let later = false;
				let requested = false;
				await Effect.runPromise(
					Effect.gen(function* () {
						const session = yield* Session.create({ directory: root });
						yield* session.run("hello");
						expect(later).toBe(false);
						expect(requested).toBe(false);
						expect(() => retained?.plugin.prompt.set("late")).toThrow();
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								llm: () => {
									requested = true;
									return Effect.never;
								},
								plugins: [
									{
										id: "acme.prompt.fail",
										setup: (ctx) => {
											retained = ctx;
											return failure();
										},
									},
									{
										id: "acme.prompt.later",
										setup: () => {
											later = true;
										},
									},
								],
							}),
						),
						Effect.scoped,
					),
				);
			}
		}));
	it("closes the bucket when async setup is cancelled", () =>
		withSettings(async ({ root }) => {
			let retained: SharedPluginContext | undefined;
			await Effect.runPromise(
				Effect.gen(function* () {
					const entered = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					yield* Effect.gen(function* () {
						const session = yield* Session.create({ directory: root });
						const fiber = yield* session.run("hello").pipe(Effect.forkChild);
						yield* Deferred.await(entered);
						yield* session.interrupt();
						yield* Fiber.join(fiber);
						expect(() => retained?.plugin.prompt.set("late")).toThrow();
						yield* Deferred.succeed(release, undefined);
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								llm: immediateOpen(),
								plugins: [
									{
										id: "acme.prompt.wait",
										setup: (ctx) => {
											retained = ctx;
											return Deferred.succeed(entered, undefined).pipe(
												Effect.andThen(Deferred.await(release)),
											);
										},
									},
								],
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped),
			);
		}));
});

describe("plugin pipelines in the kernel loop", () => {
	it.each(["sequential", "parallel"] as const)("schedules the complete pipeline in %s mode", (mode) =>
		withSettings(async ({ root }) => {
			const trace: string[] = [];
			await Effect.runPromise(
				Effect.gen(function* () {
					const firstAfter = yield* Deferred.make<void>();
					const secondAfter = yield* Deferred.make<void>();
					const release = yield* Deferred.make<void>();
					let requests = 0;
					const pipeline = Tool.register(
						Tool.make({
							name: "pipeline",
							description: "pipeline",
							parameters: Schema.Struct({ id: Schema.String }),
							success: Schema.String,
							handler: ({ id }) =>
								Effect.sync(() => {
									trace.push(`${id}:handler`);
									return id;
								}),
						}),
					);
					yield* Effect.gen(function* () {
						const session = yield* Session.create({ directory: root, tools: { execution: mode } });
						const run = yield* session.run("hello").pipe(Effect.forkChild);
						yield* Deferred.await(firstAfter);
						if (mode === "parallel") yield* Deferred.await(secondAfter);
						expect(trace.includes("b:handler")).toBe(mode === "parallel");
						yield* Deferred.succeed(release, undefined);
						yield* Fiber.join(run);
						for (const id of ["a", "b"])
							expect(trace.filter((item) => item.startsWith(id))).toEqual([
								`${id}:before`,
								`${id}:handler`,
								`${id}:after`,
								`${id}:done`,
							]);
						if (mode === "sequential") expect(trace.indexOf("a:done")).toBeLessThan(trace.indexOf("b:before"));
						const path = yield* session.path();
						expect(path).toHaveLength(3);
					}).pipe(
						Effect.provide(
							Harness.layer({
								home: join(root, "home"),
								database: ":memory:",
								plugins: [
									{
										id: "acme.tool.pipeline",
										setup: (ctx) =>
											ctx.plugin.tools.add(pipeline, {
												beforeToolCall: ({ callID }) => {
													trace.push(`${callID}:before`);
												},
												afterToolCall: ({ callID }) =>
													Effect.gen(function* () {
														trace.push(`${callID}:after`);
														yield* Deferred.succeed(callID === "a" ? firstAfter : secondAfter, undefined);
														yield* Deferred.await(release);
														trace.push(`${callID}:done`);
													}),
											}),
									},
									"codework.prompt.default",
								],
								llm: (input) =>
									Effect.sync(() => {
										requests++;
										const first = requests === 1;
										const message = assistant(
											input,
											requests,
											first
												? {
														stopReason: "toolUse",
														parts: [
															pendingCall("pipeline", { id: "a" }, "a"),
															pendingCall("pipeline", { id: "b" }, "b"),
														],
													}
												: {},
										);
										const stream = createAssistantMessageEventStream();
										stream.push({ type: "start", partial: message });
										stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
										return stream;
									}),
							}),
						),
						Effect.scoped,
					);
				}).pipe(Effect.scoped),
			);
		}),
	);
});
