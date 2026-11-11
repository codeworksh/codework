/* @effect-diagnostics nodeBuiltinImport:off -- starts the real desktop server in a temporary home. */
import { Session } from "@codeworksh/harness/effect";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { Contract as Desktop } from "../../../apps/contract/src/contract.ts";
import { Codework as Mirror } from "../../../apps/widget/src/codework.ts";
import { Json, threadKey, topics, type ThreadRef } from "../../../apps/web/src/widgets/session/schema.ts";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import * as Client from "../src/server/client.ts";
import * as Server from "../src/server/server.ts";
import { testModel } from "./utils/model.ts";

const protocol = (url: string) =>
	RpcClient.layerProtocolSocket().pipe(
		Layer.provide(Socket.layerWebSocket(url)),
		Layer.provide(Socket.layerWebSocketConstructorGlobal),
		Layer.provide(RpcSerialization.layerNdjson),
	);

it("desktop keeps fork history, configuration and prompts separate from main", async () => {
	const home = mkdtempSync(join(tmpdir(), "codework-desktop-threads-"));
	writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ model: testModel }));
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const url = `ws://127.0.0.1:${listener.address.port}/rpc/v1`;
			const rpcContext = yield* Layer.build(Client.layer(url));
			const rpc = yield* Client.make.pipe(Effect.provideContext(rpcContext));
			const mirrorContext = yield* Layer.build(protocol(url));
			const mirror = yield* RpcClient.make(Mirror.Api).pipe(Effect.provideContext(mirrorContext));
			const created = yield* mirror["session.create"]({ directory: home });
			const sessionId = Session.SessionSchema.ID.make(created.session.id);
			yield* mirror["thread.prompt"]({ sessionId, text: "Main prompt" });
			yield* rpc["thread.wait"]({ sessionId });
			const history = yield* rpc["thread.history"]({ sessionId });
			const fork = yield* rpc["thread.fork"]({ sessionId, entryId: history.entries.at(-1)!.id });
			const ref = { sessionId, threadId: fork.thread.id };
			const child = yield* Effect.acquireRelease(
				Effect.sync(() =>
					spawn(process.execPath, [fileURLToPath(new URL("../../../apps/server/src/index.ts", import.meta.url))], {
						env: { ...process.env, CODEWORK_HOME_DIR: home, CODEWORK_DATABASE: join(home, "app.db") },
						stdio: ["ignore", "pipe", "inherit"],
					}),
				),
				(child) =>
					Effect.promise(
						() =>
							new Promise<void>((resolve) => {
								if (child.exitCode !== null || child.signalCode !== null) return resolve();
								child.once("exit", () => resolve());
								child.kill("SIGKILL");
							}),
					),
			);
			const port = yield* Effect.tryPromise(
				() =>
					new Promise<number>((resolve, reject) => {
						child.once("exit", (code) => reject(new Error(`App server exited: ${code}`)));
						createInterface({ input: child.stdout! }).on("line", (line) => {
							if (line.startsWith('{"type":"ready"')) resolve((JSON.parse(line) as { port: number }).port);
						});
					}),
			);
			const appContext = yield* Layer.build(protocol(`ws://127.0.0.1:${port}/rpc`));
			const app = yield* RpcClient.make(Desktop.Api).pipe(Effect.provideContext(appContext));
			const ask = (topic: string, payload: Schema.Json) => app["event.request"]({ topic, payload, source: "test" });
			for (const target of [{ sessionId }, ref])
				expect((yield* ask(topics.follow, target)).payload).toEqual({ _tag: "Done" });
			expect((yield* ask(topics.configure, { ...ref, thinkingLevel: "high" })).payload).toEqual({ _tag: "Done" });
			expect((yield* mirror["thread.info"](ref)).thinkingLevel).toBe("high");
			expect((yield* mirror["thread.info"]({ sessionId })).thinkingLevel).toBeUndefined();
			expect((yield* ask(topics.prompt, { ...ref, messageId: "fork-prompt", text: "Fork prompt" })).payload).toEqual(
				{ _tag: "Done" },
			);
			yield* rpc["thread.wait"](ref);
			yield* app["event.subscribe"]({ topics: [topics.thread(threadKey(ref))], after: 0 }).pipe(
				Stream.filter(
					(item) =>
						"payload" in item &&
						Schema.is(Json.Update)(item.payload) &&
						item.payload._tag === "Message" &&
						item.payload.message.state === "committed" &&
						item.payload.message.parts.some((part) => part.type === "text" && part.text === "response 2"),
				),
				Stream.runHead,
			);
			const page = (target: ThreadRef) =>
				ask(topics.page, { ...target, limit: 60 }).pipe(
					Effect.flatMap((reply) => Schema.decodeUnknownEffect(Json.Window)(reply.payload)),
				);
			const main = yield* page({ sessionId });
			const branch = yield* page(ref);
			if (main._tag !== "Window" || branch._tag !== "Window") return yield* Effect.die("Missing page");
			expect(main.messages).toHaveLength(2);
			expect(branch.messages).toHaveLength(4);
			expect(branch.messages.slice(0, 2).every((entry) => entry.threadId === created.id)).toBe(true);
			expect(branch.messages.slice(2).every((entry) => entry.threadId === fork.thread.id)).toBe(true);
			const missing = yield* ask(topics.follow, { sessionId, threadId: "thr_missing" });
			expect(missing.payload).toEqual({ _tag: "Failed", message: "This thread no longer exists." });
			return {
				main: main.messages.map(({ role, state, parts }) => ({ role, state, parts })),
				fork: branch.messages.map(({ role, state, parts }) => ({ role, state, parts })),
				missing: missing.payload,
			};
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Server.layer({
					host: "127.0.0.1",
					port: 0,
					harness: { home, hostCwd: home, plugins: [], llm: immediateOpen() },
				}),
			),
			Effect.timeout("30 seconds"),
			Effect.runPromise,
		);
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
			"./__artifacts__/desktop.threads.json",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);
