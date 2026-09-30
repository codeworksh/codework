/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import * as Acp from "@agentclientprotocol/sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Cause, Effect, Exit, Fiber, Option, Queue, type Scope, Stream } from "effect";
import * as EffectCause from "effect/Cause";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { crc32, deflateSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import "./env.ts";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
// Cheap, reliable with tools, and its id contains a slash, which the model selector must keep intact.
const LIVE_MODEL = "openrouter/openai/gpt-4.1-mini";

/** Every live case runs against each of these; `env` names the key that enables it. */
const LIVE = [
	{ name: "openai", provider: "openai", id: "gpt-5.6-luna", env: "OPENAI_API_KEY" },
	{ name: "openai-codex", provider: "openai-codex", id: "gpt-5.6-luna", env: "OPENAI_CODEX_API_KEY" },
	{ name: "anthropic", provider: "anthropic", id: "claude-sonnet-5-5", env: "ANTHROPIC_API_KEY" },
	{ name: "deepseek", provider: "openrouter", id: "deepseek/deepseek-v4.1-flash", env: "OPENROUTER_API_KEY" },
	{ name: "gemini", provider: "openrouter", id: "google/gemini-3.8-flash", env: "OPENROUTER_API_KEY" },
	{ name: "muse", provider: "openrouter", id: "meta/muse-spark-1.3-contributor", env: "OPENROUTER_API_KEY" },
].map((live) => ({ ...live, model: `${live.provider}/${live.id}` }));

type Update = Acp.SessionUpdate;

const temps: string[] = [];
/** An environment with `undefined` entries removed, so an override can unset a variable. */
const environment = (env: Record<string, string | undefined>): Record<string, string> =>
	Object.fromEntries(Object.entries(env).flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])));

/**
 * Every API key variable the catalog names, unset. A case that asserts which providers have
 * credentials starts from this, so the developer's own keys can't change the answer.
 */
const withoutProviderKeys = (): Record<string, undefined> => {
	const catalog: Record<string, Record<string, { provider: { env?: string[]; key?: string } }>> = JSON.parse(
		readFileSync(models, "utf8"),
	);
	const names = Object.values(catalog).flatMap((entries) =>
		Object.values(entries).flatMap(({ provider }) => [
			...(provider.env ?? []),
			...(provider.key ? [provider.key] : []),
		]),
	);
	return Object.fromEntries(names.map((name) => [name, undefined]));
};

/** A model from the generated catalog, to copy into a settings `models` entry. */
const catalogEntry = (provider: string, id: string): Record<string, unknown> => {
	const catalog: Record<string, Record<string, Record<string, unknown>>> = JSON.parse(readFileSync(models, "utf8"));
	const entry = catalog[provider]?.[id];
	if (entry === undefined) throw new Error(`${provider}/${id} is not in the generated catalog`);
	return entry;
};

/** A complete settings `models` entry for a new OpenAI-compatible provider. */
const newModel = (provider: Record<string, unknown>, id: string, fields: Record<string, unknown> = {}) => ({
	id,
	name: id,
	provider: { name: provider.id, source: "config", env: [], ...provider },
	baseUrl: "http://127.0.0.1:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 8192,
	protocol: "openai-compatible",
	...fields,
});

/** Write a settings file, creating its directory. */
const writeSettings = (file: string, settings: Record<string, unknown>) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, artifact(settings));
};

const workspace = () => {
	const home = mkdtempSync(join(tmpdir(), "codework-acp-"));
	temps.push(home);
	const project = join(home, "project");
	mkdirSync(project);
	return { home, project };
};

/** The SDK's client as effects; a JSON-RPC error answer fails with `Acp.RequestError`. */
const connect = (handle: ChildProcessSpawner.ChildProcessHandle, updates: Queue.Queue<Update>) =>
	Effect.gen(function* () {
		const context = yield* Effect.context<never>();
		const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>();
		yield* Stream.fromQueue(stdin).pipe(Stream.run(handle.stdin), Effect.forkScoped);
		const connection = Acp.client({ name: "codework-e2e" })
			.onNotification("session/update", ({ params }) =>
				Effect.runPromiseWith(context)(Queue.offer(updates, params.update).pipe(Effect.asVoid)),
			)
			.connect(
				Acp.ndJsonStream(
					new WritableStream({ write: (chunk) => void Queue.offerUnsafe(stdin, chunk) }),
					yield* Stream.toReadableStreamEffect(handle.stdout),
				),
			);
		yield* Effect.addFinalizer(() => Effect.sync(() => connection.close()));
		const request =
			<M extends Acp.AgentRequestMethod>(method: M) =>
			(params: Acp.AgentRequestParamsByMethod[M]) =>
				Effect.promise((signal) =>
					connection.agent
						.request(method, params, { cancellationSignal: signal })
						.then(Exit.succeed, (error) =>
							error instanceof Acp.RequestError ? Exit.fail(error) : Exit.die(error),
						),
				).pipe(Effect.flatten);
		return {
			agent: {
				initialize: request("initialize"),
				createSession: request("session/new"),
				loadSession: request("session/load"),
				listSessions: request("session/list"),
				setSessionConfigOption: request("session/set_config_option"),
				prompt: request("session/prompt"),
				cancel: (params: Acp.CancelNotification) =>
					Effect.promise(() => connection.agent.notify("session/cancel", params)),
			},
		};
	});

type Client = Effect.Success<ReturnType<typeof connect>>;

/**
 * Spawns `codework acp` against `home` and runs `body` with an ACP client connected to it.
 * HOME is the same throwaway directory, so the user's credentials and settings stay out; the
 * child process ends with the scope.
 */
const withAgent = <A, E>(
	home: string,
	body: (acp: Client, updates: Queue.Queue<Update>) => Effect.Effect<A, E>,
	env: Record<string, string | undefined> = {},
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make(process.execPath, ["--conditions=development", cli, "--home", home, "acp"], {
				cwd: home,
				env: environment({ ...process.env, HOME: home, CODEWORK_MODELS_FILE: models, ...env }),
			}),
		);
		const updates = yield* Queue.unbounded<Update>();
		const acp = yield* connect(handle, updates);
		yield* acp.agent.initialize({ protocolVersion: 1, clientInfo: { name: "codework-e2e", version: "0.0.0" } });
		return yield* body(acp, updates);
	}).pipe(Effect.scoped);

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

/** A request's result, or the JSON-RPC error it was answered with. */
const settle = <A>(effect: Effect.Effect<A, Acp.RequestError>) =>
	Effect.map(Effect.exit(effect), (exit) => {
		if (Exit.isSuccess(exit)) return { ok: exit.value };
		const failure = EffectCause.findErrorOption(exit.cause);
		return Option.isSome(failure)
			? { code: failure.value.code, message: failure.value.message }
			: { defect: String(exit.cause) };
	});

/** The text a run of message chunks of one kind adds up to. */
const text = (updates: ReadonlyArray<Update>, kind: "agent_message_chunk" | "user_message_chunk") =>
	updates
		.flatMap((update) => {
			if (update.sessionUpdate !== kind || !("content" in update)) return [];
			const content = update.content;
			return content != null && "text" in content && typeof content.text === "string" ? [content.text] : [];
		})
		.join("");

/** A `size`×`size` PNG of one colour, as base64. */
const solidPng = ([r, g, b]: readonly [number, number, number], size = 64): string => {
	const chunk = (type: string, data: Buffer) => {
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([length, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(size, 0);
	header.writeUInt32BE(size, 4);
	header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
		chunk("IEND", Buffer.alloc(0)),
	]).toString("base64");
};

const artifact = (record: Record<string, unknown>) => `${JSON.stringify(record, null, "\t")}\n`;

describe("codework acp", () => {
	afterAll(() => {
		for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("answers the protocol surface over stdio", () => {
		const { home, project } = workspace();
		return run(
			withAgent(home, (acp) =>
				Effect.gen(function* () {
					const initialized = yield* acp.agent.initialize({ protocolVersion: 1 });
					const { sessionId, configOptions } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
					const currentModel = (response: {
						readonly configOptions?: ReadonlyArray<{ id: string; currentValue: unknown }> | null;
					}) => response.configOptions?.find((option) => option.id === "model")?.currentValue;

					const transcript = {
						initialize: { ...initialized, agentInfo: { name: initialized.agentInfo?.name } },
						newSession: {
							configIds: configOptions?.map((option) => option.id),
							model: configOptions?.find((option) => option.id === "model")?.currentValue,
						},
						setModelWithSlashes: yield* settle(
							acp.agent
								.setSessionConfigOption({ sessionId, configId: "model", value: LIVE_MODEL })
								.pipe(Effect.map((response) => currentModel(response))),
						),
						setUnknownModel: yield* settle(
							acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: "nope/nothing" }),
						),
						setUnknownThinkingLevel: yield* settle(
							acp.agent.setSessionConfigOption({ sessionId, configId: "thought_level", value: "bogus" }),
						),
						setUnknownOption: yield* settle(
							acp.agent.setSessionConfigOption({ sessionId, configId: "mode", value: "fast" }),
						),
						listProject: yield* settle(
							acp.agent
								.listSessions({ cwd: project })
								.pipe(Effect.map(({ sessions }) => sessions.map((session) => session.sessionId === sessionId))),
						),
						listParent: yield* settle(
							acp.agent
								.listSessions({ cwd: dirname(project) })
								.pipe(Effect.map(({ sessions }) => sessions.length)),
						),
						promptUnknownSession: yield* settle(
							acp.agent.prompt({ sessionId: "ses_missing", prompt: [{ type: "text", text: "hi" }] }),
						),
						promptImage: yield* settle(
							acp.agent.prompt({ sessionId, prompt: [{ type: "image", data: "", mimeType: "image/png" }] }),
						),
						loadUnknownSession: yield* settle(
							acp.agent.loadSession({ sessionId: "ses_missing", cwd: project, mcpServers: [] }),
						),
					};

					expect(sessionId.startsWith("ses_")).toBe(true);
					yield* Effect.promise(() =>
						expect(artifact(transcript)).toMatchFileSnapshot("./__artifacts__/acp.json"),
					);
				}),
			),
		);
	});

	it("offers the models its credentials reach, and starts from the project's model", () => {
		const { home, project } = workspace();
		// A Copilot login in the home's own credential file: `--home` must be where it is looked for.
		mkdirSync(join(home, "aikit"));
		writeFileSync(
			join(home, "aikit", "auth.json"),
			artifact({ "github-copilot": { access: "test-access", refresh: "test-refresh", expires: 4_102_444_800_000 } }),
		);
		// The project's settings pick the model and thinking level every new session starts with.
		mkdirSync(join(project, ".codework"));
		writeFileSync(
			join(project, ".codework", "settings.jsonc"),
			artifact({ model: { provider: "openrouter", id: "anthropic/claude-haiku-4.5", thinkingLevel: "low" } }),
		);
		const elsewhere = join(home, "elsewhere");
		mkdirSync(elsewhere);
		return run(
			withAgent(
				home,
				(acp) =>
					Effect.gen(function* () {
						const selector = (
							options: ReadonlyArray<{ id: string; currentValue: unknown; options?: unknown }>,
						) => {
							const model = options.find((option) => option.id === "model");
							const values = (model?.options ?? []) as ReadonlyArray<{ value: string }>;
							return {
								current: model?.currentValue,
								providers: [...new Set(values.map((option) => option.value.split("/")[0] ?? ""))].sort((a, b) =>
									a.localeCompare(b),
								),
								thinking: options.find((option) => option.id === "thought_level")?.currentValue,
							};
						};
						const inProject = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
						const outside = yield* acp.agent.createSession({ cwd: elsewhere, mcpServers: [] });
						yield* Effect.promise(() =>
							expect(
								artifact({
									project: selector(inProject.configOptions ?? []),
									withoutProjectSettings: selector(outside.configOptions ?? []),
								}),
							).toMatchFileSnapshot("./__artifacts__/acp.models.json"),
						);
					}),
				{ ...withoutProviderKeys(), OPENROUTER_API_KEY: "sk-or-test" },
			),
		);
	});

	it("keeps a session's chosen model and thinking level across a restart", () => {
		const { home, project } = workspace();
		mkdirSync(join(project, ".codework"));
		writeFileSync(
			join(project, ".codework", "settings.jsonc"),
			artifact({ model: { provider: "openrouter", id: "anthropic/claude-haiku-4.5", thinkingLevel: "low" } }),
		);
		const env = { ...withoutProviderKeys(), OPENROUTER_API_KEY: "sk-or-test" };
		const current = (options: ReadonlyArray<{ id: string; currentValue: unknown }> | null | undefined) => ({
			model: options?.find((option) => option.id === "model")?.currentValue,
			thinking: options?.find((option) => option.id === "thought_level")?.currentValue,
		});
		return run(
			Effect.gen(function* () {
				const first = yield* withAgent(
					home,
					(acp) =>
						Effect.gen(function* () {
							const chosen = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
							const untouched = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
							yield* acp.agent.setSessionConfigOption({
								sessionId: chosen.sessionId,
								configId: "model",
								value: "openrouter/anthropic/claude-sonnet-4.5",
							});
							const set = yield* acp.agent.setSessionConfigOption({
								sessionId: chosen.sessionId,
								configId: "thought_level",
								value: "high",
							});
							return {
								ids: { chosen: chosen.sessionId, untouched: untouched.sessionId },
								record: { created: current(chosen.configOptions), chosen: current(set.configOptions) },
							};
						}),
					env,
				);
				// A fresh process: nothing of the first one's memory is left.
				const reloaded = yield* withAgent(
					home,
					(acp) =>
						Effect.gen(function* () {
							const load = (sessionId: string) =>
								acp.agent
									.loadSession({ sessionId, cwd: project, mcpServers: [] })
									.pipe(Effect.map((response) => current(response.configOptions)));
							const chosen = yield* load(first.ids.chosen);
							const untouched = yield* load(first.ids.untouched);
							// Choosing only the thinking level keeps the saved model.
							const rethought = yield* acp.agent
								.setSessionConfigOption({
									sessionId: first.ids.chosen,
									configId: "thought_level",
									value: "medium",
								})
								.pipe(Effect.map((response) => current(response.configOptions)));
							return { chosen, untouched, rethought };
						}),
					env,
				);
				yield* Effect.promise(() =>
					expect(artifact({ ...first.record, afterRestart: reloaded })).toMatchFileSnapshot(
						"./__artifacts__/acp.config-persist.json",
					),
				);
			}),
		);
	});

	it("reads settings models entries like generated catalog entries", () => {
		const { home, project } = workspace();
		const haiku = catalogEntry("openrouter", "anthropic/claude-haiku-4.5");
		// The user file: a keyless provider, a keyed provider whose variable is set, one whose variable
		// isn't, and a catalog model shadowed with a new name and no reasoning.
		writeSettings(join(home, "settings.jsonc"), {
			models: [
				newModel({ id: "ollama", name: "Ollama" }, "qwen3-coder:30b"),
				newModel({ id: "gateway", name: "Gateway", key: "${GATEWAY_KEY}" }, "claude-sonnet", { reasoning: true }),
				newModel({ id: "offline", name: "Offline", key: "${OFFLINE_KEY}" }, "model-a"),
				{ ...haiku, name: "User Haiku", reasoning: false },
			],
		});
		// The project file shadows the same catalog model again, and wins.
		writeSettings(join(project, ".codework", "settings.jsonc"), {
			model: { provider: "gateway", id: "claude-sonnet" },
			models: [{ ...haiku, name: "Project Haiku" }],
		});
		const rejected = (name: string, settings: Record<string, unknown>) => {
			const dir = join(home, "rejected", name);
			writeSettings(join(dir, ".codework", "settings.jsonc"), settings);
			return dir;
		};
		const literalKey = rejected("literal-key", {
			models: [newModel({ id: "leaky", key: "sk-literal-secret" }, "model-a")],
		});
		const missingField = rejected("missing-field", {
			models: [{ id: "incomplete", provider: { id: "partial", name: "Partial", source: "config", env: [] } }],
		});
		const literalApiKey = rejected("literal-api-key", {
			model: { provider: "openrouter", id: "anthropic/claude-haiku-4.5", options: { apiKey: "sk-literal-secret" } },
		});
		return run(
			withAgent(
				home,
				(acp) =>
					Effect.gen(function* () {
						type Options = ReadonlyArray<{ id: string; currentValue: unknown; options?: unknown }>;
						const picker = (options: Options) => {
							const model = options.find((option) => option.id === "model");
							const values = (model?.options ?? []) as ReadonlyArray<{ value: string; name: string }>;
							return {
								current: model?.currentValue,
								thinking: options.find((option) => option.id === "thought_level")?.currentValue ?? null,
								providers: [...new Set(values.map((option) => option.value.split("/")[0] ?? ""))].sort((a, b) =>
									a.localeCompare(b),
								),
								haiku: values.find((option) => option.value === "openrouter/anthropic/claude-haiku-4.5")?.name,
							};
						};
						const created = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
						const switched = yield* settle(
							acp.agent
								.setSessionConfigOption({
									sessionId: created.sessionId,
									configId: "model",
									value: "ollama/qwen3-coder:30b",
								})
								.pipe(Effect.map((response) => picker(response.configOptions))),
						);
						const outside = yield* acp.agent.createSession({ cwd: home, mcpServers: [] });
						const failure = (cwd: string) =>
							settle(acp.agent.createSession({ cwd, mcpServers: [] })).pipe(
								Effect.map((result) =>
									"code" in result
										? { code: result.code, message: (result.message ?? "").replaceAll(home, "<home>") }
										: result,
								),
							);
						const rejected = {
							literalProviderKey: yield* failure(literalKey),
							missingRequiredField: yield* failure(missingField),
							literalOptionsApiKey: yield* failure(literalApiKey),
						};
						const record = {
							project: picker(created.configOptions ?? []),
							switchedToKeyless: switched,
							userOnly: picker(outside.configOptions ?? []),
							rejected,
						};
						yield* Effect.promise(() =>
							expect(artifact(record)).toMatchFileSnapshot("./__artifacts__/acp.custom-models.json"),
						);
					}),
				{
					...withoutProviderKeys(),
					OPENROUTER_API_KEY: "sk-or-test",
					GATEWAY_KEY: "gw-test",
					OFFLINE_KEY: undefined,
				},
			),
		);
	});

	describe.each(LIVE)("live: $name", (live) => {
		it.skipIf(!process.env[live.env])(
			"calls a settings-defined model with a ${NAME} key",
			() => {
				const { home, project } = workspace();
				// The catalog entry re-homed as a new provider: only the settings entry knows it.
				const entry = catalogEntry(live.provider, live.id);
				writeSettings(join(home, "settings.jsonc"), {
					models: [
						{
							...entry,
							provider: { id: "gateway", name: "Gateway", source: "config", env: [], key: `\${${live.env}}` },
						},
					],
				});
				return run(
					withAgent(home, (acp, updates) =>
						Effect.gen(function* () {
							const { sessionId } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
							yield* acp.agent.setSessionConfigOption({
								sessionId,
								configId: "model",
								value: `gateway/${live.id}`,
							});
							const answered = yield* acp.agent.prompt({
								sessionId,
								prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
							});
							expect(answered.stopReason).toBe("end_turn");
							expect(text(yield* Queue.clear(updates), "agent_message_chunk")).toContain("PONG");
						}),
					),
				);
			},
			120_000,
		);

		it.skipIf(!process.env[live.env])(
			"streams, runs tools, cancels, fails and replays turns",
			() => {
				const { home, project } = workspace();
				// The harness warns about this uninstalled plugin every turn; the warning must reach stderr,
				// not the protocol stream on stdout.
				mkdirSync(join(project, ".codework"));
				writeFileSync(
					join(project, ".codework", "settings.jsonc"),
					artifact({ plugins: ["codework-plugin-not-installed@0.0.0"] }),
				);
				const kinds = (updates: ReadonlyArray<Update>) => [
					...new Set(updates.map((update) => update.sessionUpdate)),
				];
				return run(
					Effect.gen(function* () {
						const first = yield* withAgent(home, (acp, updates) =>
							Effect.gen(function* () {
								const { sessionId } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
								yield* acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: live.model });

								const pong = yield* acp.agent.prompt({
									sessionId,
									prompt: [{ type: "text", text: "Reply with exactly: PONG" }],
								});
								const pongUpdates = yield* Queue.clear(updates);
								const pongText = text(pongUpdates, "agent_message_chunk");
								const titled = pongUpdates.flatMap((update) =>
									update.sessionUpdate === "session_info_update" ? [update.title] : [],
								);
								expect(pongText).toContain("PONG");

								const tool = yield* acp.agent.prompt({
									sessionId,
									prompt: [
										{
											type: "text",
											text: "Call the `bash` tool with the command `echo acp-e2e-marker`, then reply with its output.",
										},
									],
								});
								const toolUpdates = yield* Queue.clear(updates);
								const toolText = text(toolUpdates, "agent_message_chunk");
								const started = toolUpdates.find((update) => update.sessionUpdate === "tool_call");
								const settled = toolUpdates.find(
									(update) => update.sessionUpdate === "tool_call_update" && update.status === "completed",
								);
								expect(artifact({ settled })).toContain("acp-e2e-marker");

								// Cancel once the answer is streaming; the prompt must answer `cancelled`, not fail.
								const long = yield* acp.agent
									.prompt({
										sessionId,
										prompt: [{ type: "text", text: "Count from 1 to 2000, one per line." }],
									})
									.pipe(Effect.forkChild);
								const streaming = Effect.gen(function* () {
									while ((yield* Queue.take(updates)).sessionUpdate !== "agent_message_chunk") {
										// Thoughts may stream first.
									}
								});
								yield* streaming.pipe(Effect.timeout("30 seconds"));
								yield* acp.agent.cancel({ sessionId });
								const cancelled = yield* Fiber.join(long);
								yield* Queue.clear(updates);

								return {
									sessionId,
									record: {
										pong: pong.stopReason,
										// The first prompt names the untitled session, and the editor is told once.
										titled,
										// Once per prompt, however many exchanges the prompt takes.
										notices: [pongText, toolText].map(
											(answer) =>
												answer.split("codework-plugin-not-installed@0.0.0 is configured but not loaded")
													.length - 1,
										),
										tool: {
											stopReason: tool.stopReason,
											updates: kinds(toolUpdates).filter((kind) => kind.startsWith("tool_call")),
											started:
												started?.sessionUpdate === "tool_call"
													? {
															titledWithCommand: started.title.includes("echo acp-e2e-marker"),
															hasRawInput: started.rawInput !== undefined,
														}
													: undefined,
											settled:
												settled?.sessionUpdate === "tool_call_update"
													? { kind: settled.kind, status: settled.status }
													: undefined,
										},
										cancel: cancelled.stopReason,
									},
								};
							}),
						);

						// A fresh process replays the stored conversation before answering `session/load`.
						const replay = yield* withAgent(home, (acp, updates) =>
							Effect.gen(function* () {
								yield* acp.agent.loadSession({ sessionId: first.sessionId, cwd: project, mcpServers: [] });
								const replayed = yield* Queue.clear(updates);
								expect(text(replayed, "user_message_chunk")).toContain("Reply with exactly: PONG");
								expect(text(replayed, "agent_message_chunk")).toContain("PONG");
								return kinds(replayed).filter((kind) => kind !== "agent_thought_chunk");
							}),
						);

						// A provider failure answers the prompt with its error, not a silent `end_turn`.
						const failed = yield* withAgent(
							home,
							(acp) =>
								Effect.gen(function* () {
									const { sessionId } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
									yield* acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: live.model });
									const result = yield* settle(
										acp.agent.prompt({
											sessionId,
											prompt: [
												{
													type: "text",
													text: "Summarise how sessions, plugins and sandboxes fit together in the codework harness.\nKeep it short.",
												},
											],
										}),
									);
									// Titled at promotion, before the provider call fails: first line, cut to 48 characters.
									const { sessions } = yield* acp.agent.listSessions({ cwd: project });
									return {
										...("code" in result
											? { code: result.code, hasMessage: Boolean(result.message) }
											: result),
										title: sessions.find((session) => session.sessionId === sessionId)?.title,
									};
								}),
							{ [live.env]: "invalid-key" },
						);

						yield* Effect.promise(() =>
							expect(artifact({ ...first.record, replay, failed })).toMatchFileSnapshot(
								`./__artifacts__/acp.live.${live.name}.json`,
							),
						);
					}),
				);
			},
			180_000,
		);
		it.skipIf(!process.env[live.env])(
			"answers about an image in the prompt and replays it",
			() => {
				const { home, project } = workspace();
				const red = solidPng([255, 0, 0]);
				return run(
					Effect.gen(function* () {
						const first = yield* withAgent(home, (acp, updates) =>
							Effect.gen(function* () {
								const initialized = yield* acp.agent.initialize({ protocolVersion: 1 });
								const { sessionId } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
								yield* acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: live.model });
								const reject = (prompt: Parameters<Client["agent"]["prompt"]>[0]["prompt"]) =>
									settle(acp.agent.prompt({ sessionId, prompt }));
								// Refused before anything is saved: the replay below holds only the answered prompt.
								const rejected = {
									audio: yield* reject([{ type: "audio", data: red, mimeType: "audio/wav" }]),
									bmp: yield* reject([{ type: "image", data: red, mimeType: "image/bmp" }]),
									oversized: yield* reject([
										{ type: "image", data: "A".repeat(4.5 * 1024 * 1024 + 4), mimeType: "image/png" },
									]),
									notBase64: yield* reject([{ type: "image", data: "not base64!", mimeType: "image/png" }]),
									binaryResource: yield* reject([
										{
											type: "resource",
											resource: { uri: "file:///notes.pdf", blob: red, mimeType: "application/pdf" },
										},
									]),
								};
								const answered = yield* acp.agent.prompt({
									sessionId,
									prompt: [
										{ type: "text", text: "Which colour fills this image? Answer with one word." },
										{ type: "image", data: red, mimeType: "image/png" },
									],
								});
								const answer = text(yield* Queue.clear(updates), "agent_message_chunk").toLowerCase();
								const { sessions } = yield* acp.agent.listSessions({ cwd: project });
								return {
									sessionId,
									record: {
										promptCapabilities: initialized.agentCapabilities?.promptCapabilities,
										rejected,
										stopReason: answered.stopReason,
										namesRed: answer.includes("red"),
										title: sessions.find((session) => session.sessionId === sessionId)?.title,
									},
								};
							}),
						);

						// A fresh process replays the image with the prompt it came in.
						const replay = yield* withAgent(home, (acp, updates) =>
							Effect.gen(function* () {
								yield* acp.agent.loadSession({ sessionId: first.sessionId, cwd: project, mcpServers: [] });
								return (yield* Queue.clear(updates)).flatMap(
									(update): ReadonlyArray<Record<string, unknown>> => {
										if (update.sessionUpdate !== "user_message_chunk") return [];
										const content = update.content;
										return content.type === "image"
											? [{ type: "image", mimeType: content.mimeType, sameData: content.data === red }]
											: content.type === "text"
												? [{ type: "text", text: content.text }]
												: [{ type: content.type }];
									},
								);
							}),
						);

						yield* Effect.promise(() =>
							expect(artifact({ ...first.record, replay })).toMatchFileSnapshot(
								`./__artifacts__/acp.image.${live.name}.json`,
							),
						);
					}),
				);
			},
			120_000,
		);
	});
});
