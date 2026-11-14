/* @effect-diagnostics nodeBuiltinImport:off -- the suite stops, copies and removes CodeWork stores in temp dirs. */
import { Effect, Stream } from "effect";
import { copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import { Codework as Wire } from "@codeworksh/widget/codework";
import type * as Client from "../../../packages/codework/src/server/client.ts";
import { edges, type UsageItem } from "../../../packages/codework/src/server/contract.ts";
import {
	addMachine,
	app,
	cleanup,
	type Codework,
	codework,
	cursorOf,
	freePort,
	lastSeq,
	normalizer,
	notices,
	query,
	rolled,
	type Row,
	snapshot as match,
	stop,
	synced,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

afterEach(cleanup);

type UsageRow = Exclude<UsageItem, { _tag: "Synced" }>;
type SessionId = Parameters<Client.Client["thread.wait"]>[0]["sessionId"];

const snapshot = (name: string, artifact: unknown) => match(`usage.${name}`, artifact);

/** A session in `home` whose prompt runs one `bash` call: two model requests and a tool call. */
const session = async (server: Codework, directory: string, command: string) => {
	const created = await server.run((rpc) => rpc["session.create"]({ directory }));
	await turn(server, created.session.id, command);
	return created;
};
const turn = (server: Codework, sessionId: SessionId, command: string) =>
	server.run((rpc) =>
		rpc["thread.prompt"]({ sessionId, text: `bash ${command}` }).pipe(
			Effect.andThen(rpc["thread.wait"]({ sessionId })),
		),
	);

/** What `usage.sync` from `after` sends up to its first `Synced`, read from CodeWork itself. */
const catchUp = async (server: Codework, after = 0) => {
	const items = await server.run((rpc) =>
		rpc["usage.sync"]({ after }).pipe(
			Stream.takeUntil((item) => item._tag === "Synced"),
			Stream.runCollect,
		),
	);
	const synced = items.at(-1);
	if (synced?._tag !== "Synced") throw new Error("usage.sync ended before Synced");
	return { rows: items.filter((item): item is UsageRow => item._tag !== "Synced"), synced };
};

/** A wire row as app.db holds it for `machineId` and `storeId`. */
const stored = (machineId: string, storeId: string, row: UsageRow): Row => {
	const owner = {
		machine_id: machineId,
		store_id: storeId,
		hour: row.hour,
		thread_id: row.threadId,
		session_id: row.sessionId,
		project_id: row.projectId,
		rev: row.rev,
	};
	if (row._tag === "Tally") return { ...owner, kind: row.kind, name: row.name, count: row.count };
	return {
		...owner,
		provider: row.provider,
		model: row.model,
		thinking: row.thinking,
		requests: row.requests,
		input: row.tokens.input,
		output: row.tokens.output,
		cache_read: row.tokens.cacheRead,
		cache_write: row.tokens.cacheWrite,
		reasoning: row.tokens.reasoning,
		cost: row.cost.total,
		cost_input: row.cost.input,
		cost_output: row.cost.output,
		cost_cache_read: row.cost.cacheRead,
		cost_cache_write: row.cost.cacheWrite,
		duration: row.duration,
		timed: row.timed,
		durations: JSON.stringify(row.durations),
	};
};

const keyOf = (row: Row) =>
	[
		row.machine_id,
		row.store_id,
		row.hour,
		row.thread_id,
		row.provider ?? row.kind,
		row.model ?? row.name,
		row.thinking,
	]
		.map(String)
		.join("|");
const byKey = (rows: ReadonlyArray<Row>) => rows.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));

const mirrored = (home: string) => ({
	usage: query(home, "SELECT * FROM usage ORDER BY rev, provider, model"),
	tally: query(home, "SELECT * FROM tally ORDER BY rev, kind, name"),
});
/** What app.db should hold for `rows` of one store: usage rows, then tallies. */
const expected = (machineId: string, storeId: string, rows: ReadonlyArray<UsageRow>) => ({
	usage: byKey(rows.filter((row) => row._tag === "Usage").map((row) => stored(machineId, storeId, row))),
	tally: byKey(rows.filter((row) => row._tag === "Tally").map((row) => stored(machineId, storeId, row))),
});
const sorted = (rows: { usage: ReadonlyArray<Row>; tally: ReadonlyArray<Row> }) => ({
	usage: byKey(rows.usage),
	tally: byKey(rows.tally),
});

const requestsOf = (rows: ReadonlyArray<Row>) => rows.reduce((sum, row) => sum + (row.requests as number), 0);
const inputOf = (rows: ReadonlyArray<Row>) => rows.reduce((sum, row) => sum + (row.input as number), 0);
const itemsOf = (payloads: ReadonlyArray<Row>) => payloads.reduce((sum, payload) => sum + (payload.items as number), 0);

// Requests are made at the scripted model's own times, in the first hour of 1970; prompts in the real one.
const hours = (value: unknown, key?: string): unknown => {
	if (key === "hour") return value === 0 ? "<request hour>" : "<prompt hour>";
	if (Array.isArray(value)) return value.map((item) => hours(item));
	if (typeof value === "object" && value !== null)
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hours(v, k)]));
	return value;
};

it("the widget mirror's duration edges are CodeWork's", () => {
	expect(Wire.edges).toEqual(edges);
});

it("mirrors usage and tallies with replaced running totals, resumes after a restart and keeps a deleted session's rows", async () => {
	const cwHome = tempDir("usage-cw");
	const appHome = tempDir("usage-app");
	const server = await codework(cwHome, await freePort());
	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);

	// (1) A turn: two requests and a tool call.
	const first = await session(server, cwHome, "echo one");
	const sessionId = first.session.id;
	const { storeId } = await rolled(appHome, machineId, server);
	const one = await catchUp(server);
	const afterOne = mirrored(appHome);
	expect(sorted(afterOne)).toEqual(expected(machineId, storeId, one.rows));
	expect(cursorOf(appHome, machineId)).toEqual({ rollup: one.synced.rev, rollup_store: storeId });
	expect(one.synced.storeId).toBe(storeId);
	expect(afterOne.usage).toHaveLength(1);
	expect(afterOne.usage[0]).toMatchObject({ requests: 2, input: 2 });
	expect(afterOne.tally.map((row) => [row.kind, row.name, row.count])).toEqual([
		["prompt", "", 1],
		["tool", "bash", 1],
	]);

	// (2) A second turn in the same hour: the row's totals are replaced by the larger running ones.
	await turn(server, sessionId, "echo two");
	await rolled(appHome, machineId, server);
	const two = await catchUp(server);
	const afterTwo = mirrored(appHome);
	const thread = await server.run((rpc) => rpc["thread.info"]({ sessionId }));
	expect(sorted(afterTwo)).toEqual(expected(machineId, storeId, two.rows));
	expect(afterTwo.usage).toHaveLength(1);
	expect(afterTwo.usage[0]).toMatchObject({
		requests: 4,
		input: thread.usage.input,
		output: thread.usage.output,
		cost: thread.usage.cost,
	});
	expect(afterTwo.tally.map((row) => [row.kind, row.name, row.count])).toEqual([
		["prompt", "", 2],
		["tool", "bash", 2],
	]);

	// (3) A turn of another session while the app is down: a restart resumes from the cursor.
	const cursor = cursorOf(appHome, machineId).rollup;
	await stop(desk.proc);
	await session(server, cwHome, "echo three");
	const resumed = await catchUp(server, cursor);
	const restartedAt = lastSeq(appHome);
	desk = await app(appHome);
	await rolled(appHome, machineId, server);
	const three = await catchUp(server);
	const afterThree = mirrored(appHome);
	const changed = notices(appHome, Contract.syncTopics.usage, restartedAt);
	expect(sorted(afterThree)).toEqual(expected(machineId, storeId, three.rows));
	expect(itemsOf(changed)).toBe(resumed.rows.length);
	expect(resumed.rows.length).toBeLessThan(three.rows.length);
	expect(afterThree.usage.find((row) => row.thread_id === first.id)).toEqual(afterTwo.usage[0]);

	// (4) A deleted session's rows stay.
	await server.run((rpc) => rpc["session.delete"]({ sessionId }));
	await synced(appHome, machineId, server);
	await rolled(appHome, machineId, server);
	expect(query(appHome, "SELECT deleted_at FROM session WHERE id = ?", sessionId)[0]?.deleted_at).not.toBeNull();
	expect(mirrored(appHome)).toEqual(afterThree);

	await snapshot(
		"mirror",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)(
			hours({
				first: afterOne,
				second: afterTwo,
				resumed: { items: resumed.rows.length, changed },
				...afterThree,
			}),
		),
	);
}, 120_000);

it("a new store's rows accumulate beside the old store's", async () => {
	const cwHome = tempDir("usage-store-cw");
	const appHome = tempDir("usage-store-app");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	await session(server, cwHome, "echo old");
	const old = await rolled(appHome, machineId, server);
	const before = mirrored(appHome);

	// The app stays up: it reconnects to the new store on its own.
	await stop(server.proc, "SIGTERM");
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	server = await codework(cwHome, port);
	await session(server, cwHome, "echo new");
	const fresh = await rolled(appHome, machineId, server);
	expect(fresh.storeId).not.toBe(old.storeId);
	const now = await catchUp(server);

	const rows = mirrored(appHome);
	const ofStore = (list: ReadonlyArray<Row>, id: string) => list.filter((row) => row.store_id === id);
	expect(ofStore(rows.usage, old.storeId)).toEqual(before.usage);
	expect(ofStore(rows.tally, old.storeId)).toEqual(before.tally);
	expect(sorted({ usage: ofStore(rows.usage, fresh.storeId), tally: ofStore(rows.tally, fresh.storeId) })).toEqual(
		expected(machineId, fresh.storeId, now.rows),
	);
	expect(requestsOf(rows.usage)).toBe(requestsOf(before.usage) + requestsOf(ofStore(rows.usage, fresh.storeId)));
	expect(requestsOf(rows.usage)).toBe(4);
	expect(inputOf(rows.usage)).toBe(4);
	expect(cursorOf(appHome, machineId)).toEqual({ rollup: now.synced.rev, rollup_store: fresh.storeId });

	await snapshot(
		"store",
		normalizer(
			[cwHome, appHome],
			[
				[old.storeId, "<old store>"],
				[fresh.storeId, "<new store>"],
			],
		)(hours(rows)),
	);
}, 120_000);

it("a restored store replaces its own rows", async () => {
	const cwHome = tempDir("usage-restored-cw");
	const appHome = tempDir("usage-restored-app");
	const backup = tempDir("usage-restored-backup");
	const port = await freePort();
	let server = await codework(cwHome, port);
	await session(server, cwHome, "echo kept");
	// A clean stop leaves the database whole in its main file.
	await stop(server.proc, "SIGTERM");
	copyFileSync(server.database, join(backup, "codework.db"));
	server = await codework(cwHome, port);

	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const later = await session(server, cwHome, "echo lost");
	const { rev: head } = await rolled(appHome, machineId, server);
	expect(query(appHome, "SELECT * FROM usage WHERE thread_id = ?", later.id)).toHaveLength(1);

	await stop(desk.proc);
	await stop(server.proc, "SIGTERM");
	for (const suffix of ["-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	copyFileSync(join(backup, "codework.db"), server.database);
	server = await codework(cwHome, port);
	const restored = await server.run((rpc) => rpc["server.info"]({}));
	expect(restored.rev).toBeLessThan(head);

	const restartedAt = lastSeq(appHome);
	desk = await app(appHome);
	await waitFor(
		() => (cursorOf(appHome, machineId).rollup === restored.rev ? true : undefined),
		"the re-read of the restored store",
	);
	const now = await catchUp(server);
	const rows = mirrored(appHome);
	expect(sorted(rows)).toEqual(expected(machineId, restored.storeId, now.rows));
	expect(rows.usage.some((row) => row.thread_id === later.id)).toBe(false);
	const changed = notices(appHome, Contract.syncTopics.usage, restartedAt);
	expect(itemsOf(changed)).toBe(now.rows.length);

	await snapshot(
		"restored",
		normalizer([cwHome, appHome], [[restored.storeId, "<store>"]])(hours({ changed, ...rows })),
	);
}, 120_000);

it("a server without usage.sync keeps its index synced and its usage empty, asked again only after a while", async () => {
	const cwHome = tempDir("usage-older-cw");
	const appHome = tempDir("usage-older-app");
	const server = await codework(cwHome, await freePort(), { older: true });
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const created = await session(server, cwHome, "echo older");
	await synced(appHome, machineId, server);
	// Longer than the retry after any other failure.
	await new Promise((resolve) => setTimeout(resolve, 3_000));
	await turn(server, created.session.id, "echo again");
	await synced(appHome, machineId, server);

	const told = desk.lines.filter((line) => line.includes("does not serve usage.sync"));
	expect(query(appHome, "SELECT id FROM thread")).toHaveLength(1);
	expect(query(appHome, "SELECT tokens_input FROM thread")[0]).toEqual({ tokens_input: 4 });
	expect(mirrored(appHome)).toEqual({ usage: [], tally: [] });
	expect(cursorOf(appHome, machineId)).toEqual({ rollup: 0, rollup_store: null });
	expect(told).toHaveLength(1);
	expect(desk.lines.filter((line) => line.includes("Usage sync of machine"))).toEqual([]);

	await snapshot("older", { told: told.length, ...mirrored(appHome), cursor: cursorOf(appHome, machineId) });
}, 90_000);
