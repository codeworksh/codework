import { Effect, Stream } from "effect";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract, type Dashboard, type DashboardBy } from "@codeworksh/contract";
import {
	addMachine,
	app,
	type AppRpc,
	cleanup,
	codework,
	freePort,
	normalizer,
	type Row,
	query,
	snapshot as match,
	synced,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const snapshot = (name: string, artifact: unknown) => match(`dashboard.${name}`, artifact);

const read = (rpc: AppRpc, by: DashboardBy) =>
	rpc["dashboard.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, by });

/** Each list as its key and its threads' names, in the order read: what the dashboard draws. */
const names = (dashboard: Dashboard, label: (id: string) => string) =>
	dashboard.lists.map((list) => ({
		list: list._tag === "Status" ? list.status : list._tag === "Priority" ? list.priority : list.groupingId,
		names: list.threads.map((thread) => label(thread.id)),
	}));

/** Times as `<time>`: the shared normalizer only knows snake_case ones. */
const elide = (dashboard: Dashboard) => ({
	...dashboard,
	lists: dashboard.lists.map((list) => ({
		...list,
		threads: list.threads.map((thread) => ({ ...thread, updatedAt: "<time>" })),
	})),
});

/**
 * A CodeWork server with four answered sessions A to D (each new thread goes first: D, C, B, A)
 * and a fork of A's main thread, synced into a fresh app server.
 */
const setup = async (name: string) => {
	const cwHome = tempDir(`${name}-cw`);
	const appHome = tempDir(`${name}-app`);
	const server = await codework(cwHome, await freePort());
	const threads = new Map<string, string>();
	const sessions = new Map<string, string>();
	const answered = (label: string) =>
		server.run((rpc) =>
			Effect.gen(function* () {
				const created = yield* rpc["session.create"]({ directory: cwHome, project: { name: "Board" } });
				yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: `Thread ${label}` });
				yield* rpc["thread.wait"]({ sessionId: created.session.id });
				threads.set(label, created.id);
				sessions.set(label, created.session.id);
				return created;
			}),
		);
	const a = await answered("A");
	for (const label of ["B", "C", "D"]) await answered(label);
	const fork = await server.run((rpc) =>
		Effect.gen(function* () {
			const sessionId = a.session.id;
			const entry = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1)!;
			return (yield* rpc["thread.fork"]({ sessionId, entryId: entry.id })).thread;
		}),
	);
	threads.set("A fork", fork.id);
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const { storeId } = await synced(appHome, machineId, server);
	const labels = new Map([...threads].map(([label, id]): [string, string] => [id, label]));
	const label = (id: string) => labels.get(id) ?? id;
	const fixed: Array<readonly [string, string]> = [
		[storeId, "<store>"],
		...[...threads].map(([name, id]) => [id, `<thread ${name}>`] as const),
		...[...sessions].map(([name, id]) => [id, `<session ${name}>`] as const),
	];
	return { cwHome, appHome, server, desk, threads, sessions, label, fixed };
};

it("by status: every status list in its order, each list's threads in ordering", async () => {
	const { cwHome, appHome, desk, threads, label, fixed } = await setup("status");
	const id = (name: string) => threads.get(name)!;
	await desk.run((rpc) =>
		Effect.gen(function* () {
			// Seen after their runs, every thread starts settled.
			yield* rpc["threads.setStatus"]({ threadId: id("A"), status: "attention" });
			yield* rpc["threads.setStatus"]({ threadId: id("D"), status: "attention" });
			yield* rpc["threads.setStatus"]({ threadId: id("C"), status: "cancelled" });
			yield* rpc["threads.setStatus"]({ threadId: id("A fork"), status: "working" });
			// D after A in the whole order, so the attention list reads A, D.
			yield* rpc["threads.move"]({ threadId: id("D"), to: "last" });
		}),
	);
	const dashboard = await desk.run((rpc) => read(rpc, "status"));
	expect(names(dashboard, label)).toEqual([
		{ list: "working", names: ["A fork"] },
		{ list: "attention", names: ["A", "D"] },
		{ list: "settled", names: ["B"] },
		{ list: "cancelled", names: ["C"] },
	]);
	// The fork has no title of its own yet: its source's.
	const fork = dashboard.lists[0]!.threads[0]!;
	expect([fork.title, fork.originKind]).toEqual(["Thread A", "fork"]);
	await snapshot("status", normalizer([cwHome, appHome], fixed)(elide(dashboard)));
}, 90_000);

it("by priority: urgent first and none last, each list in ordering", async () => {
	const { cwHome, appHome, desk, threads, label, fixed } = await setup("priority");
	const id = (name: string) => threads.get(name)!;
	await desk.run((rpc) =>
		Effect.gen(function* () {
			yield* rpc["threads.setPriority"]({ threadId: id("A"), priority: 4 });
			yield* rpc["threads.setPriority"]({ threadId: id("B"), priority: 1 });
			yield* rpc["threads.setPriority"]({ threadId: id("C"), priority: 1 });
			yield* rpc["threads.setPriority"]({ threadId: id("D"), priority: 3 });
		}),
	);
	const dashboard = await desk.run((rpc) => read(rpc, "priority"));
	expect(names(dashboard, label)).toEqual([
		{ list: 1, names: ["C", "B"] },
		{ list: 2, names: [] },
		{ list: 3, names: ["D"] },
		{ list: 4, names: ["A"] },
		{ list: 0, names: ["A fork"] },
	]);
	await snapshot("priority", normalizer([cwHome, appHome], fixed)(elide(dashboard)));
}, 90_000);

it("by grouping: groups in their ordering, ungrouped last, and a thread's color falls back to its session's", async () => {
	const { cwHome, appHome, desk, threads, sessions, label, fixed } = await setup("grouping");
	const id = (name: string) => threads.get(name)!;
	const { first, second } = await desk.run((rpc) =>
		Effect.gen(function* () {
			const first = yield* rpc["groups.create"]({ organizationId: "personal", name: "First", color: "#112233" });
			const second = yield* rpc["groups.create"]({ organizationId: "personal", name: "Second" });
			// Created last, then moved first: the read follows the groups' ordering, not their creation.
			yield* rpc["groups.move"]({ groupingId: second.id, to: "first" });
			yield* rpc["threads.setGroup"]({ threadId: id("A"), groupingId: first.id });
			yield* rpc["threads.setGroup"]({ threadId: id("C"), groupingId: first.id });
			yield* rpc["threads.setGroup"]({ threadId: id("B"), groupingId: second.id });
			yield* rpc["sessions.setColor"]({ sessionId: sessions.get("A")!, color: "#aa0000" });
			yield* rpc["sessions.setColor"]({ sessionId: sessions.get("B")!, color: "#00bb00" });
			yield* rpc["threads.setColor"]({ threadId: id("B"), color: "#0000cc" });
			return { first, second };
		}),
	);
	const dashboard = await desk.run((rpc) => read(rpc, "grouping"));
	const groupLabels = new Map([
		[first.id, "First"],
		[second.id, "Second"],
	]);
	expect(
		names(dashboard, label).map(({ list, names }) => ({ list: groupLabels.get(list as string) ?? list, names })),
	).toEqual([
		{ list: "Second", names: ["B"] },
		{ list: "First", names: ["C", "A"] },
		{ list: null, names: ["A fork", "D"] },
	]);
	const colors = Object.fromEntries(
		dashboard.lists.flatMap((list) => list.threads.map((thread) => [label(thread.id), thread.color])),
	);
	// A takes its session's, B its own over its session's, A's fork its session's (A's), the rest none.
	expect(colors).toEqual({ A: "#aa0000", B: "#0000cc", C: null, D: null, "A fork": "#aa0000" });
	await snapshot(
		"grouping",
		normalizer(
			[cwHome, appHome],
			[...fixed, [first.id, "<group First>"], [second.id, "<group Second>"]],
		)(elide(dashboard)),
	);
}, 90_000);

it("subagent threads stay off the dashboard", async () => {
	const { cwHome, appHome, desk, threads, label, fixed } = await setup("subagent");
	// CodeWork does not start subagents yet, so the row is written as the sync would copy one: A's
	// fork turned into a subagent of A's main thread, first in the whole order.
	const columns = query(appHome, "SELECT name FROM pragma_table_info('thread')").map((row) => row.name as string);
	const set: Record<string, string> = {
		id: "'thr_subagent'",
		origin_kind: "'subagent'",
		origin_call_id: "'call_subagent'",
		ordering: "ordering - 100",
	};
	write(
		appHome,
		`INSERT INTO thread (${columns.join(", ")}) SELECT ${columns.map((name) => set[name] ?? name).join(", ")}
		 FROM thread WHERE id = ?`,
		threads.get("A fork")!,
	);
	expect(query(appHome, "SELECT origin_kind FROM thread WHERE id = 'thr_subagent'")).toEqual([
		{ origin_kind: "subagent" },
	]);
	const dashboard = await desk.run((rpc) => read(rpc, "status"));
	expect(names(dashboard, label)).toEqual([
		{ list: "working", names: [] },
		{ list: "attention", names: [] },
		{ list: "settled", names: ["A fork", "D", "C", "B", "A"] },
		{ list: "cancelled", names: [] },
	]);
	await snapshot("subagent", normalizer([cwHome, appHome], fixed)(elide(dashboard)));
}, 90_000);

it("the dashboard's topics fire after a move, a status set and a group change, and the read after shows each", async () => {
	const { cwHome, appHome, desk, threads, label, fixed } = await setup("topics");
	const id = (name: string) => threads.get(name)!;
	const events: Array<{ topic: string; payload: Row }> = [];
	let subscribed = false;
	const window = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics: Contract.readTopics.dashboard }).pipe(
			Stream.runForEach((item) =>
				Effect.sync(() => {
					if ("_tag" in item) subscribed = true;
					else events.push({ topic: item.topic, payload: item.payload as Row });
				}),
			),
		),
	);
	await waitFor(() => (subscribed ? true : undefined), "the dashboard's subscription");

	const steps: Array<Row> = [];
	/** Runs one change, waits for the event it fires, then reads the dashboard as a client would. */
	const change = async (step: string, by: DashboardBy, call: Parameters<typeof desk.run>[0]) => {
		const seen = events.length;
		await desk.run(call);
		const fired = await waitFor(() => events[seen], `the event of ${step}`);
		steps.push({
			step,
			topic: fired.topic,
			payload: fired.payload,
			after: names(await desk.run((rpc) => read(rpc, by)), label),
		});
	};

	// A fork, D, C, B, A in the whole order: A goes between D and C.
	await change("move A between D and C", "status", (rpc) =>
		rpc["threads.move"]({ threadId: id("A"), to: { after: id("D"), before: id("C") } }),
	);
	await change("set B attention", "status", (rpc) =>
		rpc["threads.setStatus"]({ threadId: id("B"), status: "attention" }),
	);
	const group = await desk.run((rpc) => rpc["groups.create"]({ organizationId: "personal", name: "Next" }));
	await change("put C in a group", "grouping", (rpc) =>
		rpc["threads.setGroup"]({ threadId: id("C"), groupingId: group.id }),
	);
	await change("rename the group", "grouping", (rpc) => rpc["groups.update"]({ groupingId: group.id, name: "Later" }));
	await change("delete the group", "grouping", (rpc) => rpc["groups.delete"]({ groupingId: group.id }));
	window.stop();

	expect(steps.map((step) => step.topic)).toEqual([
		Contract.syncTopics.tracking,
		Contract.syncTopics.status,
		Contract.syncTopics.tracking,
		Contract.syncTopics.tracking,
		Contract.syncTopics.tracking,
	]);
	expect(steps[0]!.after).toEqual([
		{ list: "working", names: [] },
		{ list: "attention", names: [] },
		{ list: "settled", names: ["A fork", "D", "A", "C", "B"] },
		{ list: "cancelled", names: [] },
	]);
	await snapshot("topics", normalizer([cwHome, appHome], [...fixed, [group.id, "<group>"]])({ steps }));
}, 90_000);
