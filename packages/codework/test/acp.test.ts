/* @effect-diagnostics nodeBuiltinImport:off -- fixtures only need temp dirs. */
import * as acp from "@agentclientprotocol/sdk";
import { createAssistantMessageEventStream } from "@codeworksh/aikit";
import { EventSchema, Harness, Session } from "@codeworksh/harness/effect";
import { DateTime, Effect, Fiber, Option } from "effect";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { assistant, immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { parseModelValue } from "../src/acp/config.ts";
import { entryToSessionUpdates, toSessionUpdate } from "../src/acp/feed.ts";
import { extractPromptText, Handlers } from "../src/acp/handlers.ts";
import { makeApp, Server } from "../src/acp/server.ts";

const rootCatalog = fileURLToPath(new URL("../../../models.gen.json", import.meta.url));
const aikitCatalog = fileURLToPath(new URL("../../aikit/models.gen.json", import.meta.url));
process.env.CODEWORK_MODELS_FILE ??= existsSync(rootCatalog) ? rootCatalog : aikitCatalog;

const homes: string[] = [];
const makeLayer = (options: Harness.Options = {}) => {
	const home = mkdtempSync(join(tmpdir(), "codework-acp-"));
	homes.push(home);
	return Server.layer({ harness: { home, database: ":memory:", ...options } });
};

describe("ACP (Agent Client Protocol) SDK Integration", () => {
	afterAll(() => {
		for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
	});
	it("initialize returns protocol version and agent capabilities", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const result = yield* handlers.initialize({
				protocolVersion: acp.PROTOCOL_VERSION,
				clientInfo: { name: "zed", version: "0.1.0" },
			});
			expect(result.protocolVersion).toBe(acp.PROTOCOL_VERSION);
			expect(result.agentCapabilities?.loadSession).toBe(true);
			expect(result.agentCapabilities?.sessionCapabilities?.list).toBeDefined();
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise));

	it("session/new and session/load create and attach sessions with configOptions", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });
			expect(created.sessionId.startsWith("ses_")).toBe(true);
			expect(created.configOptions).toBeDefined();
			const modelOption = created.configOptions?.find((o) => o.category === "model");
			expect(modelOption).toBeDefined();
			expect(modelOption?.id).toBe("model");
			expect(modelOption?.type).toBe("select");
			if (modelOption && modelOption.type === "select") {
				expect(modelOption.options.length).toBeGreaterThan(0);
			}

			const thoughtOption = created.configOptions?.find((o) => o.category === "thought_level");
			expect(thoughtOption).toBeDefined();
			expect(thoughtOption?.id).toBe("thought_level");
			expect(thoughtOption?.type).toBe("select");

			const loaded = yield* handlers.loadSession({
				sessionId: created.sessionId,
				cwd: process.cwd(),
				mcpServers: [],
			});
			expect(loaded.configOptions).toBeDefined();
			const loadedModelOption = loaded.configOptions?.find((o) => o.category === "model");
			expect(loadedModelOption).toBeDefined();
			const loadedThoughtOption = loaded.configOptions?.find((o) => o.category === "thought_level");
			expect(loadedThoughtOption).toBeDefined();
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise));

	it("session/set_config_option updates model option and thinking level option", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });
			expect(created.configOptions).toBeDefined();

			const updatedModel = yield* handlers.setConfigOption({
				sessionId: created.sessionId,
				configId: "model",
				value: "google/gemini-2.5-pro",
			});
			const modelOption = updatedModel.configOptions.find((o) => o.id === "model");
			expect(modelOption?.currentValue).toBe("google/gemini-2.5-pro");

			const updatedThought = yield* handlers.setConfigOption({
				sessionId: created.sessionId,
				configId: "thought_level",
				value: "low",
			});
			const thoughtOption = updatedThought.configOptions.find((o) => o.id === "thought_level");
			expect(thoughtOption?.currentValue).toBe("low");

			const nonReasoningModel = yield* handlers.setConfigOption({
				sessionId: created.sessionId,
				configId: "model",
				value: "openai/gpt-4o",
			});
			const gpt4oModelOption = nonReasoningModel.configOptions.find((o) => o.id === "model");
			expect(gpt4oModelOption?.currentValue).toBe("openai/gpt-4o");
			const gpt4oThoughtOption = nonReasoningModel.configOptions.find((o) => o.id === "thought_level");
			expect(gpt4oThoughtOption).toBeUndefined();
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise));

	it("session/list returns existing sessions", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });

			const list = yield* handlers.listSessions({});
			expect(list.sessions.length).toBeGreaterThan(0);
			const found = list.sessions.find((s) => s.sessionId === created.sessionId);
			expect(found).toBeDefined();
			expect(found?.cwd).toBe(process.cwd());
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise));

	it("session/prompt runs a turn and returns end_turn", () => {
		const contexts: Parameters<typeof immediateOpen>[0] = [];
		const llm = immediateOpen(contexts);
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: project, mcpServers: [] });

			const result = yield* handlers.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "Hello from ACP client" }],
			});
			expect(result.stopReason).toBe("end_turn");
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm })), Effect.runPromise);
	});

	it("session/cancel interrupts an active session", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });

			const result = yield* handlers.cancel({ sessionId: created.sessionId });
			expect(result.cancelled).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise));

	it("toSessionUpdate maps text delta events to agent_message_chunk", () => {
		const sessionId = Session.SessionSchema.ID.create();
		const update = toSessionUpdate({
			id: EventSchema.ID.create(),
			type: "session.llm.text.delta",
			data: { sessionId, delta: "hello world", partIndex: 0, messageId: "msg_1" },
		});

		expect(update).toEqual({
			sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: {
					type: "text",
					text: "hello world",
				},
			},
		});
	});

	it("toSessionUpdate maps tool started, progress, and settled events to ACP tool_call updates", () => {
		const sessionId = Session.SessionSchema.ID.create();

		// 1. Tool started
		const startUpdate = toSessionUpdate({
			id: EventSchema.ID.create(),
			type: "session.tool.started",
			data: { sessionId, callID: "call_123", name: "bash", messageId: "msg_1" },
		});

		expect(startUpdate).toEqual({
			sessionId,
			update: {
				sessionUpdate: "tool_call",
				toolCallId: "call_123",
				title: "bash",
				name: "bash",
				kind: "execute",
				status: "in_progress",
			},
		});

		// 2. Tool progress
		const progressUpdate = toSessionUpdate({
			id: EventSchema.ID.create(),
			type: "session.tool.progress",
			data: { sessionId, callID: "call_123", partial: "Building package...\n" },
		});

		expect(progressUpdate).toEqual({
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "call_123",
				status: "in_progress",
				rawOutput: "Building package...\n",
			},
		});

		// 3. Tool settled (completed)
		const settledUpdate = toSessionUpdate({
			id: EventSchema.ID.create(),
			type: "session.tool.settled",
			data: {
				sessionId,
				callID: "call_123",
				part: {
					name: "bash",
					status: "completed",
					arguments: { command: "pnpm test" },
					result: {
						content: [{ type: "text", text: "Tests passed!" }],
						isError: false,
					},
				},
			},
		});

		expect(settledUpdate).toEqual({
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "call_123",
				title: "Run: pnpm test",
				name: "bash",
				kind: "execute",
				status: "completed",
				rawInput: { command: "pnpm test" },
				rawOutput: {
					content: [{ type: "text", text: "Tests passed!" }],
					isError: false,
				},
				content: [{ type: "content", content: { type: "text", text: "Tests passed!" } }],
			},
		});

		// 4. Tool settled (failed/error)
		const errorUpdate = toSessionUpdate({
			id: EventSchema.ID.create(),
			type: "session.tool.settled",
			data: {
				sessionId,
				callID: "call_456",
				part: {
					name: "read_file",
					status: "error",
					arguments: { path: "src/missing.ts" },
					result: {
						content: [{ type: "text", text: "File not found" }],
						isError: true,
					},
				},
			},
		});

		expect(errorUpdate).toEqual({
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: "call_456",
				title: "read_file: src/missing.ts",
				name: "read_file",
				kind: "read",
				status: "failed",
				rawInput: { path: "src/missing.ts" },
				rawOutput: {
					content: [{ type: "text", text: "File not found" }],
					isError: true,
				},
				content: [{ type: "content", content: { type: "text", text: "File not found" } }],
			},
		});
	});

	it("ACP Client connects to AgentApp and executes protocol turn with streaming updates", () => {
		const contexts: Parameters<typeof immediateOpen>[0] = [];
		const llm = immediateOpen(contexts);
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const app = makeApp(handlers);

			const updates: acp.SessionNotification[] = [];
			const clientApp = acp
				.client({ name: "zed-test-client" })
				.onNotification(acp.methods.client.session.update, (ctx) => {
					updates.push(ctx.params);
				});

			// Direct in-process connection between SDK ClientApp and AgentApp
			const clientConn = clientApp.connect(app);

			try {
				const initResult = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.initialize, {
						protocolVersion: acp.PROTOCOL_VERSION,
						clientInfo: { name: "zed", version: "0.1.0" },
					}),
				);
				expect(initResult.protocolVersion).toBe(acp.PROTOCOL_VERSION);

				const sessionResult = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.session.new, {
						cwd: project,
						mcpServers: [],
					}),
				);
				expect(sessionResult.sessionId.startsWith("ses_")).toBe(true);

				const promptResult = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.session.prompt, {
						sessionId: sessionResult.sessionId,
						prompt: [{ type: "text", text: "Hello ACP from Zed client" }],
					}),
				);
				expect(promptResult.stopReason).toBe("end_turn");

				// 4. Verify session/list returns the session
				const listResult = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.session.list, {}),
				);
				expect(listResult.sessions.length).toBeGreaterThan(0);
				expect(listResult.sessions.some((s) => s.sessionId === sessionResult.sessionId)).toBe(true);

				// 5. Verify updates were streamed to the client
				expect(updates.length).toBeGreaterThan(0);
				const messageChunks = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
				expect(messageChunks.length).toBeGreaterThan(0);

				// 6. Test session/load replays conversation history to client via session/update notifications
				updates.length = 0;
				const loadResult = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.session.load, {
						sessionId: sessionResult.sessionId,
						cwd: project,
						mcpServers: [],
					}),
				);
				expect(loadResult.configOptions).toBeDefined();

				const replayedUserMessages = updates.filter((u) => u.update.sessionUpdate === "user_message_chunk");
				expect(replayedUserMessages.length).toBeGreaterThan(0);
				const userChunk = replayedUserMessages[0]?.update as { content: { type: string; text: string } };
				expect(userChunk.content.text).toBe("Hello ACP from Zed client");

				const replayedAgentMessages = updates.filter((u) => u.update.sessionUpdate === "agent_message_chunk");
				expect(replayedAgentMessages.length).toBeGreaterThan(0);
			} finally {
				clientConn.close();
			}
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm })), Effect.runPromise);
	});

	it("entryToSessionUpdates converts hydrated session entries to ACP replay updates", () => {
		const epoch = DateTime.makeUnsafe(0);

		// 1. User entry
		const userUpdates = entryToSessionUpdates({
			entry: {
				id: "msg_user_1",
				sessionId: Session.SessionSchema.ID.make("ses_1"),
				parentId: Option.none(),
				seq: 1,
				type: "user",
				state: "committed",
				data: JSON.stringify({ prompt: "What is 2+2?" }),
				label: Option.none(),
				metadata: Option.none(),
				createdAt: epoch,
				updatedAt: epoch,
			},
			parts: [
				{
					id: "part_u1",
					entryId: "msg_user_1",
					sessionId: Session.SessionSchema.ID.make("ses_1"),
					partIndex: 0,
					type: "text",
					toolName: Option.none(),
					callId: Option.none(),
					status: Option.none(),
					createdAt: epoch,
					updatedAt: epoch,
					data: JSON.stringify({ text: "What is 2+2?" }),
				},
			],
		});
		expect(userUpdates).toEqual([
			{
				sessionUpdate: "user_message_chunk",
				messageId: "msg_user_1",
				content: { type: "text", text: "What is 2+2?" },
			},
		]);

		// 2. Assistant entry with thinking, toolCall, and text
		const assistantUpdates = entryToSessionUpdates({
			entry: {
				id: "msg_assistant_1",
				sessionId: Session.SessionSchema.ID.make("ses_1"),
				parentId: Option.some("msg_user_1"),
				seq: 2,
				type: "assistant",
				state: "committed",
				data: "",
				label: Option.none(),
				metadata: Option.none(),
				createdAt: epoch,
				updatedAt: epoch,
			},
			parts: [
				{
					id: "part_a1",
					entryId: "msg_assistant_1",
					sessionId: Session.SessionSchema.ID.make("ses_1"),
					partIndex: 0,
					type: "thinking",
					toolName: Option.none(),
					callId: Option.none(),
					status: Option.none(),
					createdAt: epoch,
					updatedAt: epoch,
					data: JSON.stringify({ text: "Thinking about math..." }),
				},
				{
					id: "part_a2",
					entryId: "msg_assistant_1",
					sessionId: Session.SessionSchema.ID.make("ses_1"),
					partIndex: 1,
					type: "toolCall",
					toolName: Option.some("calc"),
					callId: Option.some("call_calc_1"),
					status: Option.some("completed"),
					createdAt: epoch,
					updatedAt: epoch,
					data: JSON.stringify({
						callID: "call_calc_1",
						name: "calc",
						arguments: { expr: "2+2" },
						result: "4",
						status: "completed",
					}),
				},
				{
					id: "part_a3",
					entryId: "msg_assistant_1",
					sessionId: Session.SessionSchema.ID.make("ses_1"),
					partIndex: 2,
					type: "text",
					toolName: Option.none(),
					callId: Option.none(),
					status: Option.none(),
					createdAt: epoch,
					updatedAt: epoch,
					data: JSON.stringify({ text: "2+2 is 4." }),
				},
			],
		});

		expect(assistantUpdates.length).toBe(4);
		expect(assistantUpdates[0]).toEqual({
			sessionUpdate: "agent_thought_chunk",
			messageId: "msg_assistant_1",
			content: { type: "text", text: "Thinking about math..." },
		});
		expect(assistantUpdates[1]).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "call_calc_1",
			title: "calc",
			name: "calc",
			kind: "other",
			status: "in_progress",
			rawInput: { expr: "2+2" },
		});
		expect(assistantUpdates[2]).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "call_calc_1",
			title: "calc",
			name: "calc",
			kind: "other",
			status: "completed",
			rawInput: { expr: "2+2" },
			rawOutput: "4",
			content: [{ type: "content", content: { type: "text", text: "4" } }],
		});
		expect(assistantUpdates[3]).toEqual({
			sessionUpdate: "agent_message_chunk",
			messageId: "msg_assistant_1",
			content: { type: "text", text: "2+2 is 4." },
		});
	});

	it("parseModelValue preserves full model ID with slashes", () => {
		expect(parseModelValue("openrouter/meta/muse-spark-1.3-contributor")).toEqual({
			provider: "openrouter",
			modelId: "meta/muse-spark-1.3-contributor",
		});
		expect(parseModelValue("openai/gpt-4o")).toEqual({
			provider: "openai",
			modelId: "gpt-4o",
		});
		expect(parseModelValue("gemini-2.5-pro", "google")).toEqual({
			provider: "google",
			modelId: "gemini-2.5-pro",
		});
		expect(parseModelValue("claude-3-7-sonnet")).toEqual({
			provider: "openai",
			modelId: "claude-3-7-sonnet",
		});
	});

	it("extractPromptText formats text, resource with uri, resource_link, and unsupported media", () => {
		const text = extractPromptText([
			{ type: "text", text: "Hello" },
			{
				type: "resource",
				resource: { uri: "file:///path/to/file.ts", text: "const x = 1;" },
			},
			{
				type: "resource_link",
				uri: "file:///path/to/doc.md",
				name: "Doc",
				mimeType: "text/markdown",
			},
			{
				type: "image",
				data: "base64data",
				mimeType: "image/png",
			},
		]);
		expect(text).toContain("Hello");
		expect(text).toContain("```file:///path/to/file.ts\nconst x = 1;\n```");
		expect(text).toContain("[Resource: Doc (file:///path/to/doc.md) [text/markdown]]");
		expect(text).toContain("[Attached image: not currently supported]");
	});

	it("session/set_config_option validates options and rejects invalid inputs", () => {
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: project, mcpServers: [] });

			// Invalid thinking level
			const invalidThought = yield* handlers
				.setConfigOption({
					sessionId: created.sessionId,
					configId: "thought_level",
					value: "infinite",
				})
				.pipe(Effect.flip);
			expect(invalidThought).toBeInstanceOf(acp.RequestError);
			expect((invalidThought as acp.RequestError).code).toBe(-32602);

			// Unknown model
			const unknownModel = yield* handlers
				.setConfigOption({
					sessionId: created.sessionId,
					configId: "model",
					value: "fake-provider/non-existent-model",
				})
				.pipe(Effect.flip);
			expect(unknownModel).toBeInstanceOf(acp.RequestError);
			expect((unknownModel as acp.RequestError).code).toBe(-32602);

			// Unknown config option
			const unknownOption = yield* handlers
				.setConfigOption({
					sessionId: created.sessionId,
					configId: "unsupported_option",
					value: "val",
				})
				.pipe(Effect.flip);
			expect(unknownOption).toBeInstanceOf(acp.RequestError);
			expect((unknownOption as acp.RequestError).code).toBe(-32602);
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise);
	});

	it("app translates SessionNotFoundError to JSON-RPC resourceNotFound (-32002)", () => {
		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const app = makeApp(handlers);
			const clientApp = acp.client({ name: "zed-test-client" });
			const clientConn = clientApp.connect(app);

			try {
				let rejected: acp.RequestError | undefined;
				yield* Effect.promise(async () => {
					try {
						await clientConn.agent.request(acp.methods.agent.session.prompt, {
							sessionId: "ses_nonexistent123",
							prompt: [{ type: "text", text: "hello" }],
						});
					} catch (err) {
						rejected = err as acp.RequestError;
					}
				});
				expect(rejected).toBeInstanceOf(acp.RequestError);
				expect(rejected?.code).toBe(-32002);
			} finally {
				clientConn.close();
			}
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise);
	});

	it("session/prompt rejects concurrent prompt on the same session", () => {
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		let inFlightResolve: () => void;
		const inFlight = new Promise<void>((r) => {
			inFlightResolve = r;
		});

		const slowLlm: Harness.Options["llm"] = (input, signal) =>
			Effect.sync(() => {
				const message = assistant(input, 1, { stopReason: "aborted" });
				const events = createAssistantMessageEventStream();
				events.push({ type: "start", partial: message });
				inFlightResolve();
				signal.addEventListener("abort", () => {
					events.push({ type: "error", reason: "aborted", error: message });
				});
				return events;
			});

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: project, mcpServers: [] });

			const fiber = yield* handlers
				.prompt({
					sessionId: created.sessionId,
					prompt: [{ type: "text", text: "First prompt" }],
				})
				.pipe(Effect.forkChild);

			// Wait until first prompt enters slowLlm
			yield* Effect.promise(() => inFlight);

			const concurrentError = yield* handlers
				.prompt({
					sessionId: created.sessionId,
					prompt: [{ type: "text", text: "Second prompt" }],
				})
				.pipe(Effect.flip);

			expect(concurrentError).toBeInstanceOf(acp.RequestError);
			expect((concurrentError as acp.RequestError).code).toBe(-32602);
			expect((concurrentError as acp.RequestError).message).toContain("already in progress");

			yield* handlers.cancel({ sessionId: created.sessionId });
			const result = yield* Fiber.join(fiber);
			expect(result.stopReason).toBe("cancelled");
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm: slowLlm })), Effect.runPromise);
	});

	it("session/prompt returns stopReason: max_tokens when LLM finishes with length", () => {
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		const lengthLlm: Harness.Options["llm"] = (input) =>
			Effect.sync(() => {
				const message = assistant(input, 1, { stopReason: "length" });
				const events = createAssistantMessageEventStream();
				events.push({ type: "start", partial: message });
				events.push({ type: "done", reason: "length", message });
				return events;
			});

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: project, mcpServers: [] });

			const result = yield* handlers.prompt({
				sessionId: created.sessionId,
				prompt: [{ type: "text", text: "Long output prompt" }],
			});
			expect(result.stopReason).toBe("max_tokens");
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm: lengthLlm })), Effect.runPromise);
	});

	it("session/prompt returns RequestError.internalError when LLM fails", () => {
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		const failingLlm: Harness.Options["llm"] = (input) =>
			Effect.sync(() => {
				const message = assistant(input, 1, {
					stopReason: "error",
					errorMessage: "Model quota exceeded",
				});
				const events = createAssistantMessageEventStream();
				events.push({ type: "start", partial: message });
				events.push({ type: "error", reason: "error", error: message });
				return events;
			});

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: project, mcpServers: [] });

			const error = yield* handlers
				.prompt({
					sessionId: created.sessionId,
					prompt: [{ type: "text", text: "Fail prompt" }],
				})
				.pipe(Effect.flip);

			expect(error).toBeInstanceOf(acp.RequestError);
			expect((error as acp.RequestError).code).toBe(-32603);
			expect((error as acp.RequestError).message.toLowerCase()).toContain("model quota exceeded");
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm: failingLlm })), Effect.runPromise);
	});

	it("session/cancel during turn returns stopReason: cancelled without error updates", () => {
		const project = mkdtempSync(join(tmpdir(), "codework-acp-project-"));
		homes.push(project);

		let inFlightResolve: () => void;
		const inFlight = new Promise<void>((r) => {
			inFlightResolve = r;
		});

		const slowLlm: Harness.Options["llm"] = (input, signal) =>
			Effect.sync(() => {
				const message = assistant(input, 1, { stopReason: "aborted" });
				const events = createAssistantMessageEventStream();
				events.push({ type: "start", partial: message });
				inFlightResolve();
				signal.addEventListener("abort", () => {
					events.push({ type: "error", reason: "aborted", error: message });
				});
				return events;
			});

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const app = makeApp(handlers);
			const updates: acp.SessionNotification[] = [];
			const clientApp = acp
				.client({ name: "zed-test-client" })
				.onNotification(acp.methods.client.session.update, (ctx) => {
					updates.push(ctx.params);
				});
			const clientConn = clientApp.connect(app);

			try {
				const created = yield* Effect.promise(() =>
					clientConn.agent.request(acp.methods.agent.session.new, {
						cwd: project,
						mcpServers: [],
					}),
				);

				const promptPromise = clientConn.agent.request(acp.methods.agent.session.prompt, {
					sessionId: created.sessionId,
					prompt: [{ type: "text", text: "Long turn to cancel" }],
				});

				// Wait until LLM request has started
				yield* Effect.promise(() => inFlight);

				yield* Effect.promise(() =>
					clientConn.agent.notify(acp.methods.agent.session.cancel, {
						sessionId: created.sessionId,
					}),
				);

				const promptResult = yield* Effect.promise(() => promptPromise);
				expect(promptResult.stopReason).toBe("cancelled");

				// Ensure no fake error message chunk was streamed
				const errorChunks = updates.filter(
					(u) =>
						u.update.sessionUpdate === "agent_message_chunk" &&
						"content" in u.update &&
						typeof u.update.content === "object" &&
						u.update.content !== null &&
						"text" in u.update.content &&
						typeof u.update.content.text === "string" &&
						u.update.content.text.includes("aborted"),
				);
				expect(errorChunks.length).toBe(0);
			} finally {
				clientConn.close();
			}
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm: slowLlm })), Effect.runPromise);
	});

	it("session/list filters by cwd and paginates with cursor", () => {
		const dirA = mkdtempSync(join(tmpdir(), "codework-acp-dirA-"));
		const dirB = mkdtempSync(join(tmpdir(), "codework-acp-dirB-"));
		homes.push(dirA, dirB);

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			yield* handlers.newSession({ cwd: dirA, mcpServers: [] });
			yield* handlers.newSession({ cwd: dirA, mcpServers: [] });
			const s3 = yield* handlers.newSession({ cwd: dirB, mcpServers: [] });

			// Filter by cwd
			const listA = yield* handlers.listSessions({ cwd: dirA });
			expect(listA.sessions.length).toBe(2);
			expect(listA.sessions.every((s) => s.cwd === dirA)).toBe(true);

			const listB = yield* handlers.listSessions({ cwd: dirB });
			expect(listB.sessions.length).toBe(1);
			expect(listB.sessions[0]?.sessionId).toBe(s3.sessionId);

			// Cursor pagination
			const all = yield* handlers.listSessions({});
			expect(all.sessions.length).toBeGreaterThanOrEqual(3);
			const firstId = all.sessions[0]?.sessionId;
			const paged = yield* handlers.listSessions({ cursor: firstId ?? null });
			expect(paged.sessions.some((s) => s.sessionId === firstId)).toBe(false);
		}).pipe(Effect.scoped, Effect.provide(makeLayer()), Effect.runPromise);
	});
});
