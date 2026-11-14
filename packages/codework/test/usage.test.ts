/* @effect-diagnostics nodeBuiltinImport:off -- starts the real server in a temporary home. */
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Effect, Layer, Queue, Stream } from "effect";
import { HttpServer } from "effect/http";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import type * as LLM from "../../harness/src/runner/llm.ts";
import { assistant } from "../../harness/test/fixtures/llm.ts";
import * as Client from "../src/server/client.ts";
import { edges, type UsageItem } from "../src/server/contract.ts";
import * as Server from "../src/server/server.ts";
import { testModel } from "./utils/model.ts";

type Synced = Extract<UsageItem, { _tag: "Synced" }>;
type Row = Exclude<UsageItem, Synced>;

// 2020-01-01T00:00:00Z: every request is made in this hour; prompts are tallied in the real one.
const H = Date.UTC(2020, 0, 1);
// More tool names in one reply than one page holds (`Rows.batch`), so its revision spans two pages.
const wide = 600;

/** Request `n` of the server: 1 calls a tool, 4 calls `wide` tools at once, every other one stops. */
const scripted: LLM.Open = (() => {
	let count = 0;
	return (input) =>
		Effect.sync(() => {
			count += 1;
			const index = count;
			const calls = index === 1 ? ["probe"] : index === 4 ? Array.from({ length: wide }, (_, i) => `tool_${i}`) : [];
			const message = assistant(input, index, {
				usage: {
					input: 100 * index,
					output: 10 * index,
					cacheRead: index,
					cacheWrite: 0,
					totalTokens: 111 * index,
					cost: { input: 0.125 * index, output: 0.125 * index, cacheRead: 0, cacheWrite: 0, total: 0.25 * index },
				},
				time: { created: H + index * 1000, completed: H + index * 1000 + 300 * index },
				...(calls.length === 0
					? {}
					: {
							stopReason: "toolUse",
							parts: calls.map((name, i): Message.ToolCallPendingPart => ({
								type: "toolCall",
								callID: `call_${index}_${i}`,
								name,
								arguments: {},
								status: "pending",
								time: { start: H, end: H },
							})),
						}),
			});
			const events = createAssistantMessageEventStream();
			events.push({ type: "start", partial: message });
			events.push({ type: "done", reason: calls.length === 0 ? "stop" : "toolUse", message });
			return events;
		});
})();

const keyOf = (row: Row) =>
	row._tag === "Usage"
		? `usage|${row.hour}|${row.threadId}|${row.provider}|${row.model}|${row.thinking}`
		: `tally|${row.hour}|${row.threadId}|${row.kind}|${row.name}`;
const rowsOf = (items: ReadonlyArray<UsageItem>) =>
	items.flatMap((item): Array<Row> => (item._tag === "Synced" ? [] : [item]));
const isUsage = (item: UsageItem): item is Extract<UsageItem, { _tag: "Usage" }> => item._tag === "Usage";

it("usage.sync sends the rollup in revision order, resends rows with running totals, resumes and pages", async () => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-sync-usage-")));
	writeFileSync(join(home, "settings.jsonc"), JSON.stringify({ model: testModel }));
	try {
		const artifact = await Effect.gen(function* () {
			const listener = yield* HttpServer.HttpServer;
			if (listener.address._tag === "UnixPathAddress") return yield* Effect.die("Expected TCP listener");
			const context = yield* Layer.build(Client.layer(`ws://127.0.0.1:${listener.address.port}/rpc/v1`));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));

			// Up to and including the first `Synced`: one catch-up.
			const catchUp = (after: number) =>
				rpc["usage.sync"]({ after }).pipe(
					Stream.takeUntil((item) => item._tag === "Synced"),
					Stream.runCollect,
				);

			const live = yield* Queue.unbounded<UsageItem>();
			yield* rpc["usage.sync"]({ after: 0 }).pipe(
				Stream.runForEach((item) => Queue.offer(live, item)),
				Effect.forkScoped,
			);
			/** Live items up to and including `Synced` at the current head. */
			const settle = Effect.gen(function* () {
				const head = (yield* rpc["server.info"]({})).rev;
				const items: Array<UsageItem> = [];
				while (true) {
					const item = yield* Queue.take(live);
					items.push(item);
					if (item._tag === "Synced" && item.rev >= head) return items;
				}
			});

			// (1) A fresh server: `Synced` at revision 0 and nothing before it.
			const empty = yield* Queue.take(live);

			const created = yield* rpc["session.create"]({ directory: home, project: { name: "Alpha" } });
			const sessionId = created.session.id;
			const projectId = created.session.project?.id;
			if (projectId === undefined) return yield* Effect.die("session has no project");
			const turn = (text: string) =>
				rpc["thread.prompt"]({ sessionId, text }).pipe(Effect.andThen(rpc["thread.wait"]({ sessionId })));

			// Requests 1 and 2: a tool call, then the answer.
			yield* turn("First prompt");
			const first = yield* settle;
			const firstSynced = first.at(-1) as Synced;
			const info = yield* rpc["thread.info"]({ sessionId });

			// (2) Request 3, in the same hour: the same `Usage` key again, with larger running totals.
			yield* turn("Second prompt");
			const second = yield* settle;

			// (3) Resume from either `Synced`.
			const resumed = yield* catchUp(firstSynced.rev);
			const latest = second.at(-1) as Synced;
			const idle = yield* catchUp(latest.rev);

			// (4) Request 4 calls `wide` tools: their tallies share one revision across two pages.
			yield* turn("Wide prompt");
			const paged = yield* settle;
			const whole = yield* catchUp(0);

			// (5) Deleting the session retracts nothing.
			const removed = yield* rpc["session.delete"]({ sessionId });
			const afterDelete = yield* settle;
			const reread = yield* catchUp(0);

			const usageOf = (items: ReadonlyArray<UsageItem>) => items.filter(isUsage);
			const [usage1] = usageOf(first);
			const [usage2] = usageOf(second);
			if (usage1 === undefined || usage2 === undefined) return yield* Effect.die("no usage row was sent");
			const wideTallies = rowsOf(paged).filter((row) => row._tag === "Tally" && row.name.startsWith("tool_"));
			const wholeRows = rowsOf(whole);
			const revs = (items: ReadonlyArray<UsageItem>) => items.map((item) => item.rev);

			expect(empty).toEqual({ _tag: "Synced", storeId: firstSynced.storeId, rev: 0, boot: firstSynced.boot });
			expect(first.filter((item) => item._tag === "Usage")).toHaveLength(1);
			expect(usage1.requests).toBe(2);
			expect({
				cost: usage1.cost.total,
				input: usage1.tokens.input,
				output: usage1.tokens.output,
				cacheRead: usage1.tokens.cacheRead,
				cacheWrite: usage1.tokens.cacheWrite,
			}).toEqual(info.usage);
			expect(rowsOf(first).some((row) => row._tag === "Tally" && row.kind === "tool" && row.name === "probe")).toBe(
				true,
			);
			expect(keyOf(usage2)).toBe(keyOf(usage1));
			expect(usage2.rev).toBeGreaterThan(usage1.rev);
			expect(usage2.requests).toBe(3);
			expect(usage2.tokens.input).toBe(usage1.tokens.input + 300);
			expect(usage2.cost.total).toBe(usage1.cost.total + 0.75);
			expect(rowsOf(resumed).map(keyOf).sort()).toEqual(rowsOf(second).map(keyOf).sort());
			expect(rowsOf(resumed).every((row) => row.rev > firstSynced.rev)).toBe(true);
			expect(idle).toEqual([latest]);
			expect(wideTallies).toHaveLength(wide);
			expect(new Set(wideTallies.map((row) => row.rev)).size).toBe(1);
			expect(new Set(wideTallies.map(keyOf)).size).toBe(wide);
			expect(revs(paged)).toEqual(revs(paged).toSorted((a, b) => a - b));
			expect(wholeRows.length).toBeGreaterThan(500);
			expect(new Set(wholeRows.map(keyOf)).size).toBe(wholeRows.length);
			expect(revs(whole)).toEqual(revs(whole).toSorted((a, b) => a - b));
			expect(removed.deleted).toBe(true);
			expect(rowsOf(afterDelete)).toEqual([]);
			expect(rowsOf(reread)).toEqual(wholeRows);

			const labels = new Map<string, string>([
				[firstSynced.storeId, "<store>"],
				[firstSynced.boot, "<boot>"],
				[sessionId, "<session>"],
				[projectId, "<project>"],
				[created.id, "<main>"],
			]);
			// Revisions by rank within the artifact: their order is the contract, their values are not.
			// How commits batch into live rounds varies, so a live segment shows its rows and its last `Synced`.
			const settled = (items: ReadonlyArray<UsageItem>) => [...rowsOf(items), items.at(-1)!];
			const shown = [...settled(first), ...settled(second), ...resumed, ...idle];
			const ranks = [...new Set(revs(shown))].sort((a, b) => a - b);
			const normalize = (value: unknown, key?: string): unknown => {
				if (typeof value === "string") return labels.get(value) ?? value;
				if (typeof value === "number") {
					if (key === "rev") return ranks.includes(value) ? `<rev ${ranks.indexOf(value)}>` : "<rev>";
					if (key === "hour") return value === H ? "<request hour>" : "<prompt hour>";
					return value;
				}
				if (Array.isArray(value)) return value.map((item) => normalize(item));
				if (typeof value === "object" && value !== null)
					return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k)]));
				return value;
			};
			return normalize({
				edges: edges.length,
				first: settled(first),
				second: settled(second),
				resumed,
				idle,
				paged: { tallies: wideTallies.length, rows: wholeRows.length },
			});
		}).pipe(
			Effect.scoped,
			Effect.provide(
				Server.layer({
					host: "127.0.0.1",
					port: 0,
					harness: { home, hostCwd: home, plugins: [], llm: scripted },
				}),
			),
			Effect.timeout("60 seconds"),
			Effect.runPromise,
		);
		await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/sync.usage.json");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 80_000);
