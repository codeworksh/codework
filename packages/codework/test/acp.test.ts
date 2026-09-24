/* @effect-diagnostics nodeBuiltinImport:off -- fixtures only need temp dirs. */
import * as acp from "@agentclientprotocol/sdk";
import { EventSchema, Harness, Session } from "@codeworksh/harness/effect";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { toSessionUpdate } from "../src/acp/feed.ts";
import { Handlers } from "../src/acp/handlers.ts";
import { makeApp, Server } from "../src/acp/server.ts";

process.env.CODEWORK_MODELS_FILE ??= fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const homes: string[] = [];
const makeLayer = (options: Harness.Options = {}) => {
	const home = mkdtempSync(join(tmpdir(), "codework-acp-"));
	homes.push(home);
	return Server.layer({ harness: { home, database: ":memory:", ...options } });
};

afterAll(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("ACP (Agent Client Protocol) SDK Integration", () => {
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

	it("session/new and session/load create and attach sessions", () =>
		Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });
			expect(created.sessionId.startsWith("ses_")).toBe(true);

			const loaded = yield* handlers.loadSession({
				sessionId: created.sessionId,
				cwd: process.cwd(),
				mcpServers: [],
			});
			expect(loaded).toEqual({});
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

		return Effect.gen(function* () {
			const handlers = yield* Handlers.Service;
			const created = yield* handlers.newSession({ cwd: process.cwd(), mcpServers: [] });

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
						cwd: process.cwd(),
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
			} finally {
				clientConn.close();
			}
		}).pipe(Effect.scoped, Effect.provide(makeLayer({ llm })), Effect.runPromise);
	});
});
