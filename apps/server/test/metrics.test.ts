/* @effect-diagnostics nodeBuiltinImport:off -- the suite makes project folders and removes CodeWork stores in temp dirs. */
import { Effect } from "effect";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract, type MetricsHour, type MetricsRow, type MetricsUsage } from "@codeworksh/contract";
import { edges } from "@codeworksh/widget/codework";
import type * as Client from "../../../packages/codework/src/server/client.ts";
import {
	app,
	type AppRpc,
	cleanup,
	type Codework,
	codework,
	follow,
	freePort,
	normalizer,
	query,
	rolled,
	snapshot as match,
	stop,
	synced,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const snapshot = (name: string, artifact: unknown) => match(`metrics.${name}`, artifact);

type Desk = Awaited<ReturnType<typeof app>>;
type Scope = Omit<Parameters<AppRpc["metrics.usage"]>[0], "since" | "until">;

// The scripted model's requests land in the first hour of 1970 and prompts in the real one, so a
// period covering every row runs from then to tomorrow.
const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);
const everything = { zone: "UTC", since: "1970-01-01", until: new Date(Date.now() + DAY).toISOString().slice(0, 10) };

const read = (desk: Desk, request: Parameters<AppRpc["metrics.usage"]>[0]) =>
	desk.run((rpc) => rpc["metrics.usage"](request));
const hoursOf = (desk: Desk, request: Parameters<AppRpc["metrics.hours"]>[0]) =>
	desk.run((rpc) => rpc["metrics.hours"](request));

/** What the rows add up to. */
const sum = (rows: ReadonlyArray<MetricsRow>) =>
	rows.reduce(
		(total, row) => ({
			requests: total.requests + row.requests,
			input: total.input + row.tokens.input,
			output: total.output + row.tokens.output,
			cacheRead: total.cacheRead + row.tokens.cacheRead,
			cacheWrite: total.cacheWrite + row.tokens.cacheWrite,
			cost: total.cost + row.cost.total,
		}),
		{ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
const counts = (metrics: MetricsUsage) => {
	const by = new Map<string, number>();
	for (const tally of metrics.tallies)
		by.set(`${tally.kind}:${tally.name}`, (by.get(`${tally.kind}:${tally.name}`) ?? 0) + tally.count);
	return Object.fromEntries(by);
};

/** Projects by name: their ids are their folders' hashes, which differ each run. */
const named = (metrics: MetricsUsage) => ({
	...metrics,
	projects: metrics.projects.toSorted((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
});

/** A session in `directory` of project `name` whose prompt runs one `bash` call. */
const session = async (server: Codework, directory: string, name: string, command: string) => {
	mkdirSync(directory, { recursive: true });
	const created = await server.run((rpc) => rpc["session.create"]({ directory, project: { name } }));
	await turn(server, { sessionId: created.session.id }, command);
	return created;
};
const turn = (server: Codework, ref: Parameters<Client.Client["thread.wait"]>[0], command: string) =>
	server.run((rpc) =>
		rpc["thread.prompt"]({ ...ref, text: `bash ${command}` }).pipe(Effect.andThen(rpc["thread.wait"](ref))),
	);

/** Adds `server` with no name of its own: it is named by the host it reports. */
const addServer = async (home: string, server: Codework, desk: Desk) => {
	const id = await desk.run((rpc) => rpc["servers.add"]({ kind: "remote", url: server.url }));
	await synced(home, id, server);
	return id;
};

/** Each project id a machine's store holds, by name, for the artifacts' labels. */
const projectLabels = (home: string) =>
	query(home, "SELECT DISTINCT id, name FROM project ORDER BY name").map(
		(row) => [row.id as string, `<project ${row.name as string}>`] as const,
	);

it("a period's usage sums each session's threads, counts its threads per day and names its sessions, projects and machine; a deleted session keeps its rows", async () => {
	const cwHome = tempDir("metrics-cw");
	const appHome = tempDir("metrics-app");
	const server = await codework(cwHome, await freePort(), { host: "Metrics Host" });
	const desk = await app(appHome);
	const machineId = await addServer(appHome, server, desk);
	const topics = await follow(desk, Contract.readTopics.metrics);

	// A session with a fork that runs a turn of its own, and a second session in another project.
	const forked = await session(server, join(cwHome, "alpha"), "Alpha", "echo one");
	const fork = await server.run((rpc) =>
		Effect.gen(function* () {
			const ref = { sessionId: forked.session.id };
			const reply = (yield* rpc["thread.history"](ref)).entries.at(-1)!;
			return (yield* rpc["thread.fork"]({ ...ref, entryId: reply.id })).thread;
		}),
	);
	await turn(server, { sessionId: forked.session.id, threadId: fork.id }, "echo fork");
	const other = await session(server, join(cwHome, "beta"), "Beta", "echo two");
	const { storeId } = await rolled(appHome, machineId, server);
	const notice = await waitFor(
		() => topics.events.find((event) => event.topic === Contract.syncTopics.usage),
		"a usage notice",
	);
	topics.stop();

	const reported = await server.run((rpc) =>
		Effect.forEach(
			[
				{ sessionId: forked.session.id, threadId: forked.id },
				{ sessionId: forked.session.id, threadId: fork.id },
				{ sessionId: other.session.id, threadId: other.id },
			],
			(ref) => rpc["thread.info"](ref).pipe(Effect.map((thread) => thread.usage)),
		),
	);
	const before = await read(desk, everything);
	const totals = sum(before.rows);
	expect(totals).toEqual({
		requests: 6,
		input: reported.reduce((all, usage) => all + usage.input, 0),
		output: reported.reduce((all, usage) => all + usage.output, 0),
		cacheRead: reported.reduce((all, usage) => all + usage.cacheRead, 0),
		cacheWrite: reported.reduce((all, usage) => all + usage.cacheWrite, 0),
		cost: reported.reduce((all, usage) => all + usage.cost, 0),
	});
	expect(counts(before)).toEqual({ "prompt:": 3, "tool:bash": 3 });

	// CodeWork starts no subagents yet, so the rollup row is written as the sync would copy one: the fork's, under a thread of its own.
	const columns = query(appHome, "SELECT name FROM pragma_table_info('usage')").map((row) => row.name as string);
	write(
		appHome,
		`INSERT INTO usage (${columns.join(", ")})
		 SELECT ${columns.map((name) => (name === "thread_id" ? "'thr_subagent'" : name)).join(", ")} FROM usage WHERE thread_id = ?`,
		fork.id,
	);
	const after = await read(desk, everything);
	const threadsOf = (metrics: MetricsUsage, sessionId: string) =>
		metrics.threads.filter((row) => row.sessionId === sessionId).map((row) => [row.day, row.threads]);
	// Requests and tool calls in 1970, prompts today.
	expect(threadsOf(after, forked.session.id)).toEqual([
		["1970-01-01", 3],
		[today, 2],
	]);
	expect(threadsOf(after, other.session.id)).toEqual([
		["1970-01-01", 1],
		[today, 1],
	]);
	expect(sum(after.rows).requests).toBe(8);
	expect(after.rows.filter((row) => row.sessionId === forked.session.id)).toHaveLength(1);
	expect(after.machines).toEqual([{ id: machineId, name: "Metrics Host" }]);
	expect(named(after).projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);
	expect(
		after.sessions
			.map(({ id, title, deleted }) => ({ id, title, deleted }))
			.toSorted((a, b) => a.id.localeCompare(b.id)),
	).toEqual(
		[
			{ id: forked.session.id, title: "bash echo one", deleted: false },
			{ id: other.session.id, title: "bash echo two", deleted: false },
		].toSorted((a, b) => a.id.localeCompare(b.id)),
	);
	expect(after.edges).toEqual([...edges]);

	// A deleted session: its rows stay, its title goes, its project is still named.
	await server.run((rpc) => rpc["session.delete"]({ sessionId: other.session.id }));
	await synced(appHome, machineId, server);
	const deleted = await read(desk, everything);
	expect(deleted.rows).toEqual(after.rows);
	expect(deleted.sessions.find((entry) => entry.id === other.session.id)).toMatchObject({
		title: null,
		deleted: true,
	});
	expect(deleted.projects).toEqual(after.projects);

	await snapshot(
		"usage",
		normalizer(
			[cwHome, appHome],
			[...projectLabels(appHome), [today, "<today>"], [storeId, "<store>"]],
		)({
			notice: notice.payload,
			reported,
			after: named(after),
			deleted: { sessions: deleted.sessions },
		}),
	);
}, 120_000);

/** A usage row as `usage.sync` would leave it: `requests` requests, each of 10 input and 5 output tokens and $0.5. */
const put = (
	home: string,
	row: {
		hour: number;
		project: string;
		session: string;
		thread?: string;
		store?: string;
		model?: string;
		requests?: number;
	},
) => {
	const requests = row.requests ?? 1;
	const durations = Array.from({ length: edges.length + 1 }, (_, bucket) => (bucket === 1 ? requests : 0));
	write(
		home,
		`INSERT INTO usage (machine_id, store_id, hour, thread_id, provider, model, thinking, session_id, project_id,
			requests, input, output, cache_read, cache_write, reasoning, cost, cost_input, cost_output, cost_cache_read,
			cost_cache_write, duration, timed, durations, rev)
		 VALUES ('local', ?, ?, ?, 'scripted', ?, 'off', ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, 0, 0, ?, ?, ?, 1)`,
		row.store ?? "store_one",
		row.hour,
		row.thread ?? `thr_${row.session}`,
		row.model ?? "model",
		row.session,
		row.project,
		requests,
		requests * 10,
		requests * 5,
		requests * 0.5,
		requests * 0.25,
		requests * 0.25,
		requests * 300,
		requests,
		JSON.stringify(durations),
	);
};
const prompt = (home: string, row: { hour: number; project: string; session: string; thread: string }) =>
	write(
		home,
		`INSERT INTO tally (machine_id, store_id, hour, thread_id, kind, name, session_id, project_id, count, rev)
		 VALUES ('local', 'store_one', ?, ?, 'prompt', '', ?, ?, 1, 1)`,
		row.hour,
		row.thread,
		row.session,
		row.project,
	);

const utc = (month: number, day: number, hour: number) => Date.UTC(2026, month - 1, day, hour);
const days = (metrics: MetricsUsage) =>
	Object.fromEntries(
		[...new Set(metrics.rows.map((row) => row.day))].map((day) => [
			day,
			sum(metrics.rows.filter((row) => row.day === day)).requests,
		]),
	);
const hourly = (hours: ReadonlyArray<MetricsHour>) => hours.map((row) => [row.hour, row.requests]);

it("usage lands on the zone's local days and hours: half-hour offsets, both sides of midnight, clock changes, and stores summed", async () => {
	const appHome = tempDir("metrics-zones-app");
	const desk = await app(appHome);

	// 18:00 UTC is 23:30 in Kolkata and 23:45 in Kathmandu; 19:00 UTC is 00:30 and 00:45 the next day.
	put(appHome, { hour: utc(3, 9, 18), project: "prj_india", session: "india", requests: 1 });
	put(appHome, { hour: utc(3, 9, 19), project: "prj_india", session: "india", requests: 2 });
	// 06:00 UTC is 23:00 the day before in Los Angeles (PDT), 07:00 UTC its midnight.
	put(appHome, { hour: utc(3, 10, 6), project: "prj_la", session: "la", requests: 1 });
	put(appHome, { hour: utc(3, 10, 7), project: "prj_la", session: "la", requests: 2 });
	// Every UTC hour from the last before Los Angeles' 1 November to the first after: it is 25 hours long.
	for (let hour = utc(11, 1, 6); hour <= utc(11, 2, 8); hour += 3_600_000)
		put(appHome, { hour, project: "prj_fall", session: "fall" });
	// And around 8 March, which is 23 hours long.
	for (let hour = utc(3, 8, 7); hour <= utc(3, 9, 7); hour += 3_600_000)
		put(appHome, { hour, project: "prj_spring", session: "spring" });
	// One hour of a session from two stores of the machine, and a second thread in the newer one.
	put(appHome, { hour: utc(5, 1, 12), project: "prj_stores", session: "stores", store: "store_old", requests: 1 });
	put(appHome, { hour: utc(5, 1, 12), project: "prj_stores", session: "stores", store: "store_new", requests: 2 });
	put(appHome, {
		hour: utc(5, 1, 13),
		project: "prj_stores",
		session: "stores",
		store: "store_new",
		thread: "thr_second",
		requests: 4,
	});
	prompt(appHome, { hour: utc(3, 9, 19), project: "prj_india", session: "india", thread: "thr_india" });

	const india = { projectId: "prj_india" };
	const kolkata = { ...india, zone: "Asia/Kolkata" };
	const la = { projectId: "prj_la", zone: "America/Los_Angeles" };
	const fall = { projectId: "prj_fall", zone: "America/Los_Angeles" };
	const spring = { projectId: "prj_spring", zone: "America/Los_Angeles" };
	const span = (scope: Scope, since: string, until = since) => read(desk, { ...scope, since, until });
	const results = {
		kolkata: {
			both: days(await span(kolkata, "2026-03-09", "2026-03-10")),
			first: days(await span(kolkata, "2026-03-09")),
			second: days(await span(kolkata, "2026-03-10")),
			tallies: (await span(kolkata, "2026-03-10")).tallies,
			hoursFirst: hourly(await hoursOf(desk, { ...kolkata, day: "2026-03-09" })),
			hoursSecond: hourly(await hoursOf(desk, { ...kolkata, day: "2026-03-10" })),
		},
		kathmandu: {
			both: days(await span({ ...india, zone: "Asia/Kathmandu" }, "2026-03-09", "2026-03-10")),
			hours: hourly(await hoursOf(desk, { ...india, zone: "Asia/Kathmandu", day: "2026-03-10" })),
		},
		utc: days(await span({ ...india, zone: "UTC" }, "2026-03-09", "2026-03-10")),
		losAngeles: {
			both: days(await span(la, "2026-03-09", "2026-03-10")),
			second: days(await span(la, "2026-03-10")),
			hoursFirst: hourly(await hoursOf(desk, { ...la, day: "2026-03-09" })),
			hoursSecond: hourly(await hoursOf(desk, { ...la, day: "2026-03-10" })),
		},
		fallBack: {
			days: days(await span(fall, "2026-10-31", "2026-11-02")),
			hours: hourly(await hoursOf(desk, { ...fall, day: "2026-11-01" })),
		},
		springForward: {
			days: days(await span(spring, "2026-03-07", "2026-03-09")),
			hours: hourly(await hoursOf(desk, { ...spring, day: "2026-03-08" })),
		},
		stores: await span({ projectId: "prj_stores", zone: "UTC" }, "2026-05-01"),
	};

	expect(results.kolkata).toMatchObject({
		both: { "2026-03-09": 1, "2026-03-10": 2 },
		first: { "2026-03-09": 1 },
		second: { "2026-03-10": 2 },
		hoursFirst: [[23, 1]],
		hoursSecond: [[0, 2]],
	});
	expect(results.kolkata.tallies.map((tally) => [tally.day, tally.kind, tally.count])).toEqual([
		["2026-03-10", "prompt", 1],
	]);
	expect(results.kathmandu).toEqual({ both: { "2026-03-09": 1, "2026-03-10": 2 }, hours: [[0, 2]] });
	expect(results.utc).toEqual({ "2026-03-09": 3 });
	expect(results.losAngeles).toEqual({
		both: { "2026-03-09": 1, "2026-03-10": 2 },
		second: { "2026-03-10": 2 },
		hoursFirst: [[23, 1]],
		hoursSecond: [[0, 2]],
	});
	// 27 UTC hours: one on each neighbour, and all 25 of the long day, whose 1 AM came twice.
	expect(results.fallBack.days).toEqual({ "2026-10-31": 1, "2026-11-01": 25, "2026-11-02": 1 });
	expect(results.fallBack.hours).toEqual(Array.from({ length: 24 }, (_, hour) => [hour, hour === 1 ? 2 : 1]));
	// 25 UTC hours: one on each neighbour, and the short day's 23, with no 2 AM.
	expect(results.springForward.days).toEqual({ "2026-03-07": 1, "2026-03-08": 23, "2026-03-09": 1 });
	expect(results.springForward.hours).toEqual(
		Array.from({ length: 24 }, (_, hour) => hour)
			.filter((hour) => hour !== 2)
			.map((hour) => [hour, 1]),
	);
	expect(results.stores.rows).toHaveLength(1);
	expect(results.stores.rows[0]).toMatchObject({ requests: 7, timed: 7, tokens: { input: 70 } });
	expect(results.stores.rows[0]!.durations[1]).toBe(7);
	expect(results.stores.threads).toEqual([{ day: "2026-05-01", machineId: "local", sessionId: "stores", threads: 2 }]);
	expect(results.stores.sessions).toEqual([
		{ id: "stores", machineId: "local", projectId: "prj_stores", title: null, deleted: true },
	]);
	expect(results.stores.projects).toEqual([{ id: "prj_stores", name: null }]);
	expect(results.stores.machines).toEqual([{ id: "local", name: "This Machine" }]);

	// Bad input is refused with the reason.
	const refused = async <E extends { readonly _tag: string; readonly message: string }>(
		effect: (rpc: AppRpc) => Effect.Effect<unknown, E>,
	) => {
		const error = await desk.run((rpc) => effect(rpc).pipe(Effect.flip));
		return { tag: error._tag, message: error.message };
	};
	const refusals = {
		zone: await refused((rpc) =>
			rpc["metrics.usage"]({ zone: "Mars/Olympus", since: "2026-03-09", until: "2026-03-09" }),
		),
		backwards: await refused((rpc) =>
			rpc["metrics.usage"]({ zone: "UTC", since: "2026-03-10", until: "2026-03-09" }),
		),
		malformed: await refused((rpc) => rpc["metrics.usage"]({ zone: "UTC", since: "2026-3-9", until: "2026-03-09" })),
		impossible: await refused((rpc) => rpc["metrics.hours"]({ zone: "UTC", day: "2026-02-30" })),
		hoursZone: await refused((rpc) => rpc["metrics.hours"]({ zone: "", day: "2026-03-09" })),
	};
	expect(Object.values(refusals).map((refusal) => refusal.tag)).toEqual(Array(5).fill("Server.MetricsError"));

	await snapshot("zones", { ...results, refusals });
}, 60_000);

it("filters by machine and by project; without a filter every machine and project is summed", async () => {
	const homeA = tempDir("metrics-filter-a");
	const homeB = tempDir("metrics-filter-b");
	const appHome = tempDir("metrics-filter-app");
	const serverA = await codework(homeA, await freePort(), { host: "Host A" });
	const serverB = await codework(homeB, await freePort(), { host: "Host B" });
	const desk = await app(appHome);
	const idA = await addServer(appHome, serverA, desk);
	const idB = await addServer(appHome, serverB, desk);
	await session(serverA, join(homeA, "alpha"), "Alpha", "echo alpha");
	await session(serverA, join(homeA, "beta"), "Beta", "echo beta");
	await session(serverB, join(homeB, "gamma"), "Gamma", "echo gamma");
	await rolled(appHome, idA, serverA);
	await rolled(appHome, idB, serverB);

	const projectId = (name: string) => query(appHome, "SELECT id FROM project WHERE name = ?", name)[0]!.id as string;
	const all = await read(desk, everything);
	const onA = await read(desk, { ...everything, machineId: idA });
	const onB = await read(desk, { ...everything, machineId: idB });
	const alpha = await read(desk, { ...everything, projectId: projectId("Alpha") });
	const alphaOnB = await read(desk, { ...everything, machineId: idB, projectId: projectId("Alpha") });
	const hoursA = await hoursOf(desk, { zone: "UTC", day: "1970-01-01", machineId: idA });

	expect(new Set(onA.rows.map((row) => row.machineId))).toEqual(new Set([idA]));
	expect(new Set(onB.rows.map((row) => row.machineId))).toEqual(new Set([idB]));
	expect(sum(all.rows).requests).toBe(6);
	expect(sum(onA.rows).requests + sum(onB.rows).requests).toBe(sum(all.rows).requests);
	expect(counts(onA)).toEqual({ "prompt:": 2, "tool:bash": 2 });
	expect(all.machines.map((machine) => machine.name).toSorted()).toEqual(["Host A", "Host B"]);
	expect(named(all).projects.map((project) => project.name)).toEqual(["Alpha", "Beta", "Gamma"]);
	expect(named(onA).projects.map((project) => project.name)).toEqual(["Alpha", "Beta"]);
	expect(alpha.projects.map((project) => project.name)).toEqual(["Alpha"]);
	expect(alpha.sessions).toHaveLength(1);
	expect(sum(alpha.rows).requests).toBe(2);
	expect(alphaOnB).toEqual({
		rows: [],
		tallies: [],
		threads: [],
		sessions: [],
		projects: [],
		machines: [],
		edges: [...edges],
	});
	expect(new Set(hoursA.map((row) => row.machineId))).toEqual(new Set([idA]));
	expect(hoursA.reduce((all, row) => all + row.requests, 0)).toBe(4);

	await snapshot(
		"filters",
		normalizer(
			[homeA, homeB, appHome],
			[...projectLabels(appHome), [today, "<today>"]],
		)({
			// Machine ids are random, and rows go by them: each machine's read is kept under its name.
			"Host A": named(onA),
			"Host B": named(onB),
			all: { rows: all.rows.length, machines: all.machines.length, projects: named(all).projects },
			alpha: { sessions: alpha.sessions, projects: alpha.projects },
			hoursA,
		}),
	);
}, 120_000);

it("a machine's old and new stores read as one machine", async () => {
	const cwHome = tempDir("metrics-store-cw");
	const appHome = tempDir("metrics-store-app");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const desk = await app(appHome);
	const machineId = await addServer(appHome, server, desk);
	await session(server, join(cwHome, "old"), "Old", "echo old");
	const old = await rolled(appHome, machineId, server);

	await stop(server.proc, "SIGTERM");
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	server = await codework(cwHome, port);
	await session(server, join(cwHome, "new"), "New", "echo new");
	const fresh = await rolled(appHome, machineId, server);
	expect(fresh.storeId).not.toBe(old.storeId);
	expect(query(appHome, "SELECT DISTINCT store_id FROM usage")).toHaveLength(2);

	const metrics = await read(desk, everything);
	expect(metrics.machines).toEqual([{ id: machineId, name: "Fixture" }]);
	expect(new Set(metrics.rows.map((row) => row.machineId))).toEqual(new Set([machineId]));
	expect(metrics.sessions).toHaveLength(2);
	expect(sum(metrics.rows).requests).toBe(4);
	expect(counts(metrics)).toEqual({ "prompt:": 2, "tool:bash": 2 });

	await snapshot(
		"stores",
		normalizer(
			[cwHome, appHome],
			[...projectLabels(appHome), [today, "<today>"], [old.storeId, "<old store>"], [fresh.storeId, "<new store>"]],
		)(named(metrics)),
	);
}, 120_000);
