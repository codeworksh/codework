/* @effect-diagnostics nodeBuiltinImport:off -- the suite boots a temp home and a local server. */
import { Effect, Queue } from "effect";
import { HttpServer } from "effect/unstable/http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { Server } from "../../codework/src/server/server.ts";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import type { ChatMessage, LiveEvent } from "../src/bridge.ts";
import { applyEvent, sessionsFor, UnlinkedRepo } from "../src/renderer/api.ts";
import { connect, type Handle } from "../src/rpc.ts";

process.env.CODEWORK_MODELS_FILE ??= fileURLToPath(new URL("../../../models.gen.json", import.meta.url));

const homes: string[] = [];

afterAll(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const websocket = () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-desktop-")));
	homes.push(home);
	return {
		home,
		layer: Server.layer({
			host: "127.0.0.1",
			port: 0,
			harness: { home, hostCwd: home, database: ":memory:", plugins: [], llm: immediateOpen() },
		}),
	};
};

const urlOf = Effect.fn("Desktop.urlOf")(function* () {
	const server = yield* HttpServer.HttpServer;
	if (server.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
	return `ws://127.0.0.1:${server.address.port}/rpc`;
});

const collectUntilEnded = (queue: Queue.Queue<LiveEvent>) =>
	Effect.gen(function* () {
		const events: LiveEvent[] = [];
		while (true) {
			const event = yield* Queue.take(queue);
			events.push(event);
			if (event.kind === "ended") return events;
		}
	});

const artifactOf = (input: {
	readonly home: string;
	readonly handle: Handle;
	readonly created: { readonly title: string; readonly directory: string; readonly hostDir?: string };
	readonly listedBefore: number;
	readonly listedAfter: number;
	readonly events: ReadonlyArray<LiveEvent>;
	readonly transcript: ReadonlyArray<{ readonly role: string; readonly content: string }>;
}) => ({
	connected: true,
	url: input.handle.url.replace(/:\d+\//, ":<port>/"),
	listedBefore: input.listedBefore,
	created: {
		title: input.created.title,
		directory: input.created.directory === input.home ? "<home>" : input.created.directory,
		hostDir: input.created.hostDir === input.home ? "<home>" : input.created.hostDir,
	},
	listedAfter: input.listedAfter,
	events: input.events.map((event) => {
		if (event.kind === "user" || event.kind === "assistant") return { kind: event.kind, content: event.content };
		if (event.kind === "delta") return { kind: event.kind, delta: event.delta };
		return event.outcome === "failed"
			? { kind: event.kind, outcome: event.outcome, message: event.message }
			: { kind: event.kind, outcome: event.outcome };
	}),
	transcript: input.transcript.map(({ role, content }) => ({ role, content })),
});

describe("desktop rpc", () => {
	it("lists, creates, and streams a prompt against a real server", async () => {
		const { home, layer } = websocket();
		const artifact = await Effect.gen(function* () {
			const url = yield* urlOf();
			const queue = yield* Queue.unbounded<LiveEvent>();
			const handle = yield* connect(url, (event) => {
				Queue.offerUnsafe(queue, event);
			});
			const listedBefore = yield* handle.list;
			const created = yield* handle.create({ title: "Desktop", hostDir: home });
			const loose = yield* handle.create({ title: "Loose" });
			const listedAfter = yield* handle.list;
			yield* handle.prompt({ sessionId: created.id, text: "hello" });
			const events = yield* collectUntilEnded(queue).pipe(Effect.timeout("10 seconds"));
			const transcript = events.reduce<ReadonlyArray<ChatMessage>>((thread, event) => applyEvent(thread, event), []);
			expect(created.hostDir).toBe(home);
			expect(sessionsFor(listedAfter, home).map((row) => row.id)).toEqual([created.id]);
			expect(sessionsFor(listedAfter, UnlinkedRepo).map((row) => row.id)).toEqual([loose.id]);
			return artifactOf({
				home,
				handle,
				created,
				listedBefore: listedBefore.length,
				listedAfter: listedAfter.filter((row) => row.id === created.id).length,
				events,
				transcript,
			});
		}).pipe(Effect.scoped, Effect.provide(layer), Effect.timeout("15 seconds"), Effect.runPromise);
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/rpc-shell.json");
	});
});
