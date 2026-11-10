import { Effect, Stream } from "effect";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import {
	addMachine,
	app,
	type AppRpc,
	cleanup,
	type Codework,
	codework,
	freePort,
	lastSeq,
	normalizer,
	query,
	type Row,
	snapshot as match,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const snapshot = (name: string, artifact: unknown) => match(`tracking.${name}`, artifact);
const TOPICS = [Contract.syncTopics.status, Contract.syncTopics.tracking];

/** The stored tracking and status events after `after`, as the bus holds them. */
const stored = (home: string, after = 0) =>
	query(
		home,
		"SELECT topic, source, payload FROM event WHERE topic IN (?, ?) AND seq > ? ORDER BY seq",
		...TOPICS,
		after,
	).map((row) => ({
		topic: row.topic as string,
		source: row.source as string,
		payload: JSON.parse(row.payload as string) as Row,
	}));

/** A CodeWork server with `count` new sessions, synced into a fresh app server. */
const setup = async (name: string, count: number) => {
	const cwHome = tempDir(`${name}-cw`);
	const appHome = tempDir(`${name}-app`);
	const server = await codework(cwHome, await freePort());
	const sessions = [];
	for (let index = 0; index < count; index++) {
		const created = await server.run((rpc) => rpc["session.create"]({ directory: cwHome }));
		sessions.push({ sessionId: created.session.id, threadId: created.id });
	}
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	return { cwHome, appHome, server, desk, machineId, sessions };
};

/** A second window: another connection following the tracking topics from now on. */
const follow = async (desk: Awaited<ReturnType<typeof app>>) => {
	const received: Array<Row> = [];
	let subscribed = false;
	const window = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics: TOPICS }).pipe(
			Stream.runForEach((item) =>
				Effect.sync(() => {
					if ("_tag" in item) subscribed = true;
					else received.push({ topic: item.topic, source: item.source, payload: item.payload as Row });
				}),
			),
		),
	);
	await waitFor(() => (subscribed ? true : undefined), "the second window's subscription");
	return { received, stop: window.stop };
};

const threadRow = (home: string, threadId: string) =>
	query(home, "SELECT status, priority, grouping_id, ordering, color FROM thread WHERE id = ?", threadId)[0]!;

it("every edit changes its row with its event in the same transaction, and a second window receives it", async () => {
	const { cwHome, appHome, desk, sessions } = await setup("edits", 1);
	const { sessionId, threadId } = sessions[0]!;
	const window = await follow(desk);
	const sessionColor = () => query(appHome, "SELECT color FROM session WHERE id = ?", sessionId)[0]!.color;
	const groups = () =>
		query(appHome, "SELECT id, organization_id, name, color, ordering FROM grouping ORDER BY ordering");

	const steps: Array<Row> = [];
	/** Runs one edit; once it returns, its row and exactly one event are there together. */
	const edit = async (step: string, call: Parameters<typeof desk.run>[0]) => {
		const before = lastSeq(appHome);
		await desk.run(call);
		const written = stored(appHome, before);
		expect(written).toHaveLength(1);
		steps.push({
			step,
			thread: threadRow(appHome, threadId),
			session: { color: sessionColor() },
			grouping: groups(),
			event: written[0],
		});
		return written[0]!;
	};

	await edit("status cancelled", (rpc) => rpc["threads.setStatus"]({ threadId, status: "cancelled" }));
	await edit("priority urgent", (rpc) => rpc["threads.setPriority"]({ threadId, priority: 1 }));
	await edit("thread color", (rpc) => rpc["threads.setColor"]({ threadId, color: "#ff8800" }));
	await edit("session color", (rpc) => rpc["sessions.setColor"]({ sessionId, color: "#00aaff" }));
	const created = await edit("group created", (rpc) =>
		rpc["groups.create"]({ organizationId: "personal", name: "Backlog", color: "#123456" }),
	);
	const groupingId = created.payload.id as string;
	await edit("group renamed and color cleared", (rpc) =>
		rpc["groups.update"]({ groupingId, name: "Next", color: null }),
	);
	await edit("thread grouped", (rpc) => rpc["threads.setGroup"]({ threadId, groupingId }));
	await edit("thread ungrouped", (rpc) => rpc["threads.setGroup"]({ threadId, groupingId: null }));
	await edit("thread color cleared", (rpc) => rpc["threads.setColor"]({ threadId, color: null }));
	await edit("session color cleared", (rpc) => rpc["sessions.setColor"]({ sessionId, color: null }));

	expect(threadRow(appHome, threadId)).toEqual({
		status: "cancelled",
		priority: 1,
		grouping_id: null,
		ordering: 0,
		color: null,
	});
	const all = stored(appHome);
	await waitFor(() => (window.received.length >= all.length ? true : undefined), "the second window's events");
	window.stop();
	expect(window.received).toEqual(all);

	// Refused edits: typed errors, and neither the row nor the bus changes.
	const beforeRejected = { seq: lastSeq(appHome), thread: threadRow(appHome, threadId) };
	const refuse = (
		call: (rpc: AppRpc) => Effect.Effect<unknown, { readonly _tag: string; readonly message: string }>,
	) => desk.run((rpc) => Effect.flip(call(rpc)).pipe(Effect.map(({ _tag, message }) => ({ _tag, message }))));
	const rejected = {
		"priority 5": await refuse((rpc) => rpc["threads.setPriority"]({ threadId, priority: 5 })),
		"priority -1": await refuse((rpc) => rpc["threads.setPriority"]({ threadId, priority: -1 })),
		"thread color orange": await refuse((rpc) => rpc["threads.setColor"]({ threadId, color: "orange" })),
		"session color #12345": await refuse((rpc) => rpc["sessions.setColor"]({ sessionId, color: "#12345" })),
		"group color #ggg000": await refuse((rpc) =>
			rpc["groups.create"]({ organizationId: "personal", name: "Bad", color: "#ggg000" }),
		),
		"missing thread": await refuse((rpc) => rpc["threads.setPriority"]({ threadId: "thr_missing", priority: 2 })),
		"missing group": await refuse((rpc) => rpc["threads.setGroup"]({ threadId, groupingId: "missing" })),
	};
	for (const error of Object.values(rejected)) expect(error._tag).toBe("Server.TrackingError");
	expect(lastSeq(appHome)).toBe(beforeRejected.seq);
	expect(threadRow(appHome, threadId)).toEqual(beforeRejected.thread);

	const normalize = normalizer(
		[cwHome, appHome],
		[
			[groupingId, "<group>"],
			[threadId, "<thread>"],
			[sessionId, "<session>"],
		],
	);
	await snapshot("edits", normalize({ steps, received: window.received }));
	await snapshot("rejected", normalize({ rejected, thread: threadRow(appHome, threadId) }));
}, 90_000);

it("a user-set status stays through rows without a run change and a run ending; the next run starting reopens it", async () => {
	const { cwHome, appHome, server, desk, sessions } = await setup("status", 1);
	const ref = sessions[0]!;
	const status = () => query(appHome, "SELECT status, thinking_level FROM thread WHERE id = ?", ref.threadId)[0]!;
	const reach = (value: string) => waitFor(() => (status().status === value ? status() : undefined), value);
	const runState = () => query(appHome, "SELECT run_state, run_ended_at FROM thread WHERE id = ?", ref.threadId)[0]!;
	/** A reply held after its first chunk, so its start and its end arrive as two rows. */
	const run = async (server: Codework) => {
		await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
		await reach("working");
		for (let step = 0; step < 4; step++) server.release();
		await server.run((rpc) => rpc["thread.wait"](ref));
		await waitFor(
			() => (runState().run_state === "idle" && runState().run_ended_at !== null ? true : undefined),
			"the run's end",
		);
		return status();
	};
	const steps: Array<Row> = [{ step: "first seen", ...status() }];

	// A run ending moves nothing: the thread stays working.
	steps.push({ step: "run succeeded", ...(await run(server)) });
	expect(status().status).toBe("working");
	await desk.run((rpc) => rpc["threads.setStatus"]({ threadId: ref.threadId, status: "settled" }));
	steps.push({ step: "user settled", ...status() });
	await server.run((rpc) => rpc["thread.configure"]({ ...ref, runtime: { thinkingLevel: "high" } }));
	const configured = await waitFor(
		() => (status().thinking_level === "high" ? status() : undefined),
		"the configured thread row",
	);
	expect(configured.status).toBe("settled");
	steps.push({ step: "row without a run change", ...configured });
	steps.push({ step: "next run succeeded", ...(await run(server)) });

	const moves = stored(appHome).map((event) => ({
		source: event.source,
		previous: event.payload.previous,
		status: event.payload.status,
	}));
	expect(moves).toEqual([
		{ source: "sync", previous: "enqueued", status: "working" },
		{ source: "tracking", previous: "working", status: "settled" },
		{ source: "sync", previous: "settled", status: "working" },
	]);
	await snapshot("status", normalizer([cwHome, appHome])({ steps, moves }));
}, 90_000);

it("moving a thread or a group first, between two, or last writes one row with the midpoint values", async () => {
	const { cwHome, appHome, desk, sessions } = await setup("ordering", 4);
	// Each new thread goes first: A 0, B -1, C -2, D -3.
	const names = new Map(sessions.map((ref, index): [string, string] => [ref.threadId, "ABCD"[index]!]));
	const ids = new Map([...names].map(([id, name]) => [name, id]));
	const list = (table: "thread" | "grouping", label: (id: string) => string) =>
		query(appHome, `SELECT id, ordering FROM ${table} ORDER BY ordering`).map((row) => ({
			name: label(row.id as string),
			ordering: row.ordering as number,
		}));

	const groupNames = new Map<string, string>();
	for (const name of ["G1", "G2", "G3"]) {
		const group = await desk.run((rpc) => rpc["groups.create"]({ organizationId: "personal", name }));
		groupNames.set(group.id, name);
	}
	const groupIds = new Map([...groupNames].map(([id, name]) => [name, id]));

	const moves: Array<Row> = [];
	const move = async (
		table: "thread" | "grouping",
		name: string,
		to: Contract.Position,
		call: Parameters<typeof desk.run>[0],
	) => {
		const label = (id: string) => (table === "thread" ? names : groupNames).get(id)!;
		const before = list(table, label);
		const seq = lastSeq(appHome);
		await desk.run(call);
		const after = list(table, label);
		const changed = after.filter((row) => before.find((prior) => prior.name === row.name)?.ordering !== row.ordering);
		expect(changed.map((row) => row.name)).toEqual([name]);
		expect(stored(appHome, seq)).toHaveLength(1);
		moves.push({ table, name, to, list: after, event: stored(appHome, seq)[0]!.payload });
	};
	const thread = (name: string, to: Contract.Position) =>
		move("thread", name, to, (rpc) => rpc["threads.move"]({ threadId: ids.get(name)!, to }));
	const group = (name: string, to: Contract.Position) =>
		move("grouping", name, to, (rpc) => rpc["groups.move"]({ groupingId: groupIds.get(name)!, to }));
	const between = (after: string, before: string, of: Map<string, string>) => ({
		after: of.get(after)!,
		before: of.get(before)!,
	});

	expect(list("thread", (id) => names.get(id)!).map((row) => row.ordering)).toEqual([-3, -2, -1, 0]);
	await thread("A", "first");
	await thread("B", between("A", "D", ids));
	await thread("D", "last");
	expect(list("thread", (id) => names.get(id)!)).toEqual([
		{ name: "A", ordering: -4 },
		{ name: "B", ordering: -3.5 },
		{ name: "C", ordering: -2 },
		{ name: "D", ordering: -1 },
	]);

	expect(list("grouping", (id) => groupNames.get(id)!).map((row) => row.ordering)).toEqual([0, 1, 2]);
	await group("G3", "first");
	await group("G2", between("G3", "G1", groupIds));
	await group("G3", "last");
	expect(list("grouping", (id) => groupNames.get(id)!)).toEqual([
		{ name: "G2", ordering: -0.5 },
		{ name: "G1", ordering: 0 },
		{ name: "G3", ordering: 1 },
	]);

	const labels = [...names, ...groupNames].map(([id, name]): [string, string] => [id, `<${name}>`]);
	await snapshot("ordering", normalizer([cwHome, appHome], labels)({ moves }));
}, 90_000);

it("deleting a group leaves its threads ungrouped and names them in its event", async () => {
	const { cwHome, appHome, desk, sessions } = await setup("delete", 3);
	const [a, b, c] = sessions.map((ref) => ref.threadId as string) as [string, string, string];
	const doomed = await desk.run((rpc) => rpc["groups.create"]({ organizationId: "personal", name: "Doomed" }));
	const kept = await desk.run((rpc) => rpc["groups.create"]({ organizationId: "personal", name: "Kept" }));
	for (const threadId of [a, b]) await desk.run((rpc) => rpc["threads.setGroup"]({ threadId, groupingId: doomed.id }));
	await desk.run((rpc) => rpc["threads.setGroup"]({ threadId: c, groupingId: kept.id }));

	const seq = lastSeq(appHome);
	await desk.run((rpc) => rpc["groups.delete"]({ groupingId: doomed.id }));
	const events = stored(appHome, seq);
	const threads = query(appHome, "SELECT id, grouping_id FROM thread ORDER BY created_seq");
	const groups = query(appHome, "SELECT id, name FROM grouping ORDER BY ordering");

	expect(events).toHaveLength(1);
	expect(events[0]!.payload).toEqual({ _tag: "GroupDeleted", groupingId: doomed.id, threads: [a, b] });
	expect(threads).toEqual([
		{ id: a, grouping_id: null },
		{ id: b, grouping_id: null },
		{ id: c, grouping_id: kept.id },
	]);
	expect(groups).toEqual([{ id: kept.id, name: "Kept" }]);

	const normalize = normalizer(
		[cwHome, appHome],
		[
			[a, "<thread A>"],
			[b, "<thread B>"],
			[c, "<thread C>"],
			[doomed.id, "<group Doomed>"],
			[kept.id, "<group Kept>"],
		],
	);
	await snapshot("delete", normalize({ events, threads, groups }));
}, 90_000);
