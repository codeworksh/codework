/* @effect-diagnostics nodeBuiltinImport:off -- this suite spawns the CLI as a child process. */
import * as AcpClient from "@codeworksh/acp/client";
import type * as AcpError from "@codeworksh/acp/errors";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Queue, type Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const models = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
// Cheap, reliable with tools, and its id contains a slash, which the model selector must keep intact.
const LIVE_MODEL = "openrouter/openai/gpt-4.1-mini";

type Client = AcpClient.AcpClient["Service"];
type Update = Parameters<Parameters<Client["handleSessionUpdate"]>[0]>[0]["update"];

const temps: string[] = [];
const workspace = () => {
	const home = mkdtempSync(join(tmpdir(), "codework-acp-"));
	temps.push(home);
	const project = join(home, "project");
	mkdirSync(project);
	return { home, project };
};

/**
 * Spawns `codework acp` against `home` and runs `body` with the vendored client connected to it.
 * HOME is the same throwaway directory, so the user's credentials and settings stay out; the
 * child process ends with the scope.
 */
const withAgent = <A, E>(
	home: string,
	body: (acp: Client, updates: Queue.Queue<Update>) => Effect.Effect<A, E>,
	env: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner.spawn(
			ChildProcess.make(process.execPath, ["--conditions=development", cli, "--home", home, "acp"], {
				cwd: home,
				env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models, ...env },
			}),
		);
		return yield* Effect.gen(function* () {
			const acp = yield* AcpClient.AcpClient;
			const updates = yield* Queue.unbounded<Update>();
			yield* acp.handleSessionUpdate((notification) => Queue.offer(updates, notification.update));
			yield* acp.agent.initialize({ protocolVersion: 1, clientInfo: { name: "codework-e2e", version: "0.0.0" } });
			return yield* body(acp, updates);
		}).pipe(Effect.provide(AcpClient.layerChildProcess(handle)));
	}).pipe(Effect.scoped);

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | ChildProcessSpawner.ChildProcessSpawner>) =>
	effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);

/** A request's result, or the JSON-RPC error it was answered with. */
const settle = <A>(effect: Effect.Effect<A, AcpError.AcpError>) =>
	Effect.map(Effect.exit(effect), (exit) => {
		if (Exit.isSuccess(exit)) return { ok: exit.value };
		const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
		return failure?._tag === "Fail" && failure.error._tag === "AcpRequestError"
			? { code: failure.error.code, message: failure.error.errorMessage }
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

	it.skipIf(!process.env.OPENROUTER_API_KEY)(
		"streams, runs tools, cancels, fails and replays turns against OpenRouter",
		() => {
			const { home, project } = workspace();
			// The harness warns about this uninstalled plugin every turn; the warning must reach stderr,
			// not the protocol stream on stdout.
			mkdirSync(join(project, ".codework"));
			writeFileSync(
				join(project, ".codework", "settings.jsonc"),
				artifact({ plugins: ["codework-plugin-not-installed@0.0.0"] }),
			);
			const kinds = (updates: ReadonlyArray<Update>) => [...new Set(updates.map((update) => update.sessionUpdate))];
			return run(
				Effect.gen(function* () {
					const first = yield* withAgent(home, (acp, updates) =>
						Effect.gen(function* () {
							const { sessionId } = yield* acp.agent.createSession({ cwd: project, mcpServers: [] });
							yield* acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: LIVE_MODEL });

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
								.prompt({ sessionId, prompt: [{ type: "text", text: "Count from 1 to 2000, one per line." }] })
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
								yield* acp.agent.setSessionConfigOption({ sessionId, configId: "model", value: LIVE_MODEL });
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
									...("code" in result ? { code: result.code, hasMessage: Boolean(result.message) } : result),
									title: sessions.find((session) => session.sessionId === sessionId)?.title,
								};
							}),
						{ OPENROUTER_API_KEY: "sk-or-invalid" },
					);

					yield* Effect.promise(() =>
						expect(artifact({ ...first.record, replay, failed })).toMatchFileSnapshot(
							"./__artifacts__/acp.live.json",
						),
					);
				}),
			);
		},
		180_000,
	);
});
