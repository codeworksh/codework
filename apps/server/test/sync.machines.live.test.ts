/* @effect-diagnostics nodeBuiltinImport:off -- the suite runs CodeWork servers on OrbStack Linux machines. */
import { Effect, Stream } from "effect";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Contract, LOCAL_SERVER } from "@codeworksh/contract";
import type * as Client from "../../../packages/codework/src/server/client.ts";
import {
	app,
	cleanup,
	type Codework,
	codework,
	freePort,
	lastSeq,
	machineRow,
	normalizer,
	notices,
	query,
	type Row,
	snapshot as match,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";
import { available, ensure, machine, type Machine, orb } from "./machines/orb.ts";

/*
 * The desktop sync across real computers: CodeWork servers with the scripted model run on OrbStack
 * Linux machines (setup.sh, start.sh), all synced into one app server on the Mac, while the suite
 * cuts, throttles, crashes, restores and replaces them. The machine set grows from 3 to 5 and
 * shrinks again; `sync.machines.shuffle.json` records every move.
 */

const userHome = `/home/${userInfo().username}`;
const ubuntu = machine("ubuntu");
const cwA = machine("cw-a");
const cwB = machine("cw-b");
const cwC = machine("cw-c");
const pool = [ubuntu, cwA, cwB, cwC];

type Rpc = Client.Client;
type Server = { readonly run: <A, E>(use: (rpc: Rpc) => Effect.Effect<A, E>) => Promise<A> };

let appHome = "";
let local: Codework;
let desk: Awaited<ReturnType<typeof app>>;
/** Machines in the app by name: the Mac's built-in local one and each added Linux machine. */
const members = new Map<string, string>();

const snapshot = (name: string, artifact: unknown) => match(`sync.machines.${name}`, artifact);
const normalize = (fixed: ReadonlyArray<readonly [string, string]> = []) =>
	normalizer([appHome, userHome], [...[...members].map(([name, id]) => [id, `<machine ${name}>`] as const), ...fixed]);

const idOf = (m: Machine) => members.get(m.name)!;

/** Waits until the app's cursor for `machineId` reached the server's head; the head it reached. */
const caughtUp = async (machineId: string, server: Server, timeout = 120_000) => {
	const { storeId, rev } = await server.run((rpc) => rpc["server.info"]({}));
	await waitFor(
		() => {
			const row = machineRow(appHome, machineId);
			return row?.store_id === storeId && row.cursor >= rev ? row : undefined;
		},
		`machine ${machineId} at rev ${rev}`,
		timeout,
	);
	return { storeId, rev };
};

const add = async (m: Machine) => {
	const id = await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", name: m.name, url: m.url }));
	members.set(m.name, id);
	return id;
};

/** A session in `directory` with one prompt answered. */
const session = (server: Server, directory: string, text: string) =>
	server.run((rpc) =>
		Effect.gen(function* () {
			const created = yield* rpc["session.create"]({ directory });
			yield* rpc["thread.prompt"]({ sessionId: created.session.id, text });
			yield* rpc["thread.wait"]({ sessionId: created.session.id });
			return created;
		}),
	);

const work = (m: Machine) => `${m.cwHome}/work`;

/** A machine with a fresh store and its server running. */
const fresh = async (m: Machine) => {
	await m.net("restore");
	await m.net("fast");
	await m.stop("KILL");
	await m.wipe();
	await m.sh(`mkdir -p ${work(m)}`);
	await m.start();
};

// What app.db holds for a machine, and the harness rows it mirrors.
const appTables = (machineId: string) => ({
	project: query(appHome, "SELECT * FROM project WHERE machine_id = ? ORDER BY created_at, name", machineId),
	space: query(appHome, "SELECT * FROM space WHERE machine_id = ? ORDER BY created_at, location", machineId),
	session: query(appHome, "SELECT * FROM session WHERE machine_id = ? ORDER BY created_at, slug", machineId),
	thread: query(
		appHome,
		`SELECT thread.* FROM thread JOIN session ON session.id = thread.session_id
		 WHERE session.machine_id = ? ORDER BY thread.created_at, thread.created_seq`,
		machineId,
	),
});
const harnessTables = async (m: Machine) => ({
	project: await m.sql("SELECT id, name, status, created_at, updated_at, rev FROM project ORDER BY created_at, name"),
	space: await m.sql(
		"SELECT id, project_id, location, kind, status, created_at, updated_at, rev FROM space ORDER BY created_at, location",
	),
	session: await m.sql(
		"SELECT id, space_id, slug, directory, created_at, updated_at, rev FROM session ORDER BY created_at, slug",
	),
	thread: await m.sql(
		`SELECT id, session_id, origin_kind, origin_thread_id, title, run_state, run_outcome, run_error, restarts,
		 created_seq, created_at, updated_at, rev FROM thread ORDER BY created_at, created_seq`,
	),
	removed: await m.sql("SELECT kind, id, rev FROM removed ORDER BY rev"),
});
type Harness = Awaited<ReturnType<typeof harnessTables>>;

/** Where app.db differs from the harness rows: missing or extra ids, and core columns that disagree. */
const differences = (copied: ReturnType<typeof appTables>, harness: Harness) => {
	const found: Array<string> = [];
	const compare = (
		table: string,
		mine: ReadonlyArray<Row>,
		theirs: ReadonlyArray<Row>,
		columns: ReadonlyArray<string>,
	) => {
		const live = mine.filter((row) => row.deleted_at === undefined || row.deleted_at === null);
		const byId = new Map(live.map((row) => [row.id, row]));
		for (const row of theirs) {
			const copy = byId.get(row.id);
			const id = String(row.id);
			if (copy === undefined) found.push(`${table} ${id} missing`);
			else
				for (const column of columns)
					if (copy[column] !== row[column])
						found.push(
							`${table} ${id} ${column}: ${JSON.stringify(copy[column])} vs ${JSON.stringify(row[column])}`,
						);
			byId.delete(row.id);
		}
		for (const id of byId.keys()) found.push(`${table} ${String(id)} extra`);
	};
	compare("project", copied.project, harness.project, ["name", "status", "updated_at"]);
	compare("space", copied.space, harness.space, ["project_id", "location", "kind", "status"]);
	compare("session", copied.session, harness.session, ["space_id", "slug", "created_at"]);
	compare("thread", copied.thread, harness.thread, [
		"session_id",
		"origin_kind",
		"origin_thread_id",
		"title",
		"run_state",
		"run_outcome",
		"created_seq",
		"created_at",
		"updated_at",
	]);
	return found;
};

const changedSince = (machineId: string, after: number) =>
	notices(appHome, Contract.syncTopics.changed, after).filter((notice) => notice.machineId === machineId);

// The shuffle: each move of the machine set, with the rows each machine holds in app.db around it.
const shuffle: Array<Row> = [];
const timings: Array<Row> = [];
/** Raw numbers that vary run to run: printed and kept in a temp file, never in an artifact. */
const measured: Record<string, unknown> = {};
const measure = (name: string, value: unknown) => {
	measured[name] = value;
	console.log(name, JSON.stringify(value));
};
const rowsOf = (machineId: string) =>
	query(
		appHome,
		`SELECT (SELECT COUNT(*) FROM project WHERE machine_id = ?1) + (SELECT COUNT(*) FROM space WHERE machine_id = ?1)
		 + (SELECT COUNT(*) FROM session WHERE machine_id = ?1)
		 + (SELECT COUNT(*) FROM thread WHERE session_id IN (SELECT id FROM session WHERE machine_id = ?1)) AS n`,
		machineId,
	)[0]!.n as number;
const census = () => Object.fromEntries([...members].map(([name, id]) => [name, rowsOf(id)]));
const bucket = (ms: number) => (ms < 10_000 ? "<10s" : ms < 30_000 ? "<30s" : ms < 120_000 ? "<120s" : ">=120s");
/** Runs a move of the machine set and records it; `move` returns the sync path each machine took. */
/**
 * Runs a move of the machine set and records it; `move` returns the sync path each machine took. A
 * move that waits on something other than the sync (a machine booting) times the sync itself with
 * `sync`: the artifact keeps that time, the printed timings keep both.
 */
const step = async (
	name: string,
	move: (sync: <A>(effect: () => Promise<A>) => Promise<A>) => Promise<Record<string, string>>,
) => {
	const before = census();
	const started = performance.now();
	let synced: number | undefined;
	const paths = await move(async (effect) => {
		const from = performance.now();
		const result = await effect();
		synced = Math.round(performance.now() - from);
		return result;
	});
	const ms = Math.round(performance.now() - started);
	timings.push(synced === undefined ? { step: name, ms } : { step: name, ms, sync: synced });
	shuffle.push({
		step: name,
		machines: [...members.keys()],
		before,
		after: census(),
		paths,
		time: bucket(synced ?? ms),
	});
};
/** The path a machine's sync took since `after`: a full sync, or a resume from its cursor. */
const pathOf = (machineId: string, after: number) =>
	changedSince(machineId, after).some((notice) => notice.full === true) ? "full sync" : "resume";

const describeMachines = available ? describe : describe.skip;

describeMachines("sync across OrbStack machines", () => {
	beforeAll(async () => {
		for (const m of pool) await ensure(m.name);
		await Promise.all(pool.map((m) => m.setup()));
		await Promise.all(pool.map((m) => fresh(m)));
		appHome = tempDir("machines-app");
		local = await codework(join(appHome, "cli"), await freePort());
		members.set("local", LOCAL_SERVER);
		await session(local, appHome, "On the Mac");
		desk = await app(appHome);
		await step("start: the Mac and ubuntu", async () => {
			const at = lastSeq(appHome);
			await add(ubuntu);
			await caughtUp(LOCAL_SERVER, local);
			await caughtUp(idOf(ubuntu), ubuntu);
			return { local: pathOf(LOCAL_SERVER, at), ubuntu: pathOf(idOf(ubuntu), at) };
		});
	}, 1_800_000);

	afterAll(async () => {
		measure("timings", timings);
		writeFileSync(join(tmpdir(), "codework-machines-measured.json"), `${JSON.stringify(measured, null, "\t")}\n`);
		await Promise.all(
			pool.map((m) =>
				m
					.net("fast")
					.then(() => m.net("restore"))
					.catch(() => undefined),
			),
		);
		await cleanup();
	}, 120_000);

	it("1. snapshot, then watch: rows written during the first sync all arrive", async () => {
		// Enough rows for several catch-up batches.
		const before = 400;
		await cwA.run((rpc) =>
			Effect.forEach(
				Array.from({ length: before }, (_, n) => n),
				() => rpc["session.create"]({ directory: work(cwA) }),
				{ concurrency: 8, discard: true },
			),
		);
		const head = (await cwA.run((rpc) => rpc["server.info"]({}))).rev;

		// Writes start with the add and run through its catch-up: new sessions, and prompts on old ones.
		let firstSynced: number | undefined;
		let added = "";
		const during = 30;
		await step("add cw-a with writes during its first sync", async () => {
			const at = lastSeq(appHome);
			const writes = cwA.run((rpc) =>
				Effect.forEach(
					Array.from({ length: during }, (_, n) => n),
					(n) =>
						rpc["session.create"]({ directory: work(cwA) }).pipe(
							Effect.tap((created) =>
								rpc["thread.prompt"]({ sessionId: created.session.id, text: `During ${n}` }).pipe(
									Effect.andThen(rpc["thread.wait"]({ sessionId: created.session.id })),
								),
							),
						),
					{ concurrency: 2, discard: true },
				),
			);
			added = await add(cwA);
			const watch = waitFor(
				() => {
					const row = machineRow(appHome, added);
					return row !== undefined && row.cursor > 0 ? row.cursor : undefined;
				},
				"the first Synced",
				120_000,
			).then((cursor) => (firstSynced = cursor));
			await Promise.all([writes, watch]);
			await caughtUp(added, cwA);
			return { "cw-a": pathOf(added, at) };
		});

		const harness = await harnessTables(cwA);
		const copied = appTables(added);
		expect(differences(copied, harness)).toEqual([]);
		const caughtUpRows = harness.thread.filter(
			(row) => (row.rev as number) > head && (row.rev as number) <= firstSynced!,
		);
		const liveRows = harness.thread.filter((row) => (row.rev as number) > firstSynced!);
		measure("case 1", { head, firstSynced, writtenDuringCatchUp: caughtUpRows.length, afterSynced: liveRows.length });
		expect(copied.session).toHaveLength(before + during);

		await snapshot(
			"snapshot",
			normalize()({
				sessions: { before, during },
				rows: Object.fromEntries(
					Object.entries(copied).map(([table, rows]) => [
						table,
						{ app: rows.length, harness: harness[table as keyof Harness].length },
					]),
				),
				missing: differences(copied, harness),
				projects: copied.project.map(({ id, machine_id, name, status }) => ({ id, machine_id, name, status })),
			}),
		);
	}, 600_000);

	it("2. a partition resumes from the cursor with only the rows changed since", async () => {
		const machineId = idOf(cwA);
		const created = await session(cwA, work(cwA), "Before the cut");
		const sessionId = created.session.id;
		const reply = await cwA.run((rpc) =>
			rpc["thread.history"]({ sessionId }).pipe(Effect.map((h) => h.entries.at(-1)!)),
		);
		const { rev: cursor } = await caughtUp(machineId, cwA);
		const [space] = await cwA.sql(`SELECT id, project_id FROM space WHERE id = '${created.session.spaceId}'`);

		const cutAt = performance.now();
		await cwA.net("cut");
		const [forked] = (await cwA.drive([
			["thread.fork", { sessionId, entryId: reply.id }],
			["thread.prompt", { sessionId, text: "While cut" }],
			["thread.wait", { sessionId }],
			["project.rename", { projectId: space!.project_id, name: "Renamed while cut" }],
		])) as [{ thread: { id: string } }];
		// No RPC archives a space: a store write by the revision rule, as the harness's own would.
		await cwA.sql(`BEGIN; UPDATE store SET rev = rev + 1;
			UPDATE space SET status = 'archived', updated_at = 1, rev = (SELECT rev FROM store) WHERE id = '${String(space!.id)}'; COMMIT;`);
		// Past the client's ping timeout, so the app has dropped the connection.
		const held = 15_000 - (performance.now() - cutAt);
		if (held > 0) await new Promise((resolve) => setTimeout(resolve, held));
		const tables = ["project", "space", "session", "thread", "removed"];
		const count = async (where: string) =>
			(
				await cwA.sql(
					`SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${table} ${where})`).join(" + ")} AS n`,
				)
			)[0]!.n as number;
		const sent = await count(`WHERE rev > ${cursor}`);
		const total = await count("");

		const at = lastSeq(appHome);
		let resumeMs = 0;
		await step("partition cw-a and restore", async () => {
			await cwA.net("restore");
			const restoredAt = performance.now();
			await caughtUp(machineId, cwA);
			resumeMs = Math.round(performance.now() - restoredAt);
			return { "cw-a": pathOf(machineId, at) };
		});
		const changed = changedSince(machineId, at);
		measure("case 2", { sent, total, resumeMs, notices: changed.length });
		expect(changed.every((notice) => notice.full === false)).toBe(true);
		expect(changed.reduce((sum, notice) => sum + (notice.items as number), 0)).toBe(sent);
		expect(sent).toBeLessThan(total);
		const copied = appTables(machineId);
		expect(differences(copied, await harnessTables(cwA))).toEqual([]);
		const thread = copied.thread.find((row) => row.id === forked.thread.id);
		expect(thread).toMatchObject({ origin_kind: "fork", origin_thread_id: created.id });
		expect(copied.space.find((row) => row.id === space!.id)?.status).toBe("archived");
		expect(copied.project.find((row) => row.id === space!.project_id)?.name).toBe("Renamed while cut");

		await snapshot(
			"partition",
			normalize()({
				rows: { sent, total },
				changed,
				project: copied.project.filter((row) => row.id === space!.project_id),
				space: copied.space.filter((row) => row.id === space!.id),
				thread: copied.thread.filter((row) => row.session_id === sessionId),
			}),
		);
	}, 300_000);

	it("3. a session deleted while away is soft-deleted on resume, its detail kept and hidden from reads", async () => {
		const machineId = idOf(ubuntu);
		const kept = await session(ubuntu, work(ubuntu), "Kept");
		const doomed = await session(ubuntu, work(ubuntu), "Doomed");
		await caughtUp(machineId, ubuntu);
		await desk.run((rpc) => rpc["sync.open"]({ sessionId: doomed.session.id, threadId: doomed.id }));
		await desk.run((rpc) => rpc["sync.close"]({ sessionId: doomed.session.id, threadId: doomed.id }));

		const cutAt = performance.now();
		await ubuntu.net("cut");
		await ubuntu.drive([["session.delete", { sessionId: doomed.session.id }]]);
		const held = 15_000 - (performance.now() - cutAt);
		if (held > 0) await new Promise((resolve) => setTimeout(resolve, held));
		const at = lastSeq(appHome);
		await step("partition ubuntu, delete a session, restore", async () => {
			await ubuntu.net("restore");
			await caughtUp(machineId, ubuntu);
			return { ubuntu: pathOf(machineId, at) };
		});

		const sessions = query(
			appHome,
			"SELECT * FROM session WHERE id IN (?, ?) ORDER BY created_at",
			kept.session.id,
			doomed.session.id,
		);
		const threads = query(appHome, "SELECT * FROM thread WHERE session_id = ?", doomed.session.id);
		const entries = query(appHome, "SELECT * FROM entry WHERE thread_id = ? ORDER BY seq", doomed.id);
		// The sidebar's read: sessions not deleted.
		const listed = query(
			appHome,
			"SELECT id FROM session WHERE machine_id = ? AND deleted_at IS NULL AND id IN (?, ?)",
			machineId,
			kept.session.id,
			doomed.session.id,
		);
		const changed = changedSince(machineId, at);
		expect(sessions.find((row) => row.id === doomed.session.id)?.deleted_at).not.toBeNull();
		expect(threads.every((row) => row.deleted_at !== null)).toBe(true);
		expect(entries).toHaveLength(2);
		expect(listed).toEqual([{ id: kept.session.id }]);
		expect(changed.at(-1)).toMatchObject({ full: false, removed: [doomed.session.id] });
		const removed = await ubuntu.sql(`SELECT kind, id, rev FROM removed WHERE id = '${doomed.session.id}'`);
		expect(removed).toHaveLength(1);

		await snapshot(
			"deleted",
			normalize()({ changed, harness: { removed }, session: sessions, thread: threads, entry: entries, listed }),
		);
	}, 300_000);

	it("4. a crash mid-run is swept before any client connects, then recovery resumes it", async () => {
		await step("add cw-b live", async () => {
			const at = lastSeq(appHome);
			const id = await add(cwB);
			await caughtUp(id, cwB);
			return { "cw-b": pathOf(id, at) };
		});
		const machineId = idOf(cwA);
		const created = await cwA.run((rpc) => rpc["session.create"]({ directory: work(cwA) }));
		const ref = { sessionId: created.session.id, threadId: created.id };
		const row = () =>
			query(
				appHome,
				"SELECT status, run_state, run_started_at, run_outcome, run_error FROM thread WHERE id = ?",
				ref.threadId,
			)[0]!;
		await cwA.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "hold" }));
		const running = await waitFor(() => (row().run_state === "running" ? row() : undefined), "the held run");
		expect(running.status).toBe("working");
		const crashedAt = lastSeq(appHome);

		await cwA.stop("KILL");
		const harnessRow = `SELECT run_state, run_outcome, run_error, head FROM thread WHERE id = '${ref.threadId}'`;
		const open = await cwA.sql(harnessRow);
		await cwA.sweep();
		const swept = await cwA.sql(harnessRow);
		expect(swept[0]).toMatchObject({ run_state: "idle", run_outcome: "interrupted" });
		expect(JSON.parse(swept[0]!.run_error as string)).toEqual({ _tag: "interrupted", reason: "crash" });

		const at = lastSeq(appHome);
		await step("crash cw-a mid-run and restart it", async () => {
			await cwA.start();
			await waitFor(
				() =>
					row().run_started_at !== running.run_started_at && row().run_state === "running" ? row() : undefined,
				"the resumed run",
				60_000,
			);
			return { "cw-a": pathOf(machineId, at) };
		});
		const events = await cwA.sql(
			`SELECT type, json_extract(data, '$.resumed') AS resumed, json_extract(data, '$.reason') AS reason FROM event
			 WHERE aggregate_id = '${ref.sessionId}' AND type LIKE 'session.execution.%' ORDER BY seq`,
		);
		// Durable event types carry their version: `session.execution.started.1`.
		expect(events.at(-1)).toMatchObject({ type: "session.execution.started.1", resumed: 1 });
		const moves = notices(appHome, Contract.syncTopics.status, crashedAt).filter(
			(move) => move.threadId === ref.threadId,
		);
		// Interrupted by a crash leaves the status alone; the resumed start keeps it working.
		expect(moves).toEqual([]);
		expect(row().status).toBe("working");
		const resumed = row();
		await cwA.run((rpc) => rpc["thread.interrupt"](ref));

		await snapshot(
			"crash",
			normalize()({
				harness: { open: open[0], swept: swept[0], events },
				app: { running, resumed },
				statusMoves: moves,
			}),
		);
	}, 300_000);

	it("5. a restored store is read again in full; returning rows keep their desktop columns", async () => {
		await step("add cw-c live", async () => {
			const at = lastSeq(appHome);
			const id = await add(cwC);
			await caughtUp(id, cwC);
			return { "cw-c": pathOf(id, at) };
		});
		const machineId = idOf(cwB);
		const before = await session(cwB, work(cwB), "Before backup");
		await caughtUp(machineId, cwB);
		write(appHome, "UPDATE thread SET priority = 2, color = '#ff8800', status = 'review' WHERE id = ?", before.id);
		write(appHome, "UPDATE session SET color = '#00aa88' WHERE id = ?", before.session.id);

		await cwB.stop("TERM");
		await cwB.sh(`cp ${cwB.database} ${cwB.cwHome}/backup.db`);
		await cwB.start();
		const after = await session(cwB, work(cwB), "After backup");
		const { rev: head } = await caughtUp(machineId, cwB);
		await cwB.stop("TERM");
		await cwB.sh(`rm -f ${cwB.database}-wal ${cwB.database}-shm && cp ${cwB.cwHome}/backup.db ${cwB.database}`);

		const at = lastSeq(appHome);
		let fullMs = 0;
		let restored = { storeId: "", rev: 0 };
		await step("restore cw-b's store from a backup", async () => {
			await cwB.start();
			const startedAt = performance.now();
			restored = await cwB.run((rpc) => rpc["server.info"]({}));
			await waitFor(
				() => (machineRow(appHome, machineId).cursor === restored.rev ? true : undefined),
				"the full sync",
				120_000,
			);
			fullMs = Math.round(performance.now() - startedAt);
			return { "cw-b": pathOf(machineId, at) };
		});
		measure("case 5", { head, restoredRev: restored.rev, fullMs });
		expect(restored.rev).toBeLessThan(head);
		const changed = changedSince(machineId, at);
		expect(changed[0]).toMatchObject({ full: true, removed: [after.session.id] });
		const rows = appTables(machineId);
		expect(rows.thread.find((row) => row.id === before.id)).toMatchObject({
			priority: 2,
			color: "#ff8800",
			status: "review",
			deleted_at: null,
		});
		expect(rows.session.find((row) => row.id === before.session.id)).toMatchObject({
			color: "#00aa88",
			deleted_at: null,
		});
		expect(rows.session.find((row) => row.id === after.session.id)?.deleted_at).not.toBeNull();
		expect(differences(rows, await harnessTables(cwB))).toEqual([]);

		await snapshot(
			"restored",
			normalize([[restored.storeId, "<store cw-b>"]])({
				heads: [{ rev: head }, { rev: restored.rev }],
				full: changed.filter((notice) => notice.full === true),
				...rows,
			}),
		);
	}, 300_000);

	it("6. a new store on the same machine is read again in full", async () => {
		const machineId = idOf(cwC);
		const old = await session(cwC, work(cwC), "Old store");
		const first = await caughtUp(machineId, cwC);
		const at = lastSeq(appHome);
		let fresher = { storeId: "", rev: 0 };
		await step("replace cw-c's store with a new one", async () => {
			await fresh(cwC);
			fresher = await caughtUp(machineId, cwC);
			return { "cw-c": pathOf(machineId, at) };
		});
		const created = await session(cwC, work(cwC), "New store");
		await caughtUp(machineId, cwC);
		expect(fresher.storeId).not.toBe(first.storeId);
		const changed = changedSince(machineId, at);
		expect(changed.find((notice) => notice.full === true)).toMatchObject({ removed: [old.session.id] });
		const rows = appTables(machineId);
		expect(rows.session.find((row) => row.id === old.session.id)?.deleted_at).not.toBeNull();
		expect(rows.session.find((row) => row.id === created.session.id)?.deleted_at).toBeNull();

		await snapshot(
			"store",
			normalize([
				[first.storeId, "<old store>"],
				[fresher.storeId, "<new store>"],
			])({
				machine: machineRow(appHome, machineId),
				// Live batches after it split by doorbell timing, so only the full sync is kept.
				full: changed.filter((notice) => notice.full === true),
				session: rows.session,
				thread: rows.thread,
			}),
		);
	}, 300_000);

	it("7. a slow link keeps thread.sync in order, drops deltas that do not continue the draft, and lands the reply", async () => {
		const machineId = idOf(ubuntu);
		const created = await ubuntu.run((rpc) => rpc["session.create"]({ directory: work(ubuntu) }));
		const ref = { sessionId: created.session.id, threadId: created.id };
		await caughtUp(machineId, ubuntu);
		await desk.run((rpc) => rpc["sync.open"](ref));
		const forwarded: Array<{ entryId: string; offset: number; delta: string }> = [];
		let subscribed = false;
		const follower = desk.background((rpc) =>
			rpc["event.subscribe"]({ topics: [Contract.syncTopics.delta(ref.threadId)] }).pipe(
				Stream.runForEach((item) =>
					Effect.sync(() => {
						if ("_tag" in item) subscribed = true;
						else forwarded.push(item.payload as { entryId: string; offset: number; delta: string });
					}),
				),
			),
		);
		await waitFor(() => (subscribed ? true : undefined), "the delta subscription");
		const cursors: Array<number> = [];
		let polling = true;
		const poll = (async () => {
			while (polling) {
				const cursor = query(appHome, "SELECT cursor FROM thread WHERE id = ?", ref.threadId)[0]?.cursor as
					| number
					| null;
				if (cursor !== null && cursor !== cursors.at(-1)) cursors.push(cursor);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		})();

		const chunks = 400;
		await ubuntu.net("slow");
		try {
			await ubuntu.run((rpc) => rpc["thread.prompt"]({ ...ref, text: `long ${chunks}` }));
			await waitFor(() => (forwarded.length >= 20 ? true : undefined), "deltas over the slow link", 60_000);
			// Closed and reopened mid-reply: the held draft goes, and the stream restarts from the last checkpoint.
			const reopenedAt = forwarded.length;
			await desk.run((rpc) => rpc["sync.close"](ref));
			await desk.run((rpc) => rpc["sync.open"](ref));
			await ubuntu.run((rpc) => rpc["thread.wait"](ref));
			const committed = () =>
				query(
					appHome,
					"SELECT entry.id, entry.state FROM entry WHERE thread_id = ? AND type = 'assistant' AND state = 'committed'",
					ref.threadId,
				)[0];
			await waitFor(committed, "the committed reply", 120_000);
			polling = false;
			await poll;
			follower.stop();

			const final = query(
				appHome,
				`SELECT json_extract(part.data, '$.text') AS text FROM part JOIN entry ON entry.id = part.entry_id
				 WHERE entry.thread_id = ? AND entry.type = 'assistant'`,
				ref.threadId,
			)[0]!.text as string;
			const harness = (
				await ubuntu.sql(
					`SELECT json_extract(part.data, '$.text') AS text FROM part JOIN entry ON entry.id = part.entry_id
					 WHERE entry.thread_id = '${ref.threadId}' AND entry.type = 'assistant'`,
				)
			)[0]?.text;
			const expected = Array.from({ length: chunks }, (_, step) =>
				`chunk ${String(step).padStart(5, "0")} `.padEnd(32, "."),
			).join("");
			// Every forwarded delta sits at its place in the final text; a gap is a delta never folded.
			const continues = forwarded.every(
				(delta) => final.slice(delta.offset, delta.offset + delta.delta.length) === delta.delta,
			);
			const offsets = forwarded.map((delta) => delta.offset);
			const ordered = offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]!);
			const gaps = offsets.filter((offset, index) => index > 0 && offset !== offsets[index - 1]! + 32).length;
			const afterReopen = offsets.slice(reopenedAt);
			const gapAfterReopen = afterReopen.length === 0 || afterReopen[0] !== offsets[reopenedAt - 1]! + 32;
			const cursorsInOrder = cursors.every((cursor, index) => index === 0 || cursor > cursors[index - 1]!);
			measure("case 7", {
				emitted: chunks,
				forwarded: forwarded.length,
				dropped: chunks - forwarded.length,
				gaps,
				cursors: cursors.length,
			});
			expect(final).toBe(expected);
			expect(harness).toBe(expected);
			expect(continues).toBe(true);
			expect(ordered).toBe(true);
			expect(cursorsInOrder).toBe(true);
			expect(forwarded.length).toBeLessThan(chunks);

			await snapshot(
				"slow",
				normalize()({
					link: "netem delay 300ms rate 256kbit",
					emitted: chunks,
					forwardedAreInOrder: ordered,
					forwardedContinueTheFinalText: continues,
					someDropped: forwarded.length < chunks,
					gapAfterReopen,
					cursorsInOrder,
					finalEqualsHarness: final === harness,
					entry: query(
						appHome,
						"SELECT id, thread_id, type, state, size FROM entry WHERE thread_id = ? ORDER BY seq",
						ref.threadId,
					),
				}),
			);
		} finally {
			polling = false;
			follower.stop();
			await ubuntu.net("fast");
			await desk.run((rpc) => rpc["sync.close"](ref));
		}
	}, 300_000);

	it("8. a fork opened while its source keeps writing holds the source's line up to the cut, stored once", async () => {
		const machineId = idOf(cwA);
		const created = await session(cwA, work(cwA), "Source one");
		const sessionId = created.session.id;
		const source = { sessionId, threadId: created.id };
		await cwA.run((rpc) =>
			rpc["thread.prompt"]({ ...source, text: "Source two" }).pipe(Effect.andThen(rpc["thread.wait"](source))),
		);
		const history = await cwA.run((rpc) => rpc["thread.history"]({ sessionId }));
		const at = history.entries[1]!;
		const fork = (await cwA.run((rpc) => rpc["thread.fork"]({ sessionId, entryId: at.id }))).thread;
		const forkRef = { sessionId, threadId: fork.id };

		// The source keeps going while the fork is opened.
		const busy = cwA.run((rpc) =>
			Effect.forEach(
				["Source three", "Source four", "Source five"],
				(text) => rpc["thread.prompt"]({ ...source, text }).pipe(Effect.andThen(rpc["thread.wait"](source))),
				{ discard: true },
			),
		);
		await caughtUp(machineId, cwA);
		await desk.run((rpc) => rpc["sync.open"](forkRef));
		await busy;
		await cwA.run((rpc) =>
			rpc["thread.prompt"]({ ...forkRef, text: "Fork one" }).pipe(Effect.andThen(rpc["thread.wait"](forkRef))),
		);
		await caughtUp(machineId, cwA);
		const line = (await cwA.run((rpc) => rpc["thread.history"](forkRef))).entries;
		const [threadRow] = query(appHome, "SELECT origin_committed_seq, cursor FROM thread WHERE id = ?", fork.id);
		const cut = threadRow!.origin_committed_seq as number;
		await waitFor(
			() => (query(appHome, "SELECT id FROM entry WHERE thread_id = ?", fork.id).length === 2 ? true : undefined),
			"the fork's own entries",
		);
		const held = () =>
			query(
				appHome,
				"SELECT id, thread_id, seq, type, state FROM entry WHERE thread_id IN (?, ?) ORDER BY seq",
				created.id,
				fork.id,
			);
		const opened = held();
		const sourceHeld = opened.filter((row) => row.thread_id === created.id);
		expect(opened.map((row) => row.id)).toEqual(line.map((entry) => entry.id));
		expect(sourceHeld.every((row) => (row.seq as number) <= cut)).toBe(true);
		expect(cut).toBe(fork.origin.kind === "fork" ? fork.origin.cut : undefined);

		// Opening the source as well stores its later entries; the inherited ones stay one row each.
		await desk.run((rpc) => rpc["sync.open"](source));
		const both = held();
		const sourceLine = (await cwA.run((rpc) => rpc["thread.history"](source))).entries;
		expect(both.filter((row) => row.thread_id === created.id).map((row) => row.id)).toEqual(
			sourceLine.map((entry) => entry.id),
		);
		expect(new Set(both.map((row) => row.id)).size).toBe(both.length);
		await desk.run((rpc) => rpc["sync.close"](source));
		await desk.run((rpc) => rpc["sync.close"](forkRef));

		await snapshot(
			"fork",
			normalize()({
				cut: { origin_committed_seq: cut },
				forkLine: opened,
				afterSourceOpened: both,
			}),
		);
	}, 300_000);

	it("9. several machines at once: one repository on two machines, commands to each machine, removal cascades", async () => {
		const repo = `${userHome}/codework`;
		const onUbuntu = await session(ubuntu, repo, "Repo on ubuntu");
		const onA = await session(cwA, repo, "Repo on cw-a");
		await caughtUp(idOf(ubuntu), ubuntu);
		await caughtUp(idOf(cwA), cwA);
		const projects = query(
			appHome,
			`SELECT project.machine_id, project.id, project.name FROM project JOIN space
			 ON space.machine_id = project.machine_id AND space.project_id = project.id
			 WHERE space.location = ? ORDER BY project.machine_id = ?`,
			repo,
			idOf(cwA),
		);
		expect(projects).toHaveLength(2);
		expect(projects[0]!.id).toBe(projects[1]!.id);

		// Each thread's detail comes from its own machine.
		const machineOf = (sessionId: string) =>
			query(appHome, "SELECT machine_id FROM session WHERE id = ?", sessionId)[0]!.machine_id;
		const detail = async (server: Server, created: typeof onA) => {
			const ref = { sessionId: created.session.id, threadId: created.id };
			await desk.run((rpc) => rpc["sync.open"](ref));
			await desk.run((rpc) => rpc["sync.close"](ref));
			const line = (await server.run((rpc) => rpc["thread.history"](ref))).entries.map((entry) => entry.id);
			const held = query(appHome, "SELECT id FROM entry WHERE thread_id = ? ORDER BY seq", created.id).map(
				(row) => row.id,
			);
			return {
				machine: machineOf(created.session.id),
				sameAsItsMachine: JSON.stringify(line) === JSON.stringify(held),
			};
		};
		const routed = { ubuntu: await detail(ubuntu, onUbuntu), "cw-a": await detail(cwA, onA) };
		expect(routed).toEqual({
			ubuntu: { machine: idOf(ubuntu), sameAsItsMachine: true },
			"cw-a": { machine: idOf(cwA), sameAsItsMachine: true },
		});

		const ubuntuId = idOf(ubuntu);
		const left = () => ({
			project: query(appHome, "SELECT COUNT(*) AS n FROM project WHERE machine_id = ?", ubuntuId)[0]!.n,
			space: query(appHome, "SELECT COUNT(*) AS n FROM space WHERE machine_id = ?", ubuntuId)[0]!.n,
			session: query(appHome, "SELECT COUNT(*) AS n FROM session WHERE machine_id = ?", ubuntuId)[0]!.n,
			thread: query(appHome, "SELECT COUNT(*) AS n FROM thread WHERE id = ?", onUbuntu.id)[0]!.n,
			entry: query(appHome, "SELECT COUNT(*) AS n FROM entry WHERE thread_id = ?", onUbuntu.id)[0]!.n,
		});
		const beforeRemove = left();
		await step("remove ubuntu", async () => {
			await desk.run((rpc) => rpc["servers.remove"]({ id: ubuntuId }));
			return { ubuntu: "cascade" };
		});
		members.delete("ubuntu");
		const afterRemove = left();
		expect(Object.values(afterRemove).every((n) => n === 0)).toBe(true);

		await snapshot(
			"several",
			normalize([[ubuntuId, "<machine ubuntu>"]])({ projects, routed, beforeRemove, afterRemove }),
		);
	}, 300_000);

	it("shuffle: a stopped machine resumes, a removed one cascades, a removed one comes back", async () => {
		const machineId = idOf(cwC);
		await step("stop cw-c (orb stop) and start it again", async (sync) => {
			const at = lastSeq(appHome);
			await orb(["stop", "cw-c"], { timeout: 120_000 });
			await orb(["start", "cw-c"], { timeout: 300_000 });
			await cwC.start();
			// The machine's name answers again a moment after it boots, sometimes after minutes.
			const bootedAt = performance.now();
			await waitFor(
				() => cwC.run((rpc) => rpc["server.info"]({}).pipe(Effect.timeout("5 seconds"))).catch(() => undefined),
				"cw-c reachable from the Mac",
				480_000,
			);
			measure("cw-c reachable after boot (ms)", Math.round(performance.now() - bootedAt));
			// The resume: from the server answering again to the app's cursor at its head.
			await sync(() => caughtUp(machineId, cwC));
			await session(cwC, work(cwC), "After a machine restart");
			await caughtUp(machineId, cwC);
			return { "cw-c": pathOf(machineId, at) };
		});
		const cwBId = idOf(cwB);
		await step("remove cw-b", async () => {
			await desk.run((rpc) => rpc["servers.remove"]({ id: cwBId }));
			return { "cw-b": "cascade" };
		});
		members.delete("cw-b");
		expect(rowsOf(cwBId)).toBe(0);
		await step("add ubuntu again", async () => {
			const at = lastSeq(appHome);
			const id = await add(ubuntu);
			await caughtUp(id, ubuntu);
			return { ubuntu: pathOf(id, at) };
		});
		expect(differences(appTables(idOf(ubuntu)), await harnessTables(ubuntu))).toEqual([]);
	}, 900_000);

	it("10. concurrent writes take strictly increasing revisions; a write without the current one is refused", async () => {
		const machineId = idOf(ubuntu);
		const created = await session(ubuntu, work(ubuntu), "Revisions");
		const sessionId = created.session.id;
		const reply = (await ubuntu.run((rpc) => rpc["thread.history"]({ sessionId }))).entries.at(-1)!;
		const fork = (await ubuntu.run((rpc) => rpc["thread.fork"]({ sessionId, entryId: reply.id }))).thread;
		const main = { sessionId, threadId: created.id };
		const forked = { sessionId, threadId: fork.id };
		const { rev: head } = await caughtUp(machineId, ubuntu);
		const projectId = created.session.project?.id;

		await ubuntu.run((rpc) =>
			Effect.all(
				[
					rpc["thread.prompt"]({ ...main, text: "Concurrent main" }).pipe(
						Effect.andThen(rpc["thread.wait"](main)),
					),
					rpc["thread.prompt"]({ ...forked, text: "Concurrent fork" }).pipe(
						Effect.andThen(rpc["thread.wait"](forked)),
					),
					rpc["thread.configure"]({ ...forked, runtime: { thinkingLevel: "high" } }),
					rpc["project.rename"]({ projectId: projectId!, name: "Renamed concurrently" }),
				],
				{ concurrency: "unbounded", discard: true },
			),
		);
		const items = await ubuntu.run((rpc) =>
			rpc["index.sync"]({ after: head }).pipe(
				Stream.takeUntil((item) => item._tag === "Synced"),
				Stream.runCollect,
			),
		);
		const revs = items.map((item) => item.rev);
		const synced = items.at(-1)!;
		const rows = items.filter((item) => item._tag !== "Synced");
		const increasing = revs.every((rev, index) => index === 0 || rev >= revs[index - 1]!);
		// One revision per write transaction: no two distinct write paths share one.
		const touched = await ubuntu.sql(
			`SELECT 'project' AS t, rev FROM project WHERE rev > ${head} UNION ALL SELECT 'thread', rev FROM thread WHERE rev > ${head}
			 UNION ALL SELECT 'entry', rev FROM entry WHERE rev > ${head} ORDER BY rev`,
		);
		const [store] = await ubuntu.sql("SELECT rev FROM store");
		const configured = rows.find(
			(item) => item._tag === "Thread" && item.thread.id === fork.id && item.thread.thinkingLevel === "high",
		);
		await caughtUp(machineId, ubuntu);
		const appThread = query(appHome, "SELECT thinking_level FROM thread WHERE id = ?", fork.id)[0];
		// The main thread's row is older than the head: rewriting it with its own rev is a write without the current revision.
		const [stale] = await ubuntu.sql(`SELECT rev FROM thread WHERE id = '${created.id}'`);
		expect(stale!.rev as number).toBeLessThan(store!.rev as number);
		const refused = await ubuntu.refused(
			`UPDATE thread SET title = 'Not at the current revision' WHERE id = '${created.id}';`,
		);
		// A write that stamps the head without taking a new revision is not caught: the trigger compares with
		// store.rev only, so it cannot tell a forgotten increment from a second write in the same transaction.
		const atHead = await ubuntu.refused(
			`UPDATE thread SET title = 'At the head, untaken', rev = (SELECT rev FROM store) WHERE id = '${created.id}';`,
		);
		const [headAfter] = await ubuntu.sql("SELECT rev FROM store");
		const refusedInsert = await ubuntu.refused(
			`INSERT INTO project (id, name, status, created_at, updated_at, rev) VALUES ('stray', 'Stray', 'active', 1, 1, 0);`,
		);
		const untouched = await ubuntu.sql(`SELECT title FROM thread WHERE id = '${created.id}'`);
		measure("case 10", { head, items: rows.length, revs: new Set(revs).size, store: store!.rev });
		expect(increasing).toBe(true);
		expect(revs.every((rev) => rev > head)).toBe(true);
		expect(synced).toMatchObject({ _tag: "Synced", rev: store!.rev });
		expect(touched.every((row) => (row.rev as number) > head && (row.rev as number) <= (store!.rev as number))).toBe(
			true,
		);
		expect(configured).toBeDefined();
		expect(appThread).toEqual({ thinking_level: "high" });
		expect(refused).toContain("rev is not the current revision");
		expect(refusedInsert).toContain("rev is not the current revision");
		expect(untouched[0]!.title).toBe(atHead === undefined ? "At the head, untaken" : "Revisions");
		expect(headAfter!.rev).toBe(store!.rev);

		await snapshot(
			"revisions",
			normalize()({
				itemsInRevOrder: increasing,
				itemTags: [...new Set(rows.map((item) => item._tag))].sort(),
				syncedAtStoreHead: synced.rev === store!.rev,
				configureReachedIndexSync: configured !== undefined,
				app: appThread,
				refused: { update: refused, insert: refusedInsert },
				headWithoutIncrement: { accepted: atHead === undefined, storeRevMoved: headAfter!.rev !== store!.rev },
			}),
		);
	}, 300_000);
	it("shuffle: the machine set's moves, rows and sync paths", async () => {
		expect(shuffle.length).toBeGreaterThan(0);
		await snapshot("shuffle", normalize()(shuffle));
	});
});
