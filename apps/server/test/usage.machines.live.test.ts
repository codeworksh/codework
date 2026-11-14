/* @effect-diagnostics nodeBuiltinImport:off -- the suite runs CodeWork servers on OrbStack Linux machines. */
import { Effect, Option, Stream } from "effect";
import { userInfo } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Contract, type MetricsRow, type MetricsUsage } from "@codeworksh/contract";
import { Session } from "../../../packages/harness/src/effect.ts";
import {
	type AppRpc,
	app,
	cleanup,
	cursorOf,
	lastSeq,
	machineRow,
	normalizer,
	notices,
	query,
	type Row,
	snapshot as match,
	stop,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";
import { available, ensure, machine, type Machine } from "./machines/orb.ts";

/*
 * The usage rollup across real computers: the fixture CodeWork server (scripted model) runs on the
 * OrbStack machines cw-a, cw-b and cw-c, each reporting its own host name, all mirrored into one app
 * server on the Mac. Each machine's rollup is read inside it with sqlite3 and compared with app.db and
 * the metrics reads, across a network cut, an app restart and a deleted session.
 * `usage.machines.rollup.json` records the names, rows and totals.
 */

const userHome = `/home/${userInfo().username}`;
const cwA = machine("cw-a");
const cwB = machine("cw-b");
const cwC = machine("cw-c");
const pool = [cwA, cwB, cwC];

type Desk = Awaited<ReturnType<typeof app>>;
type Rollup = { readonly usage: Array<Row>; readonly tally: Array<Row> };

let appHome = "";
let desk: Desk;
const ids = new Map<string, string>();
const stores = new Map<string, string>();
const idOf = (m: Machine) => ids.get(m.name)!;

const work = (m: Machine) => `${m.cwHome}/work`;
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const everything = { zone: "UTC", since: "1970-01-01", until: new Date(Date.now() + DAY).toISOString().slice(0, 10) };

/** A machine with a fresh store and its server running, named as the OS names the machine. */
const fresh = async (m: Machine) => {
	await m.net("restore");
	await m.net("fast");
	await m.stop("KILL");
	await m.wipe();
	await m.sh(`mkdir -p ${work(m)}`);
	await m.start({ CODEWORK_FIXTURE_HOST_OS: "1" });
};

/** Waits until the app's index cursor for `m` reached its head. */
const caughtUp = async (m: Machine, timeout = 120_000) => {
	const { storeId, rev } = await m.run((rpc) => rpc["server.info"]({}));
	await waitFor(
		() => {
			const row = machineRow(appHome, idOf(m));
			return row?.store_id === storeId && row.cursor >= rev ? row : undefined;
		},
		`${m.name} indexed at rev ${rev}`,
		timeout,
	);
};
/** Waits until the app's usage cursor for `m` reached its head. */
const rolledUp = async (m: Machine, timeout = 120_000) => {
	const { storeId, rev } = await m.run((rpc) => rpc["server.info"]({}));
	await waitFor(
		() => {
			const row = cursorOf(appHome, idOf(m));
			return row.rollup_store === storeId && row.rollup >= rev ? row : undefined;
		},
		`${m.name} rolled up at rev ${rev}`,
		timeout,
	);
	stores.set(m.name, storeId);
};
const settled = async () => {
	for (const m of pool) {
		await caughtUp(m);
		await rolledUp(m);
	}
};

type Ref = { readonly sessionId: string; readonly threadId?: string };
const branded = (ref: Ref) => ({
	sessionId: Session.SessionSchema.ID.make(ref.sessionId),
	...(ref.threadId === undefined ? {} : { threadId: Session.ThreadSchema.ID.make(ref.threadId) }),
});
const turn = (m: Machine, ref: Ref, text: string) =>
	m.run((rpc) =>
		rpc["thread.prompt"]({ ...branded(ref), text }).pipe(Effect.andThen(rpc["thread.wait"](branded(ref)))),
	);
const session = async (m: Machine, text: string) => {
	const created = await m.run((rpc) => rpc["session.create"]({ directory: work(m) }));
	await turn(m, { sessionId: created.session.id }, text);
	return { sessionId: created.session.id as string, threadId: created.id as string };
};
const fork = async (m: Machine, ref: Ref) => {
	const forked = await m.run((rpc) =>
		Effect.gen(function* () {
			const reply = (yield* rpc["thread.history"](branded(ref))).entries.at(-1)!;
			return (yield* rpc["thread.fork"]({ ...branded(ref), entryId: reply.id })).thread;
		}),
	);
	return { sessionId: ref.sessionId, threadId: forked.id as string };
};

// Rows keyed as both stores key them, sorted so each side lines up.
const keyOf = (row: Row) =>
	[row.hour, row.thread_id, row.provider ?? row.kind, row.model ?? row.name, row.thinking].map(String).join("|");
const byKey = (rows: ReadonlyArray<Row>) => rows.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b)));
const byRev = (rows: ReadonlyArray<Row>) =>
	rows.toSorted((a, b) => (a.rev as number) - (b.rev as number) || keyOf(a).localeCompare(keyOf(b)));

/** The machine's own rollup, read in it. */
const harness = async (m: Machine): Promise<Rollup> => ({
	usage: await m.sql("SELECT * FROM usage"),
	tally: await m.sql("SELECT * FROM tally"),
});
/** What app.db mirrors of `m`, without the machine and store it is keyed by. */
const mirrored = (m: Machine): Rollup & { readonly stores: ReadonlyArray<unknown> } => {
	const strip = (rows: Array<Row>) => rows.map(({ machine_id: _m, store_id: _s, ...row }) => row);
	const usage = query(appHome, "SELECT * FROM usage WHERE machine_id = ?", idOf(m));
	const tally = query(appHome, "SELECT * FROM tally WHERE machine_id = ?", idOf(m));
	return {
		usage: strip(usage),
		tally: strip(tally),
		stores: [...new Set([...usage, ...tally].map((row) => row.store_id))],
	};
};
const whole = () => ({
	usage: query(appHome, "SELECT * FROM usage ORDER BY machine_id, rev, thread_id, provider, model"),
	tally: query(appHome, "SELECT * FROM tally ORDER BY machine_id, rev, thread_id, kind, name"),
});

/** app.db holds exactly the machine's rollup, from its current store. */
const expectMirror = async (m: Machine) => {
	const theirs = await harness(m);
	const mine = mirrored(m);
	expect(byKey(mine.usage)).toEqual(byKey(theirs.usage));
	expect(byKey(mine.tally)).toEqual(byKey(theirs.tally));
	expect(mine.stores).toEqual([stores.get(m.name)]);
	return theirs;
};

type Totals = { requests: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
const zero: Totals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const add = (a: Totals, b: Totals): Totals => ({
	requests: a.requests + b.requests,
	input: a.input + b.input,
	output: a.output + b.output,
	cacheRead: a.cacheRead + b.cacheRead,
	cacheWrite: a.cacheWrite + b.cacheWrite,
	cost: a.cost + b.cost,
});
const ofRows = (rows: ReadonlyArray<Row>) =>
	rows.reduce<Totals>(
		(total, row) =>
			add(total, {
				requests: row.requests as number,
				input: row.input as number,
				output: row.output as number,
				cacheRead: row.cache_read as number,
				cacheWrite: row.cache_write as number,
				cost: row.cost as number,
			}),
		zero,
	);
const ofMetrics = (rows: ReadonlyArray<MetricsRow>) =>
	rows.reduce<Totals>(
		(total, row) =>
			add(total, {
				requests: row.requests,
				input: row.tokens.input,
				output: row.tokens.output,
				cacheRead: row.tokens.cacheRead,
				cacheWrite: row.tokens.cacheWrite,
				cost: row.cost.total,
			}),
		zero,
	);
const tallies = (rows: ReadonlyArray<Row>) => {
	const by: Record<string, number> = {};
	for (const row of rows)
		by[`${String(row.kind)}:${String(row.name)}`] =
			(by[`${String(row.kind)}:${String(row.name)}`] ?? 0) + (row.count as number);
	return by;
};
const metricsTallies = (metrics: MetricsUsage) =>
	tallies(metrics.tallies.map((tally) => ({ kind: tally.kind, name: tally.name, count: tally.count })));

const read = (request: Parameters<AppRpc["metrics.usage"]>[0]) => desk.run((rpc) => rpc["metrics.usage"](request));

/** What each read that names a machine shows, per machine as Settings lists them. */
const names = async () => {
	const rows = query(appHome, "SELECT id, kind, name, host FROM machine ORDER BY pos");
	const reads = await desk.run((rpc) =>
		Effect.gen(function* () {
			const sidebar = yield* rpc["sidebar.list"]({
				organizationId: Contract.PERSONAL_ORGANIZATION,
				machines: "all",
			});
			const threads = yield* rpc["threads.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, by: "status" });
			const statuses = yield* rpc["servers.watch"](undefined).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
			const listed = threads.lists.flatMap((list) => list.threads);
			return statuses.map(({ id, name, host, override }) => ({
				id,
				name,
				host,
				override,
				sidebar: sidebar.find((project) => project.machine.id === id)?.machine.name,
				allThreads: listed.find((thread) => thread.machine.id === id)?.machine.name,
			}));
		}),
	);
	return reads.map((read) => ({ stored: rows.find((row) => row.id === read.id), ...read }));
};
const shown = (state: Awaited<ReturnType<typeof names>>, m: Machine) => {
	const found = state.find((read) => read.id === idOf(m));
	return [found?.name, found?.sidebar, found?.allThreads];
};

// Kept for the artifact as the cases go.
const artifact: Record<string, unknown> = {};
let workload: Record<string, { sessions: Array<Ref> }> = {};

const describeMachines = available ? describe : describe.skip;

describeMachines("usage across OrbStack machines", () => {
	beforeAll(async () => {
		for (const m of pool) await ensure(m.name);
		await Promise.all(pool.map((m) => m.setup()));
		await Promise.all(pool.map((m) => fresh(m)));
		appHome = tempDir("usage-machines-app");
		desk = await app(appHome);
		// No name of its own: each is named by the host its server reports.
		for (const m of pool)
			ids.set(m.name, await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", url: m.url })));

		// Different work on each: a turn with a tool call (two requests); two turns; a turn and a fork's turn.
		const a = await session(cwA, "bash echo alpha");
		const b = await session(cwB, "first");
		await turn(cwB, b, "second");
		const c = await session(cwC, "bash echo gamma");
		const forked = await fork(cwC, c);
		await turn(cwC, forked, "in the fork");
		workload = { "cw-a": { sessions: [a] }, "cw-b": { sessions: [b] }, "cw-c": { sessions: [c, forked] } };
		await settled();
	}, 1_800_000);

	afterAll(async () => {
		await Promise.all(
			pool.map((m) =>
				m
					.net("fast")
					.then(() => m.net("restore"))
					.then(() => m.stop("TERM"))
					.catch(() => undefined),
			),
		);
		await cleanup();
	}, 120_000);

	it("1. each machine is named by its own host name; an override wins and clears back to it", async () => {
		const reported = await waitFor(async () => {
			const state = await names();
			return pool.every((m) => state.find((read) => read.id === idOf(m))?.stored?.host === m.name)
				? state
				: undefined;
		}, "every machine's host name");
		for (const m of pool) {
			const found = reported.find((read) => read.id === idOf(m))!;
			expect(found.stored).toMatchObject({ kind: "remote", name: null, host: m.name });
			expect(found).toMatchObject({ host: m.name, override: null });
			expect(shown(reported, m)).toEqual(Array(3).fill(m.name));
		}

		await desk.run((rpc) => rpc["servers.update"]({ id: idOf(cwB), name: " Build Box " }));
		const overridden = await names();
		expect(shown(overridden, cwB)).toEqual(Array(3).fill("Build Box"));
		expect(shown(overridden, cwA)).toEqual(Array(3).fill("cw-a"));
		const overriddenMetrics = (await read(everything)).machines.find((entry) => entry.id === idOf(cwB));
		expect(overriddenMetrics?.name).toBe("Build Box");

		await desk.run((rpc) => rpc["servers.update"]({ id: idOf(cwB), name: "" }));
		const cleared = await names();
		expect(shown(cleared, cwB)).toEqual(Array(3).fill("cw-b"));
		expect(cleared.find((read) => read.id === idOf(cwB))?.stored).toMatchObject({ name: null, host: "cw-b" });

		const steps = { reported, overridden, overriddenMetrics, cleared };
		expect(JSON.stringify(steps)).not.toContain("CodeWork");
		artifact.names = steps;
	}, 300_000);

	it("2. each machine's mirrored usage and tallies are its own rollup, and sum to its threads' usage", async () => {
		const rollups: Record<string, unknown> = {};
		for (const m of pool) {
			const theirs = await expectMirror(m);
			const threads = await m.sql("SELECT id, session_id FROM thread ORDER BY created_at, created_seq");
			const reported = await m.run((rpc) =>
				Effect.forEach(threads, (thread) =>
					rpc["thread.info"](
						branded({ sessionId: thread.session_id as string, threadId: thread.id as string }),
					).pipe(Effect.map((info) => ({ id: thread.id as string, usage: info.usage }))),
				),
			);
			const app = mirrored(m);
			for (const { id, usage } of reported) {
				const rows = app.usage.filter((row) => row.thread_id === id);
				expect(ofRows(rows)).toMatchObject({
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					cost: usage.cost,
				});
			}
			rollups[m.name] = {
				threads: reported.length,
				totals: ofRows(theirs.usage),
				tallies: tallies(theirs.tally),
				usage: byRev(app.usage),
				tally: byRev(app.tally),
			};
		}
		expect(
			Object.fromEntries(
				Object.entries(rollups).map(([name, rollup]) => [name, (rollup as { totals: Totals }).totals.requests]),
			),
		).toEqual({
			"cw-a": 2,
			"cw-b": 2,
			"cw-c": 3,
		});
		expect(
			Object.fromEntries(
				Object.entries(rollups).map(([name, rollup]) => [name, (rollup as { tallies: unknown }).tallies]),
			),
		).toEqual({
			"cw-a": { "prompt:": 1, "tool:bash": 1 },
			"cw-b": { "prompt:": 2 },
			"cw-c": { "prompt:": 2, "tool:bash": 1 },
		});
		artifact.rollup = rollups;
	}, 300_000);

	it("3. metrics.usage sums every machine or one, names each machine, and metrics.hours holds the day's totals", async () => {
		const own = new Map<string, Rollup>();
		for (const m of pool) own.set(m.name, await harness(m));
		const all = await read(everything);
		const total = pool.reduce((sum, m) => add(sum, ofRows(own.get(m.name)!.usage)), zero);
		expect(ofMetrics(all.rows)).toEqual(total);
		expect(all.machines.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual(
			pool.map((m) => ({ id: idOf(m), name: m.name })),
		);

		const perMachine: Record<string, unknown> = {};
		for (const m of pool) {
			const one = await read({ ...everything, machineId: idOf(m) });
			const theirs = own.get(m.name)!;
			expect(new Set(one.rows.map((row) => row.machineId))).toEqual(new Set([idOf(m)]));
			expect(new Set(one.tallies.map((row) => row.machineId))).toEqual(new Set([idOf(m)]));
			expect(ofMetrics(one.rows)).toEqual(ofRows(theirs.usage));
			expect(metricsTallies(one)).toEqual(tallies(theirs.tally));
			expect(one.machines).toEqual([{ id: idOf(m), name: m.name }]);
			perMachine[m.name] = { totals: ofMetrics(one.rows), tallies: metricsTallies(one), machines: one.machines };
		}

		// The scripted model stamps its requests with its own clock, so they land on the day of its hours;
		// prompts land on today's.
		const requestDays = [
			...new Set(
				[...own.values()].flatMap((rollup) =>
					rollup.usage.map((row) => new Date(row.hour as number).toISOString().slice(0, 10)),
				),
			),
		].toSorted();
		const hours = [];
		for (const day of requestDays)
			hours.push(...(await desk.run((rpc) => rpc["metrics.hours"]({ zone: "UTC", day }))));
		const tokens = total.input + total.output + total.cacheRead + total.cacheWrite;
		expect({
			requests: hours.reduce((sum, row) => sum + row.requests, 0),
			tokens: hours.reduce((sum, row) => sum + row.tokens, 0),
			cost: hours.reduce((sum, row) => sum + row.cost, 0),
		}).toEqual({ requests: total.requests, tokens, cost: total.cost });
		const onDays = await read({ zone: "UTC", since: requestDays[0]!, until: requestDays.at(-1)! });
		expect(ofMetrics(onDays.rows)).toEqual(total);
		const onToday = await read({ zone: "UTC", since: today, until: today });
		const prompts = pool.reduce((sum, m) => sum + (tallies(own.get(m.name)!.tally)["prompt:"] ?? 0), 0);
		expect(metricsTallies(onToday)["prompt:"]).toBe(prompts);

		artifact.metrics = {
			all: {
				totals: ofMetrics(all.rows),
				tallies: metricsTallies(all),
				// Listed by id, which is random: kept by name.
				machines: all.machines.toSorted((a, b) => a.name.localeCompare(b.name)),
			},
			perMachine,
			requestDays,
			hours: hours.toSorted(
				(a, b) =>
					a.hour - b.hour || a.machineId.localeCompare(b.machineId) || a.sessionId.localeCompare(b.sessionId),
			).length,
			todayPrompts: metricsTallies(onToday)["prompt:"],
		};
	}, 300_000);

	it("4. a cut machine catches up from its cursor with nothing lost or doubled; an app restart changes nothing", async () => {
		const [a] = workload["cw-a"]!.sessions;
		const cursor = cursorOf(appHome, idOf(cwB)).rollup;

		const cutAt = performance.now();
		await cwB.net("cut");
		// cw-b keeps working over its own loopback, in a new session so its older rows stay before the
		// cursor; the others over the network.
		const [created] = (await cwB.drive([["session.create", { directory: work(cwB) }]])) as [
			{ session: { id: string }; id: string },
		];
		await cwB.drive([
			["thread.prompt", { sessionId: created.session.id, text: "bash echo while cut" }],
			["thread.wait", { sessionId: created.session.id }],
		]);
		await turn(cwA, a!, "bash echo during the cut");
		await session(cwC, "during the cut");
		await rolledUp(cwA);
		await rolledUp(cwC);
		// Past the client's ping timeout, so the app has dropped the connection.
		const held = 15_000 - (performance.now() - cutAt);
		if (held > 0) await new Promise((resolve) => setTimeout(resolve, held));
		expect(cursorOf(appHome, idOf(cwB)).rollup).toBe(cursor);

		const at = lastSeq(appHome);
		await cwB.net("restore");
		await rolledUp(cwB);
		const changed = notices(appHome, Contract.syncTopics.usage, at).filter(
			(notice) => notice.machineId === idOf(cwB),
		);
		const since = await harness(cwB);
		const pending = [...since.usage, ...since.tally].filter((row) => (row.rev as number) > cursor).length;
		const sent = changed.reduce((sum, notice) => sum + (notice.items as number), 0);
		expect(sent).toBe(pending);
		expect(pending).toBeLessThan(since.usage.length + since.tally.length);
		await expectMirror(cwB);

		await turn(cwB, { sessionId: created.session.id }, "after the cut");
		await settled();
		for (const m of pool) await expectMirror(m);
		const totals = Object.fromEntries(
			await Promise.all(pool.map(async (m) => [m.name, ofRows((await harness(m)).usage)] as const)),
		);
		expect(Object.fromEntries(pool.map((m) => [m.name, ofRows(mirrored(m).usage)]))).toEqual(totals);

		// The app restarts: it resumes every machine from its cursor and holds the same rows.
		const before = whole();
		const metricsBefore = await read(everything);
		await stop(desk.proc);
		const restartedAt = lastSeq(appHome);
		desk = await app(appHome);
		await settled();
		const resent = notices(appHome, Contract.syncTopics.usage, restartedAt).reduce(
			(sum, notice) => sum + (notice.items as number),
			0,
		);
		expect(whole()).toEqual(before);
		expect(resent).toBe(0);
		const metricsAfter = await read(everything);
		expect(ofMetrics(metricsAfter.rows)).toEqual(ofMetrics(metricsBefore.rows));
		for (const m of pool) await expectMirror(m);

		artifact.resilience = {
			cut: "cw-b",
			resumed: { sent, pending, notices: changed.length > 0 },
			totals,
			restart: { resent, rowsUnchanged: true, metrics: ofMetrics(metricsAfter.rows) },
		};
	}, 300_000);

	it("5. a session deleted on its machine keeps its mirrored usage, marked deleted", async () => {
		const [c] = workload["cw-c"]!.sessions;
		const before = whole();
		const metricsBefore = await read(everything);
		await cwC.run((rpc) => rpc["session.delete"](branded({ sessionId: c!.sessionId })));
		await caughtUp(cwC);
		await rolledUp(cwC);
		expect(query(appHome, "SELECT deleted_at FROM session WHERE id = ?", c!.sessionId)[0]?.deleted_at).not.toBeNull();
		expect(whole()).toEqual(before);
		const after = await read(everything);
		expect(after.rows).toEqual(metricsBefore.rows);
		const entry = after.sessions.find((one) => one.id === c!.sessionId);
		expect(entry).toMatchObject({ machineId: idOf(cwC), title: null, deleted: true });
		expect(after.sessions.filter((one) => one.deleted).map((one) => one.id)).toEqual([c!.sessionId]);
		artifact.deleted = {
			session: entry,
			rows: after.rows.filter((row) => row.sessionId === c!.sessionId).length,
			totals: ofMetrics(after.rows.filter((row) => row.sessionId === c!.sessionId)),
		};
	}, 300_000);

	it("the artifact: names, rollups, totals and recoveries", async () => {
		// Requests carry the scripted model's own hours, prompts the real one.
		const hours = (value: unknown, key?: string): unknown => {
			if (key === "hour" && typeof value === "number") return value < DAY ? "<request hour>" : "<prompt hour>";
			if (Array.isArray(value)) return value.map((item) => hours(item));
			if (typeof value === "object" && value !== null)
				return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hours(v, k)]));
			return value;
		};
		const projects = query(appHome, "SELECT DISTINCT id, name FROM project ORDER BY name").map(
			(row) => [row.id as string, `<project ${row.name as string}>`] as const,
		);
		await match(
			"usage.machines.rollup",
			normalizer(
				[appHome, userHome],
				[
					...pool.map((m) => [idOf(m), `<machine ${m.name}>`] as const),
					...pool.map((m) => [stores.get(m.name)!, `<store ${m.name}>`] as const),
					...projects,
					[today, "<today>"],
				],
			)(hours(artifact)),
		);
	});
});
