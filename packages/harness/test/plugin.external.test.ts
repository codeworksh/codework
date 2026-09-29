import "./utils/env.ts";
import type { Message } from "@codeworksh/aikit";
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { EventSchema } from "../src/event/schema.ts";
import type { PluginRef } from "../src/plugin/catalog.ts";
import { fallback } from "../src/plugin/prompt/registry.ts";
import type { LLM } from "../src/runner/llm.ts";
import { SessionSchema } from "../src/session/schema.ts";
import { bashPlugin } from "../src/plugin/builtin/tool/bash.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { immediateOpen, toolTurn } from "./fixtures/llm.ts";
import { withSettings } from "./fixtures/settings.ts";
import { pendingCall } from "./tools.fixture.ts";

/**
 * Third-party plugins as they exist in production: TypeScript modules loaded by
 * path or directory, using the plugin and tool contracts. Every scenario below goes through the real import, never the seams.
 */
const dir = fileURLToPath(new URL("./plugins", import.meta.url));
const pluginPath = (name: string) => join(dir, name);

/** One `Session.create` + one `run`, capturing every provider request. */
const exchange = (input: {
	readonly root: string;
	/** The host directory the session is linked to; its project settings are found from here. */
	readonly hostDir?: string;
	readonly plugins?: ReadonlyArray<PluginRef>;
	readonly userConfigDir?: string;
	readonly llm?: LLM.Open;
	readonly prompt?: string;
}) => {
	const contexts: Message.Context[] = [];
	const prompts: string[] = [];
	const open = input.llm ?? immediateOpen();
	return Effect.gen(function* () {
		// The session is linked to the project under test through `hostDir`, which is where its
		// settings come from. Its local sandbox works in `root` (`cwd`), which configures nothing.
		const session = yield* Session.create({ directory: input.root, hostDir: input.hostDir ?? input.root });
		yield* session.run(input.prompt ?? "hello");
		// Read inside the scope: the memory database closes with the layer.
		const path = yield* session.path();
		return { contexts, prompts, path } as const;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(input.root, "home"),
				// The app runs from `root`. That is only ever the process's directory, never where a
				// session's project settings are discovered from.
				hostCwd: input.root,
				database: ":memory:",
				llm: (request, signal) => {
					contexts.push(request.context);
					prompts.push(request.context.systemPrompt ?? "");
					return open(request, signal);
				},
				...(input.plugins === undefined ? {} : { plugins: input.plugins }),
				...(input.userConfigDir === undefined ? {} : { userConfigDir: input.userConfigDir }),
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);
};

describe("third-party plugins", () => {
	it("indexes a settings tool in the built-in prompt, wherever its entry sits", () =>
		withSettings(async ({ root, custom }) => {
			// Settings entries land after the built-ins, so this tool's entry is written after the
			// prompt plugin's. Domain order decides setup order, so the tool still registers first
			// and the prompt that indexes tools sees it — which is the whole point of `kind`.
			await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ plugins: [pluginPath("tool/acme-echo")] }));
			const { contexts, prompts } = await exchange({ root, userConfigDir: custom });
			expect(contexts[0]?.tools?.map((entry) => entry.name)).toEqual(["bash", "acme_echo"]);
			expect(prompts[0]).toContain("- acme_echo: Echo a value back");
		}));

	it("honours an empty option selection over both the settings and the built-ins", () =>
		withSettings(async ({ root, custom }) => {
			// The broken plugin would fail preparation if settings still contributed.
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ plugins: [pluginPath("host/acme-broken.ts")] }),
			);
			const { contexts, prompts } = await exchange({ root, userConfigDir: custom, plugins: [] });
			expect(contexts[0]?.tools ?? []).toEqual([]);
			// No plugin set a prompt, so the registry floor stands in for one.
			expect(prompts[0]).toBe(fallback);
		}));

	it("reports preparation failures from settings before calling the model", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ plugins: [pluginPath("host/acme-broken.ts")] }),
			);
			let calls = 0;
			await expect(
				exchange({
					root,
					userConfigDir: custom,
					llm: (request, signal) => {
						calls++;
						return immediateOpen()(request, signal);
					},
				}),
			).rejects.toMatchObject({ _tag: "PluginLoadError", reason: "plugin-invalid-definition" });
			expect(calls).toBe(0);
		}));

	it("runs a package tool through the loop, with its after hook applied", () =>
		withSettings(async ({ root }) => {
			const { contexts, prompts, path } = await exchange({
				root,
				plugins: [pluginPath("tool/acme-echo"), defaultPromptPlugin],
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
				plugins: [pluginPath("tool/acme-guarded.ts"), defaultPromptPlugin],
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
				plugins: [bashPlugin, pluginPath("tool/acme-bash-override.ts"), defaultPromptPlugin],
				llm: toolTurn(pendingCall("bash", { command: "echo hi" }, "call_bash")),
			});
			expect(prompts[0]).toContain("- bash: Run a command through the acme shell");
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({
				status: "completed",
				result: { content: [{ type: "text", text: "acme-override:echo hi" }] },
			});
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
							hostCwd: root,
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("event/acme-journal.ts"), defaultPromptPlugin],
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
							hostCwd: root,
							database: ":memory:",
							llm: (request, signal) => {
								contexts.push(request.context);
								return immediateOpen()(request, signal);
							},
							plugins: [pluginPath("host/acme-throws.ts"), defaultPromptPlugin],
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
							hostCwd: root,
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("tool/acme-bad-tool.ts"), defaultPromptPlugin],
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

	it("relabels an overridden tool on the winner, keeping its hooks", () =>
		withSettings(async ({ root }) => {
			// acme-echo registers acme_echo with an after hook; a later plugin patches only
			// its prose. The wire description changes, the winner's hook still fires, and the
			// default prompt (placed after both) indexes the patched description.
			const { contexts, prompts, path } = await exchange({
				root,
				plugins: [pluginPath("tool/acme-echo"), pluginPath("tool/acme-relabel.ts"), defaultPromptPlugin],
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
							hostCwd: root,
							database: ":memory:",
							llm: (request, signal) => {
								contexts.push(request.context);
								return immediateOpen()(request, signal);
							},
							plugins: [pluginPath("host/acme-hangs.ts"), defaultPromptPlugin],
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
				plugins: [bashPlugin, { plugin: "codework.tool.bash", enabled: false }, defaultPromptPlugin],
				llm: toolTurn(pendingCall("bash", { command: "echo hi" }, "call_bash")),
			});
			expect(contexts[0]?.tools).toEqual([]);
			expect(prompts[0]).toContain("Available tools:\n(none)");
			const settled = JSON.parse(path[1]?.parts[0]?.data ?? "{}");
			expect(settled).toMatchObject({ status: "error", result: { isError: true } });
			expect(settled.result.content[0].text).toContain("Unknown tool: bash");
		}));
});
