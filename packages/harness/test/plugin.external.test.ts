import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { EventSchema } from "../src/event/schema.ts";
import { prepare } from "../src/plugin/catalog.ts";
import type { LLM } from "../src/runner/llm.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { assistant, immediateOpen } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * Third-party plugins as they exist in production: plain `.mjs` modules loaded by
 * path or directory, written against the structural contract rather than the SDK
 * types. Every scenario below goes through the real import, never the seams.
 */
const dir = fileURLToPath(new URL("./plugins", import.meta.url));
const pluginPath = (name: string) => join(dir, name);

/** First request asks for the calls, every request after stops. */
const toolTurn = (...calls: ReadonlyArray<Message.ToolCallPendingPart>): LLM.Open => {
	let index = 0;
	return (input) =>
		Effect.sync(() => {
			index += 1;
			const first = index === 1;
			const message = assistant(input, index, first ? { stopReason: "toolUse", parts: [...calls] } : {});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
			return stream;
		});
};

/** One `Session.create` + one `run`, capturing every provider request. */
const exchange = (input: {
	readonly root: string;
	readonly plugins: ReadonlyArray<string>;
	readonly llm?: LLM.Open;
	readonly prompt?: string;
}) => {
	const contexts: Message.Context[] = [];
	const prompts: string[] = [];
	const open = input.llm ?? immediateOpen();
	return Effect.gen(function* () {
		const session = yield* Session.create({ directory: input.root });
		yield* session.run(input.prompt ?? "hello");
		// Read inside the scope: the memory database closes with the layer.
		const path = yield* session.path();
		return { contexts, prompts, path } as const;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(input.root, "home"),
				database: ":memory:",
				llm: (request, signal) => {
					contexts.push(request.context);
					prompts.push(request.context.systemPrompt ?? "");
					return open(request, signal);
				},
				plugins: input.plugins,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);
};

describe("third-party plugins", () => {
	it("loads a directory package and a single file through real imports", async () => {
		const plugins = await Effect.runPromise(
			prepare([pluginPath("acme-echo"), `file://${pluginPath("acme-prompt.mjs")}`], {
				builtins: [],
				cache: "/unused",
				hostCwd: "/project",
			}),
		);
		expect(plugins.map((plugin) => plugin.id)).toEqual(["acme.tool.echo", "acme.prompt.marker"]);
	});

	it("rejects a malformed module and a reserved namespace through real imports", async () => {
		const failure = await Effect.runPromise(
			prepare([pluginPath("acme-broken.mjs")], {
				builtins: [],
				cache: "/unused",
				hostCwd: "/project",
			}).pipe(Effect.flip),
		);
		expect(failure).toMatchObject({ _tag: "PluginPreparationError", phase: "definition", index: 0 });
	});

	it("runs a package tool through the loop, with its after hook applied", () =>
		withSettings(async ({ root }) => {
			const { contexts, prompts, path } = await exchange({
				root,
				plugins: [pluginPath("acme-echo"), "codework.prompt.default"],
				llm: toolTurn(pendingCall("acme_echo", { value: "hello" }, "call_echo")),
			});
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["acme_echo"]);
			expect(prompts[0]).toContain("- acme_echo: Echo a value back");

			expect(path.map((item) => item.entry.type)).toEqual(["user", "assistant", "assistant"]);
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({
				status: "completed",
				result: {
					content: [
						{ type: "text", text: "hello" },
						{ type: "text", text: "(acme-checked)" },
					],
					isError: false,
				},
			});
			// The continuation request carries the terminal part, not a pending one.
			const continued = contexts[1]?.messages.at(-1)?.parts.find((part) => part.type === "toolCall");
			expect(continued).toMatchObject({ callID: "call_echo", status: "completed" });
		}));

	it("blocks a denied call without running the handler, and settles the rest", () =>
		withSettings(async ({ root }) => {
			const { path } = await exchange({
				root,
				plugins: [pluginPath("acme-guarded.mjs"), "codework.prompt.default"],
				llm: toolTurn(
					pendingCall("acme_secret", { value: "deny" }, "call_blocked"),
					pendingCall("acme_secret", { value: "allow" }, "call_allowed"),
				),
			});
			const parts = (path[1]?.parts ?? []).map((part) => JSON.parse(part.data));
			const blocked = parts.find((part) => part.callID === "call_blocked");
			const allowed = parts.find((part) => part.callID === "call_allowed");
			expect(blocked).toMatchObject({
				status: "error",
				result: { content: [{ type: "text", text: "denied by acme policy" }], isError: true },
			});
			expect(allowed).toMatchObject({
				status: "completed",
				result: { content: [{ type: "text", text: "classified:allow" }], isError: false },
			});
		}));

	it("replaces the built-in bash tool by name", () =>
		withSettings(async ({ root }) => {
			const { prompts, path } = await exchange({
				root,
				plugins: ["codework.tool.bash", pluginPath("acme-bash-override.mjs"), "codework.prompt.default"],
				llm: toolTurn(pendingCall("bash", { command: "echo hi" }, "call_bash")),
			});
			expect(prompts[0]).toContain("- bash: Run a command through the acme shell");
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({
				status: "completed",
				result: { content: [{ type: "text", text: "acme-override:echo hi" }] },
			});
		}));

	it("composes a prompt plugin over the default, after tool contributors", () =>
		withSettings(async ({ root }) => {
			const { prompts } = await exchange({
				root,
				plugins: [pluginPath("acme-echo"), "codework.prompt.default", pluginPath("acme-prompt.mjs")],
			});
			expect(prompts[0]).toContain("You are an expert coding assistant");
			expect(prompts[0]).toContain("- acme_echo: Echo a value back");
			expect(prompts[0]?.endsWith("\n\nacme-marker")).toBe(true);
		}));

	it("publishes plugin-owned durable and ephemeral events", () =>
		withSettings(async ({ root }) => {
			const seen: string[] = [];
			const Marker = EventSchema.define({
				type: "acme.journal.marker",
				durable: { aggregate: "sessionId", version: 1 },
				schema: { sessionId: SessionSchema.ID, note: Schema.String },
			});
			const { rows, sessionId } = await Effect.runPromise(
				Effect.gen(function* () {
					const events = yield* Event.Service;
					yield* events.listen((event) => Effect.sync(() => void seen.push(event.type)));
					const session = yield* Session.create({ directory: root });
					yield* session.run("hello");
					// The row lands on the session aggregate; the kernel manifest skips it,
					// the plugin's own definitions decode it. Read inside the scope: the
					// memory database closes with the layer.
					const rows = Array.from(
						yield* events
							.log({ aggregateId: session.id, definitions: EventSchema.durable([Marker]) })
							.pipe(Stream.runCollect),
					);
					return { rows, sessionId: session.id };
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("acme-journal.mjs"), "codework.prompt.default"],
						}),
					),
					Effect.scoped,
				),
			);
			expect(seen).toContain("acme.ready");
			const marker = rows.find((item) => !Event.isSynced(item));
			expect(marker).toMatchObject({
				type: "acme.journal.marker",
				durable: { aggregateId: sessionId, seq: expect.any(Number), version: 1 },
				data: { sessionId, note: "acme was here" },
			});
		}));

	it("attributes a setup throw to the plugin id and never reaches the model", () =>
		withSettings(async ({ root }) => {
			const contexts: Message.Context[] = [];
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.prompt("hello");
					return yield* session.resume().pipe(Effect.flip);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: (request, signal) => {
								contexts.push(request.context);
								return immediateOpen()(request, signal);
							},
							plugins: [pluginPath("acme-throws.mjs"), "codework.prompt.default"],
						}),
					),
					Effect.scoped,
				),
			);
			expect(failure).toMatchObject({
				_tag: "State.SnapshotError",
				cause: { _tag: "Plugin.SetupError", pluginId: "acme.setup.throws" },
			});
			expect(contexts).toEqual([]);
		}));

	it("attributes a malformed tool registration to the plugin at setup", () =>
		withSettings(async ({ root }) => {
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.prompt("hello");
					return yield* session.resume().pipe(Effect.flip);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("acme-bad-tool.mjs"), "codework.prompt.default"],
						}),
					),
					Effect.scoped,
				),
			);
			expect(failure).toMatchObject({
				_tag: "State.SnapshotError",
				cause: { _tag: "Plugin.SetupError", pluginId: "acme.tool.malformed" },
			});
		}));

	it("fails harness construction with the preparation error", () =>
		withSettings(async ({ root }) => {
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					yield* Session.create({ directory: root });
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("acme-broken.mjs")],
						}),
					),
					Effect.scoped,
					Effect.flip,
				),
			);
			expect(failure).toMatchObject({ _tag: "PluginPreparationError", phase: "definition" });
		}));

	it("relabels an overridden tool on the winner, keeping its hooks", () =>
		withSettings(async ({ root }) => {
			// acme-echo registers acme_echo with an after hook; a later plugin patches only
			// its prose. The wire description changes, the winner's hook still fires, and the
			// default prompt (placed after both) indexes the patched description.
			const { contexts, prompts, path } = await exchange({
				root,
				plugins: [pluginPath("acme-echo"), pluginPath("acme-relabel.mjs"), "codework.prompt.default"],
				llm: toolTurn(pendingCall("acme_echo", { value: "hi" }, "call_echo")),
			});
			expect(contexts[0]?.tools?.[0]).toMatchObject({ name: "acme_echo", description: "Echo, relabelled by acme" });
			expect(prompts[0]).toContain("- acme_echo: Echo a value back");
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled.result.content).toEqual([
				{ type: "text", text: "hi" },
				{ type: "text", text: "(acme-checked)" },
			]);
		}));

	it("lets interruption end an exchange stuck in a plugin's setup", () =>
		withSettings(async ({ root }) => {
			const contexts: Message.Context[] = [];
			const exit = await Effect.runPromise(
				Effect.gen(function* () {
					const session = yield* Session.create({ directory: root });
					yield* session.prompt("hello");
					const running = yield* session.resume().pipe(Effect.forkChild);
					// Give the drain time to reach setup and block there, then pull the plug.
					yield* Effect.sleep("100 millis");
					yield* session.interrupt();
					return yield* Fiber.await(running);
				}).pipe(
					Effect.provide(
						Harness.layer({
							home: join(root, "home"),
							database: ":memory:",
							llm: (request, signal) => {
								contexts.push(request.context);
								return immediateOpen()(request, signal);
							},
							plugins: [pluginPath("acme-hangs.mjs"), "codework.prompt.default"],
						}),
					),
					Effect.scoped,
					Effect.timeout("5 seconds"),
				),
			);
			expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
			expect(contexts).toEqual([]);
		}));

	it("honours a disabled built-in end to end", () =>
		withSettings(async ({ root }) => {
			const { contexts, prompts, path } = await exchange({
				root,
				plugins: ["codework.tool.bash", "!codework.tool.bash", "codework.prompt.default"],
				llm: toolTurn(pendingCall("bash", { command: "echo hi" }, "call_bash")),
			});
			expect(contexts[0]?.tools).toEqual([]);
			expect(prompts[0]).toContain("Available tools:\n(none)");
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({ status: "error", result: { isError: true } });
			expect(settled.result.content[0].text).toContain("Unknown tool: bash");
		}));
});
