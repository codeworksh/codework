import "./utils/env.ts";
import type { Message } from "@codeworksh/aikit";
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect";
import { join, relative } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { EventSchema } from "../src/event/schema.ts";
import { prepare, type PluginRef } from "../src/plugin/catalog.ts";
import { builtins } from "../src/plugin/builtin.ts";
import { fallback } from "../src/plugin/prompt/registry.ts";
import { Settings } from "../src/settings/settings.ts";
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
	readonly cwd?: string;
	readonly plugins?: ReadonlyArray<PluginRef>;
	readonly userConfigDir?: string;
	readonly llm?: LLM.Open;
	readonly prompt?: string;
}) => {
	const contexts: Message.Context[] = [];
	const prompts: string[] = [];
	const open = input.llm ?? immediateOpen();
	return Effect.gen(function* () {
		// The session is placed in the project under test. Since the config pass runs against the
		// settings *that session* reads, a session with no host directory would load the project's
		// plugins into the pool at boot and then select none of them.
		const session = yield* Session.create({ directory: input.root, hostDir: input.cwd ?? input.root });
		yield* session.run(input.prompt ?? "hello");
		// Read inside the scope: the memory database closes with the layer.
		const path = yield* session.path();
		return { contexts, prompts, path } as const;
	}).pipe(
		Effect.provide(
			Harness.layer({
				home: join(input.root, "home"),
				hostCwd: input.cwd ?? input.root,
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
	it("uses Harness.layer cwd and the nearest ancestor project file", () =>
		withSettings(async ({ root }) => {
			const nested = join(root, "packages", "app");
			await mkdir(join(root, "packages", ".codework"), { recursive: true });
			await mkdir(nested, { recursive: true });
			// The outer project, which the nearest one shadows outright rather than merging with.
			await writeFile(
				join(root, ".codework", "settings.jsonc"),
				JSON.stringify({ plugins: [pluginPath("tool/acme-echo")] }),
			);
			await writeFile(
				join(root, "packages", ".codework", "settings.jsonc"),
				JSON.stringify({
					plugins: [
						pluginPath("prompt/acme-prompt.ts"),
						{ plugin: "acme.prompt.marker", options: { marker: "nearest" } },
					],
				}),
			);

			const { contexts, prompts } = await exchange({ root, cwd: nested });
			// `acme-echo` came from the outer file, which is not read at all.
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash"]);
			expect(prompts[0]?.endsWith("\n\nnearest")).toBe(true);
		}));

	it.each(["global", "custom"] as const)(
		"adds %s settings plugins to the built-ins and executes their hooks",
		(source) =>
			withSettings(async ({ root, global, custom }) => {
				const directory = source === "global" ? global : custom;
				await writeFile(
					join(directory, "settings.jsonc"),
					JSON.stringify({
						// The relative entry anchors to this file's directory, not to the process cwd.
						plugins: [
							`./${relative(directory, pluginPath("tool/acme-echo"))}`,
							pluginPath("prompt/acme-prompt.ts"),
						],
					}),
				);
				const { contexts, prompts, path } = await exchange({
					root,
					userConfigDir: custom,
					llm: toolTurn(pendingCall("acme_echo", { value: "settings" }, "call_settings")),
				});
				// The built-in Bash tool and prompt survive: a settings entry adds, it does not select.
				expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash", "acme_echo"]);
				expect(prompts[0]?.endsWith("\n\nacme-marker")).toBe(true);
				expect(JSON.parse(path[1]?.parts[0]?.data ?? "{}")).toMatchObject({
					status: "completed",
					result: {
						content: [
							{ type: "text", text: "settings" },
							{ type: "text", text: "(acme-checked)" },
						],
					},
				});
			}),
	);

	it("leaves the built-ins alone when no settings file asks for plugins", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(join(custom, "settings.jsonc"), JSON.stringify({ model: { id: "gpt-5.6-luna" } }));
			const { contexts } = await exchange({ root, userConfigDir: custom });
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash"]);
		}));

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

	it("disables a built-in from settings", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ plugins: [{ plugin: "codework.tool.bash", enabled: false }] }),
			);
			const { contexts, prompts } = await exchange({ root, userConfigDir: custom });
			expect(contexts[0]?.tools ?? []).toEqual([]);
			expect(prompts[0]).toContain("Available tools:\n(none)");
		}));

	it("passes a settings options block to the module that loaded the plugin", () =>
		withSettings(async ({ root, custom }) => {
			// One line names the module, the next configures it by the same path. The two keys keep
			// those apart: `package` addresses something loaded, `plugin` addresses an ID.
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({
					plugins: [
						pluginPath("prompt/acme-prompt.ts"),
						{ package: pluginPath("prompt/acme-prompt.ts"), options: { marker: "configured" } },
					],
				}),
			);
			const { prompts } = await exchange({ root, userConfigDir: custom });
			expect(prompts[0]?.endsWith("\n\nconfigured")).toBe(true);
			// The plugin's own ID reaches it just as well.
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({
					plugins: [
						pluginPath("prompt/acme-prompt.ts"),
						{ plugin: "acme.prompt.marker", options: { marker: "by-id" } },
					],
				}),
			);
			expect((await exchange({ root, userConfigDir: custom })).prompts[0]?.endsWith("\n\nby-id")).toBe(true);
		}));

	it("configures a built-in without disturbing the order its domain gives it", () =>
		withSettings(async ({ root, custom }) => {
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({
					plugins: [
						{ plugin: "codework.prompt.default", options: { ignored: true } },
						pluginPath("tool/acme-echo"),
					],
				}),
			);
			const { contexts, prompts } = await exchange({ root, userConfigDir: custom });
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash", "acme_echo"]);
			// Configuration never moves a plugin, and the prompt plugin runs after the tools
			// regardless, so the tool is indexed either way.
			expect(prompts[0]).toContain("- acme_echo: Echo a value back");
		}));

	it("prepares a settings block mixing package specs, an anchored path, options and a disable", () =>
		withSettings(async ({ root, custom, global }) => {
			// The composition `Harness.layer` performs, with real modules behind the two package
			// specs: only the registry install is a seam, because reaching npm is not this suite's
			// business. Imports, anchoring and ordering are the real ones.
			const packaged = join(custom, "packages");
			await mkdir(packaged, { recursive: true });
			await mkdir(join(custom, "plugins"), { recursive: true });
			await writeFile(
				join(packaged, "tool.mjs"),
				"export default { id: 'acme.tool.example', kind: 'tool', setup() {} }",
			);
			await writeFile(
				join(packaged, "prompt.mjs"),
				"export default { id: 'acme.prompt.example', kind: 'prompt', setup() {} }",
			);
			await writeFile(
				join(custom, "plugins", "local.mjs"),
				"export default { id: 'acme.tool.local', kind: 'tool', setup() {} }",
			);
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({
					plugins: [
						"codework-acme-plugin",
						"@acme/codework-plugin@1.2.0",
						"./plugins/local.mjs",
						{ plugin: "acme.tool.example", options: { retries: 2 } },
						{ plugin: "codework.tool.bash", enabled: false },
					],
				}),
			);
			const specs: string[] = [];
			const config = await Effect.runPromise(Settings.load({ hostDir: root, userConfigDir: custom, home: global }));
			const prepared = await Effect.runPromise(
				prepare([...builtins, ...config.plugins], {
					builtins,
					cache: join(root, "cache"),
					hostDir: root,
					install: (target) => {
						specs.push(target.spec);
						const module = target.spec.startsWith("codework-acme-plugin") ? "tool.mjs" : "prompt.mjs";
						return Effect.succeed({ url: pathToFileURL(join(packaged, module)).href, version: "1.2.0" });
					},
				}),
			);
			expect(specs).toEqual(["codework-acme-plugin@latest", "@acme/codework-plugin@1.2.0"]);
			// Bash is gone, the options entry configured the package plugin without moving it, and
			// the relative entry resolved against the settings file rather than the host cwd.
			// Tools first, then prompts; within a domain, the order the entries were written in.
			expect(prepared.map((entry) => [entry.plugin.id, entry.options])).toEqual([
				["acme.tool.example", { retries: 2 }],
				["acme.tool.local", {}],
				["codework.prompt.default", {}],
				["acme.prompt.example", {}],
			]);
		}));

	it("lets an explicit option selection replace the settings plugins", () =>
		withSettings(async ({ root, custom }) => {
			// The broken plugin would fail preparation if settings still contributed.
			await writeFile(
				join(custom, "settings.jsonc"),
				JSON.stringify({ plugins: [pluginPath("host/acme-broken.ts")] }),
			);
			const { contexts } = await exchange({
				root,
				userConfigDir: custom,
				plugins: [bashPlugin, defaultPromptPlugin],
			});
			expect(contexts[0]?.tools?.map((tool) => tool.name)).toEqual(["bash"]);
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

	it("loads a directory package and a single file through real imports", async () => {
		const plugins = await Effect.runPromise(
			prepare([pluginPath("tool/acme-echo"), `file://${pluginPath("prompt/acme-prompt.ts")}`], {
				builtins: [],
				cache: "/unused",
				hostDir: "/project",
			}),
		);
		expect(plugins.map((entry) => entry.plugin.id)).toEqual(["acme.tool.echo", "acme.prompt.marker"]);
	});

	it("rejects a malformed module and a reserved namespace through real imports", async () => {
		const failure = await Effect.runPromise(
			prepare([pluginPath("host/acme-broken.ts")], {
				builtins: [],
				cache: "/unused",
				hostDir: "/project",
			}).pipe(Effect.flip),
		);
		expect(failure).toMatchObject({ _tag: "PluginLoadError", reason: "plugin-invalid-definition" });
	});

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

	it("composes a prompt plugin over the default, after tool contributors", () =>
		withSettings(async ({ root }) => {
			const { prompts } = await exchange({
				root,
				plugins: [pluginPath("tool/acme-echo"), defaultPromptPlugin, pluginPath("prompt/acme-prompt.ts")],
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

	it("fails harness construction with the preparation error", () =>
		withSettings(async ({ root }) => {
			const failure = await Effect.runPromise(
				Effect.gen(function* () {
					yield* Session.create({ directory: root });
				}).pipe(
					Effect.provide(
						Harness.layer({
							hostCwd: root,
							database: ":memory:",
							llm: immediateOpen(),
							plugins: [pluginPath("host/acme-broken.ts")],
						}),
					),
					Effect.scoped,
					Effect.flip,
				),
			);
			expect(failure).toMatchObject({ _tag: "PluginLoadError", reason: "plugin-invalid-definition" });
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
