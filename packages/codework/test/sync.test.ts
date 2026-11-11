/* @effect-diagnostics nodeBuiltinImport:off -- starts the real server in a temporary home. */
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Effect, Layer, Queue, Stream } from "effect";
import { Session } from "@codeworksh/harness/effect";
import { HttpServer } from "effect/http";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type * as LLM from "../../harness/src/runner/llm.ts";
import { assistant, immediateOpen } from "../../harness/test/fixtures/llm.ts";
import * as Client from "../src/server/client.ts";
import type { IndexItem, ThreadItem } from "../src/server/contract.ts";
import * as Server from "../src/server/server.ts";

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

it("updatedAt moves a thread with any change to it or below it, and its session with its own row or a new thread", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-sync-updated-")));
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${listener.address.port}/rpc/v1`));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));

			/** Every session's and thread's `updatedAt`, by id, as the index sends them. */
			const times = Effect.gen(function* () {
				const items = yield* rpc["index.sync"]({ after: 0 }).pipe(
					Stream.takeUntil((item) => item._tag === "Synced"),
					Stream.runCollect,
				);
				const at = new Map<string, number>();
				for (const item of items) {
					if (item._tag === "Session") at.set(item.session.id, item.session.updatedAt);
					if (item._tag === "Thread") at.set(item.thread.id, item.thread.updatedAt);
				}
				return at;
			});

			const created = yield* rpc["session.create"]({ directory: home });
			const sessionId = created.session.id;
			const rows: Record<string, string> = { session: sessionId, main: created.id };
			const steps: Array<Record<string, unknown>> = [];
			let before = yield* times;
			/** Runs `change` a clock tick after the last one, then records which rows it moved. */
			const step = <A, E>(name: string, change: Effect.Effect<A, E>) =>
				Effect.gen(function* () {
					yield* Effect.sleep("5 millis");
					const result = yield* change;
					const after = yield* times;
					const moved = Object.fromEntries(
						Object.entries(rows).map(([row, id]) => {
							const was = before.get(id);
							return [row, was === undefined ? "new" : after.get(id)! > was];
						}),
					);
					steps.push({ step: name, ...moved });
					before = after;
					return result;
				});

			yield* step("link the session", rpc["session.link"]({ sessionId, hostDir: Session.AbsolutePath.make(home) }));
			yield* step(
				"configure the main thread",
				rpc["thread.configure"]({ sessionId, runtime: { thinkingLevel: "high" } }),
			);
			yield* step(
				"prompt the main thread",
				rpc["thread.prompt"]({ sessionId, text: "Main prompt" }).pipe(
					Effect.andThen(rpc["thread.wait"]({ sessionId })),
				),
			);
			const reply = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1);
			if (reply === undefined) return yield* Effect.die("main thread has no reply");
			const fork = yield* rpc["thread.fork"]({ sessionId, entryId: reply.id }).pipe(
				Effect.tap((forked) => Effect.sync(() => (rows["fork"] = forked.thread.id))),
				(forking) => step("fork the main thread", forking),
			);
			yield* step(
				"prompt the fork",
				rpc["thread.prompt"]({ sessionId, threadId: fork.thread.id, text: "Fork prompt" }).pipe(
					Effect.andThen(rpc["thread.wait"]({ sessionId, threadId: fork.thread.id })),
				),
			);

			expect(steps).toEqual([
				{ step: "link the session", session: true, main: false },
				{ step: "configure the main thread", session: false, main: true },
				{ step: "prompt the main thread", session: false, main: true },
				{ step: "fork the main thread", session: true, main: false, fork: "new" },
				{ step: "prompt the fork", session: false, main: false, fork: true },
			]);
			return steps;
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
			"./__artifacts__/sync.updated.json",
		);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);

interface Reply {
	readonly thinking?: ReadonlyArray<string>;
	readonly text: ReadonlyArray<string>;
	/** Held after `start` until it resolves: the run sits mid-reply with its draft open. */
	readonly gate?: Promise<void>;
}

/** Request `n` streams `replies.get(n)`, one delta per chunk; any other answers `response <n>`. */
const scripted = (replies: ReadonlyMap<number, Reply>): LLM.Open => {
	let count = 0;
	return (input) =>
		Effect.sync(() => {
			count += 1;
			const index = count;
			const reply = replies.get(index) ?? { text: [`response ${index}`] };
			const blocks = [
				...(reply.thinking === undefined ? [] : [{ kind: "thinking" as const, chunks: reply.thinking }]),
				{ kind: "text" as const, chunks: reply.text },
			];
			const message = assistant(input, index, {
				parts: blocks.map(({ kind, chunks }): Message.AssistantMessage["parts"][number] =>
					kind === "thinking"
						? { type: "thinking", thinking: chunks.join("") }
						: { type: "text", text: chunks.join("") },
				),
			});
			// aikit grows one partial in place as the reply streams; checkpoints read it.
			const partial = assistant(input, index, { parts: [] });
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial });
			const rest = () => {
				blocks.forEach(({ kind, chunks }, partIndex) => {
					const content = chunks.join("");
					if (kind === "thinking") {
						const part = { type: "thinking" as const, thinking: "" };
						partial.parts.push(part);
						events.push({ type: "thinking.start", partIndex, partial });
						for (const delta of chunks) {
							part.thinking += delta;
							events.push({ type: "thinking.delta", partIndex, delta, partial });
						}
						events.push({ type: "thinking.end", partIndex, content, partial });
					} else {
						const part = { type: "text" as const, text: "" };
						partial.parts.push(part);
						events.push({ type: "text.start", partIndex, partial });
						for (const delta of chunks) {
							part.text += delta;
							events.push({ type: "text.delta", partIndex, delta, partial });
						}
						events.push({ type: "text.end", partIndex, content, partial });
					}
				});
				events.push({ type: "done", reason: "stop", message });
			};
			if (reply.gate === undefined) rest();
			else void reply.gate.then(rest);
			return events;
		});
};

type Entry = Extract<ThreadItem, { _tag: "Entry" }>;
type Delta = Extract<ThreadItem, { _tag: "Delta" }>;
type ThreadSynced = Extract<ThreadItem, { _tag: "Synced" }>;

it("thread.sync opens a fork's line within a budget, resumes from a revision, and streams live deltas", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-sync-thread-")));
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	// Requests in order: main 1 and 2, fork 3, fork 4 (held), the fork's follow-up 5, main 6, fork 7.
	const replies = new Map<number, Reply>([
		[4, { thinking: ["Weighing", " the ask"], text: ["Busy ", "reply ", "done"], gate: held }],
		[6, { text: ["Main ", "only"] }],
	]);
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${listener.address.port}/rpc/v1`));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));

			const created = yield* rpc["session.create"]({ directory: home });
			const sessionId = created.session.id;
			const mainId = created.id;
			yield* rpc["thread.prompt"]({ sessionId, text: "First prompt" });
			yield* rpc["thread.wait"]({ sessionId });
			yield* rpc["thread.prompt"]({ sessionId, text: "Second prompt" });
			yield* rpc["thread.wait"]({ sessionId });
			const cut = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1);
			if (cut === undefined) return yield* Effect.die("main thread has no reply");
			const forkId = (yield* rpc["thread.fork"]({ sessionId, entryId: cut.id })).thread.id;
			const fork = { sessionId, threadId: forkId };
			yield* rpc["thread.prompt"]({ ...fork, text: "Fork prompt" });
			yield* rpc["thread.wait"](fork);

			// The four newest entries of the fork's line fit; the fifth, inherited, does not.
			const line = (yield* rpc["thread.history"](fork)).entries;
			const budget = line.slice(-4).reduce((total, entry) => total + entry.size, 0);

			// Up to and including the first `Synced`.
			const catchUp = (after: number) =>
				rpc["thread.sync"]({ ...fork, after, budget }).pipe(
					Stream.takeUntil((item) => item._tag === "Synced"),
					Stream.runCollect,
				);
			const follow = (threadId: typeof forkId, after?: number) =>
				Effect.gen(function* () {
					const items: Array<ThreadItem> = [];
					const queue = yield* Queue.unbounded<ThreadItem>();
					yield* rpc["thread.sync"]({
						sessionId,
						threadId,
						...(after === undefined ? {} : { after }),
						budget,
					}).pipe(
						Stream.runForEach((item) =>
							Effect.sync(() => items.push(item)).pipe(Effect.andThen(Queue.offer(queue, item))),
						),
						Effect.forkScoped,
					);
					const until = <A extends ThreadItem>(match: (item: ThreadItem) => item is A) =>
						Effect.gen(function* () {
							while (true) {
								const item = yield* Queue.take(queue);
								if (match(item)) return item;
							}
						});
					return { items, until };
				});
			const isEntry =
				(id: string, state?: Entry["entry"]["state"]) =>
				(item: ThreadItem): item is Entry =>
					item._tag === "Entry" && item.entry.id === id && (state === undefined || item.entry.state === state);

			// (a) First open: the newest page of the fork's line, then `Synced` with its floor.
			const live = yield* follow(forkId);
			const openedAt = yield* live.until((item): item is ThreadSynced => item._tag === "Synced");
			const opened = [...live.items];

			// (b) A prompt held mid-reply, a follow-up queued behind it, then a resume.
			yield* rpc["thread.prompt"]({ ...fork, text: "Busy prompt" });
			yield* live.until(isEntry("assistant_4", "draft"));
			yield* rpc["thread.prompt"]({ ...fork, text: "Queued prompt", delivery: "followUp" });
			yield* live.until(
				(item): item is Extract<ThreadItem, { _tag: "Inbox" }> =>
					item._tag === "Inbox" && item.prompt.text === "Queued prompt",
			);
			const busy = yield* catchUp(openedAt.rev);
			const busyAt = busy.at(-1);
			if (busyAt?._tag !== "Synced") return yield* Effect.die("resume did not end at Synced");

			// (c) The held reply streams live; then its follow-up runs.
			release();
			yield* live.until(isEntry("assistant_4", "committed"));
			yield* rpc["thread.wait"](fork);
			const settled = yield* catchUp(busyAt.rev);

			// (d) A reply on the main thread streams on its own stream only.
			const head = (yield* rpc["server.info"]({})).rev;
			const main = yield* follow(mainId, head);
			yield* main.until((item): item is ThreadSynced => item._tag === "Synced");
			yield* rpc["thread.prompt"]({ sessionId, text: "Main prompt" });
			yield* rpc["thread.wait"]({ sessionId });
			yield* main.until(isEntry("assistant_6", "committed"));
			// The feed is one ordered queue, so the fork's next delta comes after any of main's.
			yield* rpc["thread.prompt"]({ ...fork, text: "Last prompt" });
			yield* live.until((item): item is Delta => item._tag === "Delta" && item.delta.entryId === "assistant_7");
			yield* rpc["thread.wait"](fork);

			const deltasOf = (items: ReadonlyArray<ThreadItem>, entryId: string) =>
				items.flatMap((item) => (item._tag === "Delta" && item.delta.entryId === entryId ? [item] : []));

			const info = yield* rpc["server.info"]({});
			const histories = [
				...(yield* rpc["thread.history"]({ sessionId })).entries,
				...(yield* rpc["thread.history"](fork)).entries,
			];
			const labels = new Map<string, string>([
				[home, "<home>"],
				[info.storeId, "<store>"],
				[sessionId, "<session>"],
				[mainId, "<main>"],
				[forkId, "<fork>"],
			]);
			let users = 0;
			for (const entry of histories)
				if (!labels.has(entry.id) && entry.role === "user") labels.set(entry.id, `<user ${(users += 1)}>`);
			const all = [...opened, ...busy, ...settled];
			// Revisions and seqs by rank: their order is the contract, their values are not.
			const rank = (values: ReadonlyArray<number>) => [...new Set(values)].sort((a, b) => a - b);
			const revs = rank(all.flatMap((item) => ("rev" in item ? [item.rev] : [])));
			const seqs = rank(histories.map((entry) => entry.seq));
			const normalize = (value: unknown, key?: string): unknown => {
				if (typeof value === "string") return labels.get(value) ?? value;
				if (typeof value === "number") {
					if (key === "rev") return revs.includes(value) ? `<rev ${revs.indexOf(value)}>` : "<rev>";
					if (key === "seq" || key === "floor")
						return seqs.includes(value) ? `<seq ${seqs.indexOf(value)}>` : "<seq>";
					return key?.endsWith("At") ? "<time>" : value;
				}
				if (Array.isArray(value)) return value.map((item) => normalize(item));
				if (typeof value === "object" && value !== null)
					return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
				return value;
			};

			const kept = line.slice(-4);
			const openedEntries = opened.flatMap((item) => (item._tag === "Entry" ? [item.entry.id] : []));
			expect(openedEntries).toEqual(kept.map((entry) => entry.id));
			expect(kept[0]?.threadId).toBe(mainId);
			expect(openedAt.floor).toBe(kept[0]?.seq);
			const rows = (items: ReadonlyArray<ThreadItem>) =>
				items.flatMap((item) => (item._tag === "Entry" || item._tag === "Inbox" ? [item] : []));
			expect(rows(busy).every((item) => item.rev > openedAt.rev)).toBe(true);
			expect(rows(settled).every((item) => item.rev > busyAt.rev)).toBe(true);
			expect(deltasOf(live.items, "assistant_6")).toEqual([]);
			expect(deltasOf(main.items, "assistant_6")).toHaveLength(2);

			return normalize({
				budget,
				line: line.map(({ id, threadId, seq, role, size }) => ({ id, threadId, seq, role, size })),
				opened,
				busy,
				settled,
				// Drafts re-send at most once a second, so only the deltas and the committed entry are kept.
				streamed: [...deltasOf(live.items, "assistant_4"), live.items.find(isEntry("assistant_4", "committed"))],
				otherThread: {
					main: deltasOf(main.items, "assistant_6"),
					seenOnFork: deltasOf(live.items, "assistant_6").length,
				},
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Server.layer({
					host: "127.0.0.1",
					port: 0,
					harness: { home, hostCwd: home, plugins: [], llm: scripted(replies) },
				}),
			),
			Effect.timeout("30 seconds"),
			Effect.runPromise,
		);
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/sync.thread.json");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);

it("thread.page reads a fork's line below thread.sync's floor, page by page, within a budget", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-sync-page-")));
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${listener.address.port}/rpc/v1`));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));

			const created = yield* rpc["session.create"]({ directory: home });
			const sessionId = created.session.id;
			for (const text of ["First prompt", "Second prompt", "Third prompt"]) {
				yield* rpc["thread.prompt"]({ sessionId, text });
				yield* rpc["thread.wait"]({ sessionId });
			}
			const cut = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1);
			if (cut === undefined) return yield* Effect.die("main thread has no reply");
			const forkId = (yield* rpc["thread.fork"]({ sessionId, entryId: cut.id })).thread.id;
			const fork = { sessionId, threadId: forkId };
			yield* rpc["thread.prompt"]({ ...fork, text: "Fork prompt" });
			yield* rpc["thread.wait"](fork);

			// Six inherited entries, then the fork's own two.
			const line = (yield* rpc["thread.history"](fork)).entries;
			type Entries = typeof line;
			const sizeOf = (entries: Entries) => entries.reduce((total, entry) => total + entry.size, 0);

			// A first open whose budget fits only the fork's own two entries.
			const opened = yield* rpc["thread.sync"]({ ...fork, budget: sizeOf(line.slice(-2)) }).pipe(
				Stream.takeUntil((item) => item._tag === "Synced"),
				Stream.runCollect,
			);
			const synced = opened.at(-1);
			if (synced?._tag !== "Synced" || synced.floor === undefined) return yield* Effect.die("open sent no floor");

			const limit = 3;
			const page = (before: number, budget?: number) =>
				rpc["thread.page"]({ ...fork, before, limit, ...(budget === undefined ? {} : { budget }) }).pipe(
					Effect.map(({ entries }) => ({ before, limit, ...(budget === undefined ? {} : { budget }), entries })),
				);
			const oldest = (entries: Entries) => entries[0]?.seq ?? 0;
			const first = yield* page(synced.floor);
			// Of the three entries below the first page, the budget fits the newest two: the oldest is left out.
			const below = line.filter((entry) => entry.seq < oldest(first.entries)).slice(-limit);
			const cutByBudget = yield* page(oldest(first.entries), sizeOf(below.slice(-2)));
			const last = yield* page(oldest(cutByBudget.entries));
			const past = yield* page(oldest(last.entries));

			const labels = new Map<string, string>([
				[home, "<home>"],
				[synced.storeId, "<store>"],
				[sessionId, "<session>"],
				[created.id, "<main>"],
				[forkId, "<fork>"],
			]);
			let users = 0;
			for (const entry of line)
				if (!labels.has(entry.id) && entry.role === "user") labels.set(entry.id, `<user ${(users += 1)}>`);
			// Seqs by rank in the line: their order is the contract, their values are not.
			const seqs = line.map((entry) => entry.seq);
			const normalize = (value: unknown, key?: string): unknown => {
				if (typeof value === "string") return labels.get(value) ?? value;
				if (typeof value === "number") {
					if (key === "seq" || key === "floor" || key === "before")
						return seqs.includes(value) ? `<seq ${seqs.indexOf(value)}>` : "<seq>";
					if (key === "rev") return "<rev>";
					return key?.endsWith("At") ? "<time>" : value;
				}
				if (Array.isArray(value)) return value.map((item) => normalize(item));
				if (typeof value === "object" && value !== null)
					return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
				return value;
			};

			const ids = (entries: Entries) => entries.map((entry) => entry.id);
			expect(line).toHaveLength(8);
			expect(synced.floor).toBe(line.at(-2)?.seq);
			expect(ids(first.entries)).toEqual(ids(line.slice(3, 6)));
			expect(first.entries.every((entry) => entry.threadId === created.id)).toBe(true);
			expect(ids(cutByBudget.entries)).toEqual(ids(line.slice(1, 3)));
			expect(ids(last.entries)).toEqual(ids(line.slice(0, 1)));
			expect(past.entries).toEqual([]);

			return normalize({
				line: line.map(({ id, threadId, seq, role, size }) => ({ id, threadId, seq, role, size })),
				opened,
				pages: [first, cutByBudget, last, past],
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
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/sync.page.json");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 40_000);
