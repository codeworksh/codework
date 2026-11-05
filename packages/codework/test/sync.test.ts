/* @effect-diagnostics nodeBuiltinImport:off -- starts the real server in a temporary home. */
import { Effect, Layer, Queue, Stream } from "effect";
import { HttpServer } from "effect/http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { immediateOpen } from "../../harness/test/fixtures/llm.ts";
import { Client } from "../src/server/client.ts";
import type { IndexItem } from "../src/server/contract.ts";
import { Server } from "../src/server/server.ts";

type Synced = Extract<IndexItem, { _tag: "Synced" }>;

it("index.sync sends the index, resumes from a revision, and follows configure, rename and delete", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-sync-index-")));
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${listener.address.port}/rpc/v1`));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));

			// Up to and including the first `Synced`: one catch-up.
			const catchUp = (after: number) =>
				rpc["index.sync"]({ after }).pipe(
					Stream.takeUntil((item) => item._tag === "Synced"),
					Stream.runCollect,
				);

			const live = yield* Queue.unbounded<IndexItem>();
			yield* rpc["index.sync"]({ after: 0 }).pipe(
				Stream.runForEach((item) => Queue.offer(live, item)),
				Effect.forkScoped,
			);
			const until = <A extends IndexItem>(match: (item: IndexItem) => item is A) =>
				Effect.gen(function* () {
					while (true) {
						const item = yield* Queue.take(live);
						if (match(item)) return item;
					}
				});
			const syncedAt = (rev: number) => until((item): item is Synced => item._tag === "Synced" && item.rev >= rev);

			const empty = yield* until((item): item is Synced => item._tag === "Synced");

			const created = yield* rpc["session.create"]({ directory: home, project: { name: "Alpha" } });
			const sessionId = created.session.id;
			yield* rpc["thread.configure"]({ sessionId, runtime: { thinkingLevel: "high" } });
			const configured = yield* until(
				(item): item is Extract<IndexItem, { _tag: "Thread" }> =>
					item._tag === "Thread" && item.thread.id === created.id && item.thread.thinkingLevel === "high",
			);
			yield* rpc["thread.prompt"]({ sessionId, text: "Main prompt" });
			yield* rpc["thread.wait"]({ sessionId });
			const reply = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1);
			if (reply === undefined) return yield* Effect.die("main thread has no reply");
			const fork = yield* rpc["thread.fork"]({ sessionId, entryId: reply.id });
			const forked = yield* syncedAt((yield* rpc["server.info"]({})).rev);

			const projectId = created.session.project?.id;
			if (projectId === undefined) return yield* Effect.die("session has no project");
			yield* rpc["project.rename"]({ projectId, name: "Beta" });
			const doomed = yield* rpc["session.create"]({ directory: home });
			yield* rpc["session.delete"]({ sessionId: doomed.session.id });
			const removed = yield* until(
				(item): item is Extract<IndexItem, { _tag: "Removed" }> =>
					item._tag === "Removed" && item.id === doomed.session.id,
			);
			const info = yield* rpc["server.info"]({});
			const last = yield* syncedAt(info.rev);

			const snapshot = yield* catchUp(0);
			const resumed = yield* catchUp(forked.rev);

			const labels = new Map<string, string>([
				[home, "<home>"],
				[info.storeId, "<store>"],
				[projectId, "<project>"],
				[created.session.spaceId, "<space>"],
				[sessionId, "<session>"],
				[created.session.slug, "<slug>"],
				[created.id, "<main>"],
				[doomed.session.id, "<doomed>"],
				[doomed.session.slug, "<doomed slug>"],
				[doomed.id, "<doomed main>"],
				[fork.thread.id, "<fork>"],
				[reply.id, "<reply>"],
			]);
			// Revisions by rank within the artifact: their order is the contract, their values are not.
			const revs = [...new Set([...snapshot, ...resumed].map((item) => item.rev))].sort((a, b) => a - b);
			const normalize = (value: unknown, key?: string): unknown => {
				if (typeof value === "string") return labels.get(value) ?? value;
				if (typeof value === "number") {
					if (key === "rev") return revs.includes(value) ? `<rev ${revs.indexOf(value)}>` : "<rev>";
					return key?.endsWith("At") ? "<time>" : value;
				}
				if (Array.isArray(value)) return value.map((item) => normalize(item));
				if (typeof value === "object" && value !== null)
					return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
				return value;
			};

			const tags = (items: ReadonlyArray<IndexItem>) => items.map((item) => item._tag);
			expect(empty.rev).toBe(0);
			expect(info.rev).toBe(last.rev);
			expect(last.storeId).toBe(info.storeId);
			expect(snapshot.at(-1)).toEqual({ _tag: "Synced", storeId: info.storeId, rev: info.rev });
			expect(tags(snapshot).filter((tag) => tag === "Thread")).toHaveLength(2);
			expect(snapshot.some((item) => item._tag === "Removed" && item.id === doomed.session.id)).toBe(true);
			expect(resumed.every((item) => item.rev > forked.rev || item._tag === "Synced")).toBe(true);
			expect(resumed.some((item) => item._tag === "Thread")).toBe(false);

			return normalize({
				info: { storeId: info.storeId, rev: info.rev === last.rev ? "<head>" : info.rev },
				configured: { ...configured, rev: "<rev>" },
				removed: { ...removed, rev: "<rev>" },
				snapshot,
				resumed,
			});
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
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/sync.index.json");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);
