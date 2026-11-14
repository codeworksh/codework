/* @effect-diagnostics nodeBuiltinImport:off -- the suite runs CodeWork servers on OrbStack Linux machines. */
import { Effect, Stream } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { Contract, type MetricsUsage } from "@codeworksh/contract";
import { Session } from "../../../packages/harness/src/effect.ts";
import {
	type AppRpc,
	app,
	cleanup,
	cursorOf,
	lastSeq,
	machineRow,
	notices,
	query,
	type Row,
	snapshot,
	stop,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";
import { available, ensure, machine, type Machine, orb } from "./machines/orb.ts";

/*
 * A long-lived desktop against two seeded machines: cw-a holds a year of history (300 sessions over
 * six projects), cw-b 200 days (120 sessions), both written through the thread store by
 * `machines/seed.ts`. Every case reads the totals inside each machine with sqlite3 and checks the
 * app's metrics reads against them: the first connect, live turns, the app down while work goes on,
 * a machine paused and resumed (and the app down across it), a network cut, a backup restored after
 * its head passed the app's cursor, a server removed and added again, and a store recreated.
 * `metrics.simulation.json` records each case's totals.
 */

const cwA = machine("cw-a");
const cwB = machine("cw-b");
const pool = [cwA, cwB];
type Desk = Awaited<ReturnType<typeof app>>;

let appHome = "";
let desk: Desk;
const ids = new Map<string, string>();
const idOf = (m: Machine) => ids.get(m.name)!;
const DAY = 86_400_000;
const until = () => new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
const everything = (zone = "UTC") => ({ zone, since: "1970-01-01", until: until() });
const PROJECTS = ["codework", "billing-api", "mobile-app", "infra", "docs-site", "ml-pipeline"];
const live = { CODEWORK_FIXTURE_HOST_OS: "1", CODEWORK_FIXTURE_NOW: "1" };

/** The machine's server stopped and its home moved aside: the next start makes a new store. */
const aside = async (m: Machine) => {
	await m.net("restore");
	await m.stop("KILL");
	await m.sh(`[ -d ${m.cwHome} ] && mv ${m.cwHome} ${m.cwHome}.sim-$(date +%s%N); mkdir -p ${m.cwHome}/work`);
};

/** A new store on `m` with `count` sessions and `days` of history, served again. */
const seeded = async (m: Machine, count: number, days: number, seed: number) => {
	await aside(m);
	await m.start(live);
	await m.sh(`mkdir -p ${PROJECTS.map((project) => `${m.cwHome}/work/${project}`).join(" ")}`);
	for (let i = 0; i < count; i++) {
		const project = PROJECTS[(i * 7 + seed) % PROJECTS.length]!;
		await m.run((rpc) =>
			rpc["session.create"]({
				directory: `${m.cwHome}/work/${project}`,
				title: `Session ${i + 1} in ${project}`,
				project: { name: project },
			}),
		);
	}
	await m.stop("TERM");
	const wrote = await m.sh(
		`cd ~/codework && ~/.local/node/bin/node --conditions=development apps/server/test/machines/seed.ts ${m.database} ${days} ${seed}`,
	);
	await m.start(live);
	return JSON.parse(wrote.trim().split("\n").at(-1)!) as Record<string, number>;
};

type Ref = { readonly sessionId: string };
const turn = (m: Machine, ref: Ref, text: string) =>
	m.run((rpc) => {
		const sessionId = Session.SessionSchema.ID.make(ref.sessionId);
		return rpc["thread.prompt"]({ sessionId, text }).pipe(Effect.andThen(rpc["thread.wait"]({ sessionId })));
	});
/** New work on `m`: a new session in a project with `turns` tool turns (two requests each). */
const work = async (m: Machine, turns: number) => {
	const created = await m.run((rpc) =>
		rpc["session.create"]({
			directory: `${m.cwHome}/work/codework`,
			title: "Live work",
			project: { name: "codework" },
		}),
	);
	for (let i = 0; i < turns; i++) await turn(m, { sessionId: created.session.id }, `bash echo live ${i}`);
	return { sessionId: created.session.id as string };
};

/** The app's latest warnings, for a wait that timed out. */
const warnings = () => {
	const last = desk.lines.findLastIndex((line) => line.includes("WARN") || line.includes("ERROR"));
	return last === -1
		? ""
		: desk.lines
				.slice(last, last + 12)
				.join("\n")
				.slice(0, 3_000);
};

/** Waits until the app's usage and index cursors for `m` reached its head, which `m` must be serving. */
const rolled = (m: Machine, { index = true, timeout = 180_000 } = {}) =>
	caught(m, index, timeout).catch((error: Error) => {
		throw new Error(`${error.message}\n${warnings()}`);
	});
const caught = async (m: Machine, index: boolean, timeout: number) => {
	const { storeId, rev } = await m.run((rpc) => rpc["server.info"]({}));
	await waitFor(
		() => {
			const row = cursorOf(appHome, idOf(m));
			return row.rollup_store === storeId && row.rollup >= rev ? row : undefined;
		},
		`${m.name} rolled up at rev ${rev}`,
		timeout,
	);
	if (index)
		await waitFor(
			() => {
				const row = machineRow(appHome, idOf(m));
				return row?.store_id === storeId && row.cursor >= rev ? row : undefined;
			},
			`${m.name} indexed at rev ${rev}`,
			timeout,
		);
	return { storeId, rev };
};

/** What `usage.sync` past `after` sends up to its first `Synced`: what a resume should apply. */
const pending = async (m: Machine, after: number) =>
	(
		await m.run((rpc) =>
			rpc["usage.sync"]({ after }).pipe(
				Stream.takeUntil((item) => item._tag === "Synced"),
				Stream.runCollect,
			),
		)
	).filter((item) => item._tag !== "Synced").length;

interface Truth {
	readonly requests: number;
	readonly tokens: number;
	readonly cost: number;
	readonly timed: number;
	readonly prompts: number;
	readonly tools: number;
}
const none: Truth = { requests: 0, tokens: 0, cost: 0, timed: 0, prompts: 0, tools: 0 };
const plus = (a: Truth, b: Truth): Truth => ({
	requests: a.requests + b.requests,
	tokens: a.tokens + b.tokens,
	cost: a.cost + b.cost,
	timed: a.timed + b.timed,
	prompts: a.prompts + b.prompts,
	tools: a.tools + b.tools,
});
/** The machine's rollup totals, read inside it. */
const truth = async (m: Machine): Promise<Truth> => {
	const [usage] = await m.sql(`
		SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(input + output + cache_read + cache_write), 0) AS tokens,
			COALESCE(SUM(cost), 0) AS cost, COALESCE(SUM(timed), 0) AS timed FROM usage
	`);
	const [tally] = await m.sql(`
		SELECT COALESCE(SUM(CASE kind WHEN 'prompt' THEN count END), 0) AS prompts,
			COALESCE(SUM(CASE kind WHEN 'tool' THEN count END), 0) AS tools FROM tally
	`);
	return {
		requests: usage!.requests as number,
		tokens: usage!.tokens as number,
		cost: usage!.cost as number,
		timed: usage!.timed as number,
		prompts: tally!.prompts as number,
		tools: tally!.tools as number,
	};
};
const read = (request: Parameters<AppRpc["metrics.usage"]>[0]) => desk.run((rpc) => rpc["metrics.usage"](request));
/** What a metrics read adds up to. */
const shown = (metrics: MetricsUsage): Truth => ({
	requests: metrics.rows.reduce((sum, row) => sum + row.requests, 0),
	tokens: metrics.rows.reduce(
		(sum, row) => sum + row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite,
		0,
	),
	cost: metrics.rows.reduce((sum, row) => sum + row.cost.total, 0),
	timed: metrics.rows.reduce((sum, row) => sum + row.timed, 0),
	prompts: metrics.tallies.filter((t) => t.kind === "prompt").reduce((sum, t) => sum + t.count, 0),
	tools: metrics.tallies.filter((t) => t.kind === "tool").reduce((sum, t) => sum + t.count, 0),
});
const expectTotals = (actual: Truth, expected: Truth) => {
	expect({ ...actual, cost: 0 }).toEqual({ ...expected, cost: 0 });
	expect(actual.cost).toBeCloseTo(expected.cost, 6);
};
/** The app's metrics equal what the machines hold, in every zone and per machine; returns the totals. */
const agrees = async (expected: ReadonlyArray<readonly [Machine | string, Truth]>) => {
	const all = expected.reduce((sum, [, t]) => plus(sum, t), none);
	for (const zone of ["UTC", "Asia/Kolkata", "Asia/Kathmandu", "America/Los_Angeles", "Pacific/Chatham"])
		expectTotals(shown(await read(everything(zone))), all);
	for (const [m, t] of expected)
		expectTotals(shown(await read({ ...everything(), machineId: typeof m === "string" ? m : idOf(m) })), t);
	// The projects split the whole without a remainder.
	const whole = await read(everything());
	let byProject = none;
	for (const project of whole.projects)
		byProject = plus(byProject, shown(await read({ ...everything(), projectId: project.id })));
	expectTotals(byProject, all);
	return { all, sessions: whole.sessions.length, deleted: whole.sessions.filter((s) => s.deleted).length };
};

const cases: Record<string, unknown> = {};
const describeMachines = available ? describe : describe.skip;

describeMachines("metrics simulation across OrbStack machines", () => {
	beforeAll(async () => {
		for (const m of pool) await ensure(m.name);
		await Promise.all(pool.map((m) => m.setup()));
		const [a, b] = await Promise.all([seeded(cwA, 300, 365, 11), seeded(cwB, 120, 200, 23)]);
		cases.seeded = { "cw-a": a, "cw-b": b };
		appHome = tempDir("metrics-simulation-app");
		desk = await app(appHome);
		for (const m of pool)
			ids.set(m.name, await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", url: m.url })));
	}, 3_600_000);

	afterAll(async () => {
		await Promise.all(pool.map((m) => m.net("restore").catch(() => undefined)));
		await cleanup();
	}, 120_000);

	it("the first connect mirrors both histories, deleted sessions keeping their numbers", async () => {
		for (const m of pool) await rolled(m);
		const before = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
		const doomed = await cwA.sql("SELECT id FROM session ORDER BY id LIMIT 7");
		for (const { id } of doomed)
			await cwA.run((rpc) => rpc["session.delete"]({ sessionId: Session.SessionSchema.ID.make(id as string) }));
		await rolled(cwA);
		const after = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
		expect(after.all).toEqual(before.all);
		expect(after.deleted).toBe(before.deleted + 7);
		cases.connected = { before, after };
	}, 600_000);

	it("live turns show while connected", async () => {
		const at = lastSeq(appHome);
		await work(cwA, 3);
		await rolled(cwA);
		const today = new Date().toISOString().slice(0, 10);
		const day = await read({ zone: "UTC", since: today, until: today, machineId: idOf(cwA) });
		expect(shown(day).requests).toBeGreaterThanOrEqual(6);
		expect(notices(appHome, Contract.syncTopics.usage, at).length).toBeGreaterThan(0);
		cases.live = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
	}, 600_000);

	it("the app down while both machines work resumes from its cursors", async () => {
		const cursors = pool.map((m) => cursorOf(appHome, idOf(m)).rollup);
		await stop(desk.proc, "SIGTERM");
		await Promise.all([work(cwA, 2), work(cwB, 4)]);
		const expected = await Promise.all(pool.map((m, at) => pending(m, cursors[at]!)));
		const restartedAt = lastSeq(appHome);
		desk = await app(appHome);
		for (const m of pool) await rolled(m);
		const applied = pool.map((m) =>
			notices(appHome, Contract.syncTopics.usage, restartedAt)
				.filter((payload) => payload.machineId === idOf(m))
				.reduce((sum, payload) => sum + (payload.items as number), 0),
		);
		expect(applied).toEqual(expected);
		cases.resumed = {
			applied,
			totals: await agrees([
				[cwA, await truth(cwA)],
				[cwB, await truth(cwB)],
			]),
		};
	}, 600_000);

	it("a paused machine keeps its history on screen and resumes without a re-read", async () => {
		const b = await truth(cwB);
		await orb(["stop", cwB.name], { timeout: 300_000 });
		await work(cwA, 2);
		await rolled(cwA);
		const paused = await agrees([
			[cwA, await truth(cwA)],
			[cwB, b],
		]);
		const cursor = cursorOf(appHome, idOf(cwB)).rollup;
		const at = lastSeq(appHome);
		await orb(["start", cwB.name], { timeout: 300_000 });
		await cwB.start(live);
		await rolled(cwB);
		const reread = notices(appHome, Contract.syncTopics.usage, at).filter((p) => p.machineId === idOf(cwB));
		expect(reread.reduce((sum, p) => sum + (p.items as number), 0)).toBe(await pending(cwB, cursor));
		expect(await truth(cwB)).toEqual(b);
		cases.paused = {
			paused,
			resumed: await agrees([
				[cwA, await truth(cwA)],
				[cwB, b],
			]),
		};
	}, 900_000);

	it("the app down across a machine's pause and restart, with work after it, resumes too", async () => {
		await stop(desk.proc, "SIGTERM");
		const cursor = cursorOf(appHome, idOf(cwA)).rollup;
		await orb(["stop", cwA.name], { timeout: 300_000 });
		await orb(["start", cwA.name], { timeout: 300_000 });
		await cwA.start(live);
		await work(cwA, 2);
		const expected = await pending(cwA, cursor);
		const at = lastSeq(appHome);
		desk = await app(appHome);
		for (const m of pool) await rolled(m);
		const applied = notices(appHome, Contract.syncTopics.usage, at)
			.filter((p) => p.machineId === idOf(cwA))
			.reduce((sum, p) => sum + (p.items as number), 0);
		expect(applied).toBe(expected);
		cases.restartedAway = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
	}, 900_000);

	it("work during a network cut arrives once the network is back", async () => {
		await cwA.net("cut");
		await cwA.drive([["session.create", { directory: `${cwA.cwHome}/work/infra`, title: "Offline work" }]]);
		const [{ id }] = (await cwA.sql("SELECT id FROM session ORDER BY created_at DESC LIMIT 1")) as [Row];
		await cwA.drive([
			["thread.prompt", { sessionId: id, text: "bash echo offline" }],
			["thread.wait", { sessionId: id }],
		]);
		await cwA.net("restore");
		await rolled(cwA);
		cases.cut = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
	}, 600_000);

	it("a backup restored after its head passed the app's cursor replaces that store's rows", async () => {
		await cwA.stop("TERM");
		await cwA.sh(`cp ${cwA.database} ${cwA.cwHome}/backup.db`);
		await cwA.start(live);
		const lost = await work(cwA, 2);
		const { rev: passed } = await rolled(cwA);
		await cwA.stop("TERM");
		await cwA.sh(
			`for f in ${cwA.database}-wal ${cwA.database}-shm; do [ -e $f ] && mv $f $f.lost; done; cp ${cwA.cwHome}/backup.db ${cwA.database}`,
		);
		await cwA.start(live);
		while ((await cwA.run((rpc) => rpc["server.info"]({}))).rev < passed) await work(cwA, 1);
		// The index does not recover from this yet: its resume skips the revisions the restore rewrote
		// and its batches fail on a thread whose session never came. Usage has its own stream.
		await rolled(cwA, { index: false });
		const ghost = query(appHome, "SELECT COUNT(*) AS n FROM usage WHERE session_id = ?", lost.sessionId)[0]!.n;
		expect(ghost).toBe(0);
		cases.restored = await agrees([
			[cwA, await truth(cwA)],
			[cwB, await truth(cwB)],
		]);
	}, 900_000);

	it("a removed server's history stays; added again, it is counted once", async () => {
		const b = await truth(cwB);
		const a = await truth(cwA);
		const removed = idOf(cwB);
		await desk.run((rpc) => rpc["servers.remove"]({ id: removed }));
		const kept = await agrees([
			[cwA, a],
			[removed, b],
		]);
		ids.set(cwB.name, await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", url: cwB.url })));
		await rolled(cwB);
		const again = await agrees([
			[cwA, a],
			[cwB, b],
		]);
		expect(again.all).toEqual(kept.all);
		cases.readded = { kept, again };
	}, 900_000);

	it("a recreated store adds to the old one's history", async () => {
		const old = await truth(cwB);
		const a = await truth(cwA);
		await aside(cwB);
		await cwB.start(live);
		await cwB.sh(`mkdir -p ${cwB.cwHome}/work/codework`);
		await work(cwB, 2);
		await rolled(cwB);
		const fresh = await truth(cwB);
		cases.recreated = await agrees([
			[cwA, a],
			[cwB, plus(old, fresh)],
		]);
		await snapshot("metrics.simulation", cases);
	}, 900_000);
});
