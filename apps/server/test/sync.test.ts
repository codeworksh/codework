/* @effect-diagnostics nodeBuiltinImport:off -- the suite stops, copies and removes CodeWork stores in temp dirs. */
import { Effect, Stream } from "effect";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract } from "@codeworksh/contract";
import {
	addMachine,
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
	stop,
	synced,
	tempDir,
	waitFor,
	write,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const tables = {
	machine: "SELECT id, kind, store_id, cursor FROM machine ORDER BY pos",
	project: "SELECT * FROM project ORDER BY created_at, id",
	space: "SELECT * FROM space ORDER BY created_at, id",
	session: "SELECT * FROM session ORDER BY created_at, id",
	thread: "SELECT * FROM thread ORDER BY created_seq, created_at, id",
	entry: "SELECT * FROM entry ORDER BY seq",
	part: `SELECT part.entry_id, part.part_index, part.type, part.status, json_extract(part.data, '$.text') AS text
		FROM part JOIN entry ON entry.id = part.entry_id ORDER BY entry.seq, part.part_index`,
	inbox: "SELECT * FROM inbox ORDER BY admitted_seq",
};
type Table = keyof typeof tables;
const dump = (home: string, ...names: ReadonlyArray<Table>) =>
	Object.fromEntries(names.map((name) => [name, query(home, tables[name])]));

const snapshot = (name: string, artifact: unknown) => match(`sync.${name}`, artifact);

/** A session in `home` with one prompt answered, as the CodeWork client sees it. */
const session = (server: Codework, directory: string, text: string, project?: string) =>
	server.run((rpc) =>
		Effect.gen(function* () {
			const created = yield* rpc["session.create"]({
				directory,
				...(project === undefined ? {} : { project: { name: project } }),
			});
			yield* rpc["thread.prompt"]({ sessionId: created.session.id, text });
			yield* rpc["thread.wait"]({ sessionId: created.session.id });
			return created;
		}),
	);

it("first sync copies a session with a fork and a prompt, with first-seen desktop values", async () => {
	const cwHome = tempDir("first-cw");
	const appHome = tempDir("first-app");
	const server = await codework(cwHome, await freePort());
	const created = await session(server, cwHome, "First prompt", "Alpha");
	const sessionId = created.session.id;
	const fork = await server.run((rpc) =>
		Effect.gen(function* () {
			const reply = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1)!;
			const forked = yield* rpc["thread.fork"]({ sessionId, entryId: reply.id });
			yield* rpc["thread.prompt"]({ sessionId, threadId: forked.thread.id, text: "Fork prompt" });
			yield* rpc["thread.wait"]({ sessionId, threadId: forked.thread.id });
			return forked.thread;
		}),
	);

	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const { storeId, rev } = await synced(appHome, machineId, server);
	const threads = await server.run((rpc) => rpc["thread.list"]({ sessionId }));

	const rows = dump(appHome, "machine", "project", "space", "session", "thread");
	const remote = rows.machine!.find((row) => row.id === machineId)!;
	expect(remote).toMatchObject({ kind: "remote", store_id: storeId, cursor: rev });
	const [stored] = rows.session!;
	expect(stored).toMatchObject({
		id: sessionId,
		machine_id: machineId,
		organization_id: "personal",
		space_id: created.session.spaceId,
		slug: created.session.slug,
		dir: created.session.directory,
		created_at: created.session.createdAt,
		deleted_at: null,
	});
	expect(rows.thread).toHaveLength(threads.length);
	for (const thread of threads) {
		const row = rows.thread!.find((candidate) => candidate.id === thread.id)!;
		expect(row).toMatchObject({
			session_id: sessionId,
			organization_id: "personal",
			origin_kind: thread.origin.kind,
			origin_thread_id: thread.origin.kind === "main" ? null : thread.origin.threadId,
			origin_committed_seq: thread.origin.kind === "main" ? null : (thread.origin.cut ?? null),
			title: thread.title ?? null,
			run_state: thread.runState,
			run_started_at: thread.lastRun?.startedAt ?? null,
			run_ended_at: thread.lastRun?.endedAt ?? null,
			run_outcome: thread.lastRun?.outcome ?? null,
			created_seq: thread.createdSeq,
			created_at: thread.createdAt,
			updated_at: thread.updatedAt,
			tokens_input: thread.usage.input,
			status: "settled",
			priority: 0,
			cursor: null,
		});
	}
	// Each new thread goes first in its organization.
	expect(rows.thread!.map((row) => row.ordering)).toEqual([0, -1]);
	expect(rows.thread!.find((row) => row.id === fork.id)?.origin_kind).toBe("fork");

	await snapshot("first", normalizer([cwHome, appHome], [[storeId, "<store>"]])(rows));
}, 90_000);

it("a restart of CodeWork and the app resumes from the cursor with only the rows changed since", async () => {
	const cwHome = tempDir("resume-cw");
	const appHome = tempDir("resume-app");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const created = await session(server, cwHome, "First prompt");
	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const before = machineRow(appHome, machineId);

	await stop(desk.proc);
	await stop(server.proc);
	server = await codework(cwHome, port);
	await server.run((rpc) =>
		Effect.gen(function* () {
			yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: "Second prompt" });
			yield* rpc["thread.wait"]({ sessionId: created.session.id });
		}),
	);
	// What a resume from the app's cursor carries, read from CodeWork itself.
	const expected = await server.run((rpc) =>
		rpc["index.sync"]({ after: before.cursor }).pipe(
			Stream.takeUntil((item) => item._tag === "Synced"),
			Stream.runCollect,
		),
	);
	const restartedAt = lastSeq(appHome);
	desk = await app(appHome);
	const after = await synced(appHome, machineId, server);
	const changed = notices(appHome, Contract.syncTopics.changed, restartedAt);

	const items = expected.filter((item) => item._tag !== "Synced");
	expect(after.storeId).toBe(before.store_id);
	expect(changed).toHaveLength(1);
	expect(changed[0]).toMatchObject({ machineId, full: false, items: items.length });
	expect(items.length).toBeGreaterThan(0);
	expect(items.every((item) => item.rev > before.cursor)).toBe(true);

	await snapshot(
		"resume",
		normalizer(
			[cwHome, appHome],
			[[after.storeId, "<store>"]],
		)({
			cursors: [{ rev: before.cursor }, { rev: machineRow(appHome, machineId).cursor }],
			resumed: { items: items.length, tags: items.map((item) => item._tag) },
			changed: changed,
			thread: dump(appHome, "thread").thread,
		}),
	);
}, 90_000);

it("a session deleted while the app was down is soft-deleted with its detail kept", async () => {
	const cwHome = tempDir("removed-cw");
	const appHome = tempDir("removed-app");
	const server = await codework(cwHome, await freePort());
	const kept = await session(server, cwHome, "Kept prompt");
	const doomed = await session(server, cwHome, "Doomed prompt");
	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	await desk.run((rpc) => rpc["sync.open"]({ sessionId: doomed.session.id, threadId: doomed.id }));
	await stop(desk.proc);

	await server.run((rpc) => rpc["session.delete"]({ sessionId: doomed.session.id }));
	const restartedAt = lastSeq(appHome);
	desk = await app(appHome);
	const { storeId } = await synced(appHome, machineId, server);

	const rows = dump(appHome, "session", "thread", "entry");
	const doomedRow = rows.session!.find((row) => row.id === doomed.session.id)!;
	expect(doomedRow.deleted_at).not.toBeNull();
	expect(rows.session!.find((row) => row.id === kept.session.id)?.deleted_at).toBeNull();
	expect(rows.thread!.find((row) => row.id === doomed.id)?.deleted_at).not.toBeNull();
	expect(rows.entry!.filter((row) => row.thread_id === doomed.id)).toHaveLength(2);
	const changed = notices(appHome, Contract.syncTopics.changed, restartedAt);
	expect(changed.at(-1)).toMatchObject({ removed: [doomed.session.id] });

	await snapshot(
		"removed",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)({
			changed: changed,
			...rows,
		}),
	);
}, 90_000);

it("an opened thread keeps its detail: first page with a floor, resume after close, older pages below the floor", async () => {
	const cwHome = tempDir("detail-cw");
	const appHome = tempDir("detail-app");
	const server = await codework(cwHome, await freePort());
	// Two large prompts: the first page, about 1 MiB, leaves the oldest out.
	const big = (tag: string) => `${tag}\n${"x".repeat(300_000)}`;
	const created = await session(server, cwHome, big("First"));
	const sessionId = created.session.id;
	const threadId = created.id;
	await server.run((rpc) =>
		Effect.gen(function* () {
			for (const text of [big("Second"), "Third prompt"]) {
				yield* rpc["thread.prompt"]({ sessionId, text });
				yield* rpc["thread.wait"]({ sessionId });
			}
		}),
	);
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const ref = { sessionId, threadId };
	const threadRow = () =>
		query(appHome, "SELECT cursor, floor FROM thread WHERE id = ?", threadId)[0] as {
			cursor: number | null;
			floor: number | null;
		};
	const entryIds = () => query(appHome, "SELECT id FROM entry ORDER BY seq").map((row) => row.id as string);

	const openedAt = lastSeq(appHome);
	await desk.run((rpc) => rpc["sync.open"](ref));
	const opened = { thread: threadRow(), entries: entryIds() };
	const line = (await server.run((rpc) => rpc["thread.history"]({ sessionId }))).entries;
	// The newest entries within 1 MiB, the newest always: what CodeWork's first page holds.
	const within = (entries: typeof line) => {
		let total = 0;
		return entries.toReversed().filter((entry, index) => (total += entry.size) <= 1 << 20 || index === 0);
	};
	const firstPage = within(line).toReversed();
	expect(firstPage.length).toBeLessThan(line.length);
	expect(opened.thread.cursor).not.toBeNull();
	expect(opened.entries).toEqual(firstPage.map((entry) => entry.id));
	expect(opened.thread.floor).toBe(firstPage[0]?.seq);
	const first = notices(appHome, Contract.syncTopics.changed, openedAt).filter(
		(notice) => notice.threadId === threadId,
	);

	await desk.run((rpc) => rpc["sync.close"](ref));
	await server.run((rpc) =>
		Effect.gen(function* () {
			yield* rpc["thread.prompt"]({ sessionId, text: "While closed" });
			yield* rpc["thread.wait"]({ sessionId });
		}),
	);
	// Closed: the stream is off, so nothing of the new prompt arrives.
	await synced(appHome, machineId, server);
	expect(entryIds()).toEqual(opened.entries);
	const reopenedAt = lastSeq(appHome);
	await desk.run((rpc) => rpc["sync.open"](ref));
	const resumed = notices(appHome, Contract.syncTopics.changed, reopenedAt).filter(
		(notice) => notice.threadId === threadId,
	);
	const reopened = { thread: threadRow(), entries: entryIds() };
	expect(resumed).toHaveLength(1);
	expect(resumed[0]!.entry).toHaveLength(2);
	expect(reopened.entries).toEqual([...opened.entries, ...(resumed[0]!.entry as Array<string>)]);

	const pagedAt = lastSeq(appHome);
	const page = await desk.run((rpc) => rpc["sync.page"]({ ...ref, limit: 10 }));
	const paged = { thread: threadRow(), entries: entryIds() };
	const below = within(line.filter((entry) => entry.seq < firstPage[0]!.seq).slice(-10)).toReversed();
	expect(page).toEqual({ entries: below.length, floor: below[0]?.seq });
	expect(below[0]?.id).toBe(line[0]?.id);
	expect(paged.thread.floor).toBe(line[0]?.seq);
	expect(paged.entries.slice(0, below.length)).toEqual(below.map((entry) => entry.id));
	const pagedNotices = notices(appHome, Contract.syncTopics.changed, pagedAt);
	await desk.run((rpc) => rpc["sync.close"](ref));

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"detail",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)({
			opened: { ...opened, changed: first },
			reopened: { ...reopened, changed: resumed },
			paged: { ...paged, page, changed: pagedNotices },
			...dump(appHome, "entry", "part"),
		}),
	);
}, 120_000);

it("a follow-up queued behind a reply is a pending inbox row until it is promoted", async () => {
	const cwHome = tempDir("inbox-cw");
	const appHome = tempDir("inbox-app");
	const server = await codework(cwHome, await freePort());
	const created = await server.run((rpc) => rpc["session.create"]({ directory: cwHome }));
	const ref = { sessionId: created.session.id, threadId: created.id };
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	await desk.run((rpc) => rpc["sync.open"](ref));

	const queue = () => server.run((rpc) => rpc["thread.queue"](ref)).then((queued) => queued.entries);
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
	// The held reply has taken its own prompt, so the queue holds only the follow-up.
	await waitFor(async () => ((await queue()).length === 0 ? true : undefined), "the held reply");
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "Queued", delivery: "followUp" }));
	const [prompt] = await queue();
	expect(prompt).toBeDefined();
	const pending = await waitFor(
		() => query(appHome, "SELECT * FROM inbox WHERE id = ?", prompt!.id)[0],
		"the pending inbox row",
	);
	expect(pending).toEqual({
		id: prompt!.id,
		thread_id: ref.threadId,
		delivery: "followUp",
		text: "Queued",
		admitted_seq: prompt!.admittedSeq,
		created_at: prompt!.createdAt,
	});

	for (let step = 0; step < 4; step++) server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	const promoted = () => query(appHome, "SELECT id FROM entry WHERE id = ?", prompt!.id).length === 1;
	await waitFor(
		() => (query(appHome, tables.inbox).length === 0 && promoted() ? true : undefined),
		"the promoted follow-up",
	);

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"inbox",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)({
			pending: [pending],
			promoted: dump(appHome, "inbox", "entry"),
		}),
	);
}, 90_000);

it("a restored store is read again in full: returning rows keep their desktop columns, the rest are soft-deleted", async () => {
	const cwHome = tempDir("restored-cw");
	const appHome = tempDir("restored-app");
	const backup = tempDir("restored-backup");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const before = await session(server, cwHome, "Before backup");
	// A clean stop leaves the database whole in its main file.
	await stop(server.proc, "SIGTERM");
	copyFileSync(server.database, join(backup, "codework.db"));
	server = await codework(cwHome, port);

	let desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	write(appHome, "UPDATE thread SET priority = 2, color = '#ff8800', status = 'attention' WHERE id = ?", before.id);
	const after = await session(server, cwHome, "After backup");
	const { rev: head } = await synced(appHome, machineId, server);

	await stop(desk.proc);
	await stop(server.proc, "SIGTERM");
	copyFileSync(server.database, join(backup, "later.db"));
	for (const suffix of ["-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	copyFileSync(join(backup, "codework.db"), server.database);
	server = await codework(cwHome, port);
	const restored = await server.run((rpc) => rpc["server.info"]({}));
	expect(restored.rev).toBeLessThan(head);

	const restartedAt = lastSeq(appHome);
	desk = await app(appHome);
	await waitFor(() => {
		const row = machineRow(appHome, machineId);
		return row.cursor === restored.rev ? row : undefined;
	}, "the full sync of the restored store");
	const rows = dump(appHome, "machine", "session", "thread");
	const changed = notices(appHome, Contract.syncTopics.changed, restartedAt);
	expect(changed[0]).toMatchObject({ machineId, full: true, removed: [after.session.id] });
	expect(rows.thread!.find((row) => row.id === before.id)).toMatchObject({
		priority: 2,
		color: "#ff8800",
		status: "attention",
		deleted_at: null,
	});
	expect(rows.session!.find((row) => row.id === after.session.id)?.deleted_at).not.toBeNull();
	expect(rows.thread!.find((row) => row.id === after.id)?.deleted_at).not.toBeNull();

	// Restored again, to the later copy that has the soft-deleted session: past the cursor, so a resume brings it back.
	write(appHome, "UPDATE session SET color = '#0088ff' WHERE id = ?", after.session.id);
	write(appHome, "UPDATE thread SET priority = 3, color = '#0088ff' WHERE id = ?", after.id);
	await stop(desk.proc);
	await stop(server.proc, "SIGTERM");
	for (const suffix of ["-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	copyFileSync(join(backup, "later.db"), server.database);
	server = await codework(cwHome, port);
	const later = await server.run((rpc) => rpc["server.info"]({}));
	expect(later.storeId).toBe(restored.storeId);
	expect(later.rev).toBeGreaterThan(restored.rev);
	const againAt = lastSeq(appHome);
	desk = await app(appHome);
	await synced(appHome, machineId, server);
	const again = dump(appHome, "session", "thread");
	const changedAgain = notices(appHome, Contract.syncTopics.changed, againAt);
	expect(changedAgain.every((notice) => notice.full === false)).toBe(true);
	expect(again.session!.find((row) => row.id === after.session.id)).toMatchObject({
		color: "#0088ff",
		deleted_at: null,
	});
	expect(again.thread!.find((row) => row.id === after.id)).toMatchObject({
		priority: 3,
		color: "#0088ff",
		deleted_at: null,
	});

	await snapshot(
		"restored",
		normalizer(
			[cwHome, appHome],
			[[restored.storeId, "<store>"]],
		)({
			heads: [{ rev: head }, { rev: restored.rev }],
			changed: changed,
			...rows,
			again: { head: { rev: later.rev }, changed: changedAgain, ...again },
		}),
	);
}, 120_000);

it("a new store in the same home is read again in full", async () => {
	const cwHome = tempDir("store-cw");
	const appHome = tempDir("store-app");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const old = await session(server, cwHome, "Old store");
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const first = machineRow(appHome, machineId);

	// The app stays up: it reconnects to the new store on its own.
	await stop(server.proc, "SIGTERM");
	for (const suffix of ["", "-wal", "-shm"]) rmSync(`${server.database}${suffix}`, { force: true });
	server = await codework(cwHome, port);
	const fresh = await session(server, cwHome, "New store");
	const startedAt = lastSeq(appHome);
	const { storeId } = await synced(appHome, machineId, server);
	expect(existsSync(server.database)).toBe(true);
	expect(storeId).not.toBe(first.store_id);

	const rows = dump(appHome, "machine", "session", "thread");
	const changed = notices(appHome, Contract.syncTopics.changed, startedAt);
	expect(changed.find((notice) => notice.full === true)).toMatchObject({ removed: [old.session.id] });
	expect(rows.session!.find((row) => row.id === old.session.id)?.deleted_at).not.toBeNull();
	expect(rows.session!.find((row) => row.id === fresh.session.id)?.deleted_at).toBeNull();

	await snapshot(
		"store",
		normalizer(
			[cwHome, appHome],
			[
				[first.store_id!, "<old store>"],
				[storeId, "<new store>"],
			],
		)({ changed: changed, ...rows }),
	);
}, 120_000);

it("a live reply folds deltas that continue the draft, drops one that does not, and lands its checkpoint", async () => {
	const cwHome = tempDir("live-cw");
	const appHome = tempDir("live-app");
	const server = await codework(cwHome, await freePort());
	const created = await server.run((rpc) => rpc["session.create"]({ directory: cwHome }));
	const ref = { sessionId: created.session.id, threadId: created.id };
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	await desk.run((rpc) => rpc["sync.open"](ref));

	const forwarded: Array<Row> = [];
	let subscribed = false;
	const follower = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics: [Contract.syncTopics.delta(ref.threadId)] }).pipe(
			Stream.runForEach((item) =>
				Effect.sync(() => {
					if ("_tag" in item) subscribed = true;
					else forwarded.push(item.payload as Row);
				}),
			),
		),
	);
	await waitFor(() => (subscribed ? true : undefined), "the delta subscription");

	const draftText = () =>
		query(
			appHome,
			`SELECT entry.state, json_extract(part.data, '$.text') AS text FROM entry
			 JOIN part ON part.entry_id = entry.id WHERE entry.thread_id = ? AND entry.type = 'assistant'`,
			ref.threadId,
		)[0] as { state: string; text: string } | undefined;

	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
	await waitFor(() => (forwarded.length > 0 ? forwarded : undefined), "the first delta");
	// The checkpoint, at most a second later, holds the first chunk.
	await waitFor(() => (draftText()?.text === "Hello " ? true : undefined), "the first checkpoint");

	// Closed while "wor" streams, reopened before the next checkpoint: "ld" no longer continues the draft.
	await desk.run((rpc) => rpc["sync.close"](ref));
	server.release();
	await desk.run((rpc) => rpc["sync.open"](ref));
	server.release();
	await waitFor(() => (draftText()?.text === "Hello world" ? true : undefined), "the second checkpoint");
	server.release();
	await waitFor(() => (forwarded.length >= 2 ? true : undefined), "the delta after the checkpoint");
	// The reply ends only now, so the committed entry cannot overtake that delta.
	server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	const landed = await waitFor(
		() => (draftText()?.state === "committed" ? draftText() : undefined),
		"the committed reply",
	);
	follower.stop();

	expect(forwarded.map((delta) => [delta.offset, delta.delta])).toEqual([
		[0, "Hello "],
		[11, "!"],
	]);
	expect(landed).toEqual({ state: "committed", text: "Hello world!" });

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"live",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)({
			forwarded,
			...dump(appHome, "entry", "part"),
		}),
	);
}, 90_000);

it("thread status follows its runs: started, succeeded, user interrupt, crash sweep", async () => {
	const cwHome = tempDir("status-cw");
	const appHome = tempDir("status-app");
	const port = await freePort();
	let server = await codework(cwHome, port);
	const created = await server.run((rpc) => rpc["session.create"]({ directory: cwHome }));
	const ref = { sessionId: created.session.id, threadId: created.id };
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const status = () =>
		query(appHome, "SELECT status, run_outcome, run_error FROM thread WHERE id = ?", ref.threadId)[0]!;
	const reach = (value: string) =>
		waitFor(() => (status().status === value ? status() : undefined), value).catch((error: Error) => {
			throw new Error(`${error.message}; the thread is ${JSON.stringify(status())}`);
		});
	const steps: Array<Row> = [{ step: "first seen", ...status() }];

	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "hold" }));
	steps.push({ step: "run started", ...(await reach("working")) });
	await server.run((rpc) => rpc["thread.interrupt"](ref));
	steps.push({ step: "user interrupt", ...(await reach("cancelled")) });
	// Held after its first chunk, so its start and its end arrive as two rows.
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
	steps.push({ step: "run started again", ...(await reach("working")) });
	for (let step = 0; step < 4; step++) server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	steps.push({ step: "succeeded", ...(await reach("attention")) });

	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "hold" }));
	await reach("working");
	await synced(appHome, machineId, server);
	const run = () =>
		query(appHome, "SELECT run_state, run_started_at FROM thread WHERE id = ?", ref.threadId)[0] as {
			run_state: string;
			run_started_at: number;
		};
	const crashed = run();
	const crashedAt = lastSeq(appHome);
	await stop(server.proc);
	server = await codework(cwHome, port);
	// The sweep ends the run as crashed and recovery resumes it at once: the row arrives with the resumed run.
	await waitFor(() => {
		const now = run();
		return now.run_started_at !== crashed.run_started_at && now.run_state === "running" ? now : undefined;
	}, "the resumed run");
	steps.push({ step: "crash sweep and resume", ...status() });
	const sinceCrash = notices(appHome, Contract.syncTopics.status, crashedAt);
	expect(sinceCrash).toEqual([]);
	expect(status().status).toBe("working");

	const moves = notices(appHome, Contract.syncTopics.status);
	expect(moves.map((move) => [move.previous, move.status])).toEqual([
		["settled", "working"],
		["working", "cancelled"],
		["cancelled", "working"],
		["working", "attention"],
		["attention", "working"],
	]);
	await server.run((rpc) => rpc["thread.interrupt"](ref));

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"status",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)({
			steps,
			moves: moves,
		}),
	);
}, 120_000);
