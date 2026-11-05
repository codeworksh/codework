/* @effect-diagnostics nodeBuiltinImport:off -- the suite registers CodeWork servers in temp homes. */
import { Effect, Stream } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { Contract, type ThreadLine } from "@codeworksh/contract";
import {
	addMachine,
	app,
	type AppRpc,
	cleanup,
	type Codework,
	codework,
	freePort,
	normalizer,
	query,
	type Row,
	snapshot as match,
	stop,
	synced,
	tempDir,
	waitFor,
} from "./fixtures/apps.ts";

afterEach(cleanup);

const snapshot = (name: string, artifact: unknown) => match(`reads.${name}`, artifact);

/** Times named in camelCase, which the shared normalizer leaves alone, elided before it runs. */
const elide = (value: unknown): unknown =>
	Array.isArray(value)
		? value.map(elide)
		: typeof value === "object" && value !== null
			? Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key,
						typeof item === "number" && (key === "updated" || /[a-z]At$/.test(key)) ? "<time>" : elide(item),
					]),
				)
			: value;

/** A page's entries with their parts' text cut short: the large prompts would swamp the artifact. */
const brief = (line: ThreadLine) => ({
	...line,
	entries: line.entries.map(({ parts, ...entry }) => ({
		...entry,
		parts: parts.map((part) => (part.type === "text" ? { type: "text", text: part.text.slice(0, 24) } : part)),
	})),
});

/** A session with one prompt answered, as the CodeWork client sees it. */
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

/** Registers `server` in `home` as its default local server would be, before the app starts. */
const registerLocal = (appHome: string, server: Codework, port: number) => {
	const cli = join(appHome, "cli");
	mkdirSync(cli, { recursive: true });
	writeFileSync(
		join(cli, "service.json"),
		JSON.stringify({ pid: server.proc.pid, version: "0.0.0", url: server.url, port }),
	);
};

const sidebar = (rpc: AppRpc, machines: "default" | "all" = "all") =>
	rpc["sidebar.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, machines });

/** Events on `topics` from the moment it resolves, collected until `stop`. */
const follow = async (desk: Awaited<ReturnType<typeof app>>, topics: ReadonlyArray<string>) => {
	const events: Array<{ topic: string; payload: Row }> = [];
	let subscribed = false;
	const background = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics }).pipe(
			Stream.runForEach((item) =>
				Effect.sync(() => {
					if ("_tag" in item) subscribed = true;
					else events.push({ topic: item.topic, payload: item.payload as Row });
				}),
			),
		),
	);
	await waitFor(() => (subscribed ? true : undefined), `a subscription to ${topics.join(", ")}`);
	return { events, stop: background.stop };
};

it("the sidebar reads app.db alone: a run started before the app shows running at launch, and stays while CodeWork is stopped", async () => {
	const cwHome = tempDir("sidebar-cw");
	const appHome = tempDir("sidebar-app");
	const server = await codework(cwHome, await freePort());
	const idle = await session(server, cwHome, "Idle prompt", "Alpha");
	const busy = await server.run((rpc) =>
		Effect.gen(function* () {
			const created = yield* rpc["session.create"]({ directory: cwHome, project: { name: "Alpha" } });
			yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: "hold" });
			return created;
		}),
	);
	await waitFor(
		async () =>
			(await server.run((rpc) => rpc["thread.info"]({ sessionId: busy.session.id }))).runState === "running"
				? true
				: undefined,
		"the held run",
	);

	// The app launches after the run started.
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const { storeId } = await synced(appHome, machineId, server);
	const launched = await desk.run((rpc) => sidebar(rpc));
	const [project] = launched;
	expect(launched).toHaveLength(1);
	expect(project!.machine).toEqual({ id: machineId, name: "Scripted" });
	expect(project!.sessions.map((row) => [row.id, row.threadId, row.runState, row.title])).toEqual([
		[busy.session.id, busy.id, "running", "hold"],
		[idle.session.id, idle.id, "idle", "Idle prompt"],
	]);

	await stop(server.proc);
	const stopped = await desk.run((rpc) => sidebar(rpc));
	expect(stopped).toEqual(launched);

	await snapshot(
		"sidebar",
		normalizer([cwHome, appHome], [[storeId, "<store>"]])(elide({ launched, stoppedEqualsLaunched: true })),
	);
}, 90_000);

it("the sidebar filters to the default machine or reads every machine, each project with its machine", async () => {
	const localHome = tempDir("machines-local");
	const remoteHome = tempDir("machines-remote");
	const appHome = tempDir("machines-app");
	const localPort = await freePort();
	const local = await codework(localHome, localPort);
	const remote = await codework(remoteHome, await freePort());
	await session(local, localHome, "On the default machine", "Local");
	await session(remote, remoteHome, "On a remote machine", "Remote");

	registerLocal(appHome, local, localPort);
	const desk = await app(appHome);
	const remoteId = await addMachine(appHome, remote, desk.run);
	const localStore = await synced(appHome, Contract.LOCAL_SERVER, local);
	const remoteStore = await synced(appHome, remoteId, remote);

	const onDefault = await desk.run((rpc) => sidebar(rpc, "default"));
	const everywhere = await desk.run((rpc) => sidebar(rpc, "all"));
	expect(onDefault.map((project) => [project.machine.id, project.name])).toEqual([[Contract.LOCAL_SERVER, "Local"]]);
	const byName = everywhere.toSorted((a, b) => a.name.localeCompare(b.name));
	expect(byName.map((project) => [project.machine.id, project.name])).toEqual([
		[Contract.LOCAL_SERVER, "Local"],
		[remoteId, "Remote"],
	]);

	await snapshot(
		"machines",
		normalizer(
			[localHome, remoteHome, appHome],
			[
				[localStore.storeId, "<local store>"],
				[remoteStore.storeId, "<remote store>"],
				[Contract.LOCAL_SERVER, "<local machine>"],
			],
		)(elide({ default: onDefault, all: byName })),
	);
}, 90_000);

it("a fork's line pages through inherited entries by keyset, takes its ancestor's title, and reads below its floor after sync.page", async () => {
	const cwHome = tempDir("line-cw");
	const appHome = tempDir("line-app");
	const server = await codework(cwHome, await freePort());
	// Two large prompts and their echoed replies: about 1.2 MB, past a first page's 1 MiB.
	const big = (tag: string) => `${tag}\n${"x".repeat(300_000)}`;
	const created = await session(server, cwHome, big("First"), "Line");
	const sessionId = created.session.id;
	const { source, fork } = await server.run((rpc) =>
		Effect.gen(function* () {
			yield* rpc["thread.prompt"]({ sessionId, text: big("Second") });
			yield* rpc["thread.wait"]({ sessionId });
			const second = (yield* rpc["thread.history"]({ sessionId })).entries.at(-1)!;
			const source = (yield* rpc["thread.fork"]({ sessionId, entryId: second.id })).thread;
			yield* rpc["thread.prompt"]({ sessionId, threadId: source.id, text: "Fork prompt" });
			yield* rpc["thread.wait"]({ sessionId, threadId: source.id });
			const reply = (yield* rpc["thread.history"]({ sessionId, threadId: source.id })).entries.at(-1)!;
			const fork = (yield* rpc["thread.fork"]({ sessionId, threadId: source.id, entryId: reply.id })).thread;
			return { source, fork };
		}),
	);
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);
	const ref = { sessionId, threadId: fork.id };
	await desk.run((rpc) => rpc["sync.open"](ref));
	const line = (request: { before?: number; limit: number }) =>
		desk.run((rpc) => rpc["threads.line"]({ ...ref, ...request }));
	const history = (await server.run((rpc) => rpc["thread.history"](ref))).entries;
	expect(history).toHaveLength(6);

	// Newest first by keyset, two at a time, down to the floor the first open left.
	const newest = await line({ limit: 2 });
	const middle = await line({ before: newest.entries[0]!.seq, limit: 2 });
	const atFloor = await line({ before: middle.entries[0]!.seq, limit: 2 });
	expect(newest.thread.title).toBe("Fork prompt");
	expect(newest.entries.map((entry) => entry.id)).toEqual(history.slice(4).map((entry) => entry.id));
	expect(newest.entries.map((entry) => entry.threadId)).toEqual([source.id, source.id]);
	expect(middle.entries.map((entry) => entry.id)).toEqual(history.slice(2, 4).map((entry) => entry.id));
	expect(middle.entries.map((entry) => entry.threadId)).toEqual([created.id, created.id]);
	expect(atFloor.entries.map((entry) => entry.id)).toEqual([history[1]!.id]);
	expect(atFloor).toMatchObject({ more: false, floor: history[1]!.seq });

	const paged = await desk.run((rpc) => rpc["sync.page"]({ ...ref, limit: 10 }));
	const below = await line({ before: middle.entries[0]!.seq, limit: 2 });
	expect(paged).toEqual({ entries: 1, floor: history[0]!.seq });
	expect(below.entries.map((entry) => entry.id)).toEqual(history.slice(0, 2).map((entry) => entry.id));
	expect(below.floor).toBe(history[0]!.seq);
	// Now that the whole line is held, the 1 MiB budget cuts the page before its oldest entry.
	const budgeted = await line({ limit: 10 });
	expect(budgeted.entries.map((entry) => entry.id)).toEqual(history.slice(1).map((entry) => entry.id));
	expect(budgeted.more).toBe(true);

	// Its own first prompt names it; a follow-up behind a held reply is its pending inbox.
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
	await waitFor(
		async () => ((await server.run((rpc) => rpc["thread.queue"](ref))).entries.length === 0 ? true : undefined),
		"the held reply",
	);
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "Queued", delivery: "followUp" }));
	await waitFor(() => (query(appHome, "SELECT id FROM inbox").length === 1 ? true : undefined), "the pending inbox");
	const gateSeq = await waitFor(
		() =>
			query(
				appHome,
				`SELECT entry.seq FROM entry JOIN part ON part.entry_id = entry.id
				 WHERE entry.thread_id = ? AND entry.type = 'user' AND json_extract(part.data, '$.text') = 'gate'`,
				fork.id,
			)[0]?.seq as number | undefined,
		"the gate prompt",
	);
	// The title rides the index, the inbox the thread's detail: both current.
	await synced(appHome, machineId, server);
	const queued = await line({ before: gateSeq, limit: 2 });
	expect(queued.thread.title).toBe("gate");
	expect(queued.inbox.map((prompt) => [prompt.text, prompt.delivery])).toEqual([["Queued", "followUp"]]);
	expect(queued.entries.map((entry) => entry.id)).toEqual(newest.entries.map((entry) => entry.id));

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"line",
		normalizer(
			[cwHome, appHome],
			[[storeId, "<store>"]],
		)(
			elide({
				newest: brief(newest),
				middle: brief(middle),
				atFloor: brief(atFloor),
				budgeted: { entries: budgeted.entries.map((entry) => entry.id), more: budgeted.more },
				paged: { ...paged, below: brief(below) },
				queued: brief(queued),
			}),
		),
	);
}, 120_000);

it("a command on a remote machine's session reaches that machine", async () => {
	const localHome = tempDir("command-local");
	const remoteHome = tempDir("command-remote");
	const appHome = tempDir("command-app");
	const localPort = await freePort();
	const local = await codework(localHome, localPort);
	const remote = await codework(remoteHome, await freePort());
	const created = await remote.run((rpc) => rpc["session.create"]({ directory: remoteHome }));
	const ref = { sessionId: created.session.id, threadId: created.id };

	// The default machine is another server, so a command sent there would not find the session.
	registerLocal(appHome, local, localPort);
	const desk = await app(appHome);
	const remoteId = await addMachine(appHome, remote, desk.run);
	const { storeId } = await synced(appHome, remoteId, remote);
	const request = (topic: string, payload: Row) =>
		desk.run((rpc) => rpc["event.request"]({ topic, source: "test", payload })).then((reply) => reply.payload);

	const messageId = crypto.randomUUID();
	const prompted = await request("codework/session.prompt", { sessionId: ref.sessionId, messageId, text: "hold" });
	await waitFor(
		async () => ((await remote.run((rpc) => rpc["thread.info"](ref))).runState === "running" ? true : undefined),
		"the run on the remote machine",
	);
	const interrupted = await request("codework/session.interrupt", { sessionId: ref.sessionId });
	await remote.run((rpc) => rpc["thread.wait"](ref));
	const history = (await remote.run((rpc) => rpc["thread.history"](ref))).entries;
	const onLocal = await local.run((rpc) => rpc["thread.list"]({}));

	expect(prompted).toEqual({ _tag: "Done" });
	expect(interrupted).toEqual({ _tag: "Done" });
	expect(history[0]).toMatchObject({ id: messageId, role: "user" });
	expect(onLocal).toEqual([]);

	await snapshot(
		"command",
		normalizer(
			[localHome, remoteHome, appHome],
			[
				[storeId, "<store>"],
				[messageId, "<message>"],
			],
		)(
			elide({
				prompted,
				interrupted,
				history: history.map(({ id, role, state }) => ({ id, role, state })),
				onLocal,
			}),
		),
	);
}, 90_000);

it("each read's topics fire after the change it shows, and the session backend forwards them for its view", async () => {
	const cwHome = tempDir("topics-cw");
	const appHome = tempDir("topics-app");
	const server = await codework(cwHome, await freePort());
	const desk = await app(appHome);
	const machineId = await addMachine(appHome, server, desk.run);

	// The sidebar: a new session, then its color.
	const sidebarTopics = await follow(desk, Contract.readTopics.sidebar);
	const created = await session(server, cwHome, "New session", "Topics");
	const ref = { sessionId: created.session.id, threadId: created.id };
	const added = await waitFor(
		() =>
			sidebarTopics.events.find(
				(event) =>
					event.topic === Contract.syncTopics.changed &&
					(event.payload.session as Array<string>).includes(ref.sessionId),
			),
		"the notice of the new session",
	);
	await synced(appHome, machineId, server);
	const listed = (await desk.run((rpc) => sidebar(rpc)))[0]!.sessions[0]!;
	expect(listed).toMatchObject({ id: ref.sessionId, title: "New session", color: null, runState: "idle" });
	await desk.run((rpc) => rpc["sessions.setColor"]({ sessionId: ref.sessionId, color: "#336699" }));
	const colored = await waitFor(
		() => sidebarTopics.events.find((event) => event.topic === Contract.syncTopics.tracking),
		"the color edit",
	);
	expect((await desk.run((rpc) => sidebar(rpc)))[0]!.sessions[0]!.color).toBe("#336699");
	sidebarTopics.stop();

	// The line: an opened thread's new entries and its live draft.
	await desk.run((rpc) => rpc["sync.open"](ref));
	const lineTopics = await follow(desk, Contract.readTopics.line(ref.threadId));
	await server.run((rpc) => rpc["thread.prompt"]({ ...ref, text: "gate" }));
	await waitFor(
		() => lineTopics.events.find((event) => event.topic === Contract.syncTopics.delta(ref.threadId)),
		"the first delta",
	);
	for (let step = 0; step < 4; step++) server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	const detail = await waitFor(
		() =>
			lineTopics.events.find(
				(event) =>
					event.payload.threadId === ref.threadId &&
					query(appHome, "SELECT state FROM entry WHERE thread_id = ? AND state = 'committed'", ref.threadId)
						.length === 4,
			),
		"the notice of the committed reply",
	);
	const read = await desk.run((rpc) => rpc["threads.line"]({ ...ref, limit: 10 }));
	const reply = read.entries.at(-1)!;
	expect(reply.parts).toEqual([{ type: "text", text: "Hello world!" }]);
	lineTopics.stop();
	await desk.run((rpc) => rpc["sync.close"](ref));

	// The session backend: a follow, a page, then the updates it forwards on the thread's topic.
	const request = (topic: string, payload: Row) =>
		desk.run((rpc) => rpc["event.request"]({ topic, source: "test", payload })).then((reply) => reply.payload as Row);
	const followed = await request("codework/session.follow", { sessionId: ref.sessionId });
	const window = await request("codework/session.page", { sessionId: ref.sessionId, limit: 10 });
	expect(followed).toEqual({ _tag: "Done" });
	expect((window.messages as Array<Row>).map((message) => message.id)).toEqual(read.entries.map((entry) => entry.id));
	const updates: Array<Row> = [];
	const thread = desk.background((rpc) =>
		rpc["event.subscribe"]({ topics: [`codework/session/${ref.sessionId}`], after: window.seq as number }).pipe(
			Stream.runForEach((item) => Effect.sync(() => "_tag" in item || updates.push(item.payload as Row))),
		),
	);
	const messageId = crypto.randomUUID();
	await request("codework/session.prompt", { sessionId: ref.sessionId, messageId, text: "gate" });
	await waitFor(() => updates.find((update) => update._tag === "Delta"), "a forwarded delta");
	for (let step = 0; step < 4; step++) server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	const answered = await waitFor(
		() =>
			updates.find(
				(update) =>
					update._tag === "Message" &&
					(update.message as Row).role === "assistant" &&
					(update.message as Row).state === "committed",
			),
		"the committed reply on the thread's topic",
	);
	await waitFor(
		() => updates.findLast((update) => update._tag === "Info" && (update.info as Row).runState === "idle"),
		"the idle thread",
	);
	thread.stop();
	const infos = updates.flatMap((update) => (update._tag === "Info" ? [(update.info as Row).runState] : []));
	// Whether a queue or a `starting` row shows depends on how the batches fall, so they are left out.
	const tags = ["Delta", "Info", "Message"].filter((tag) => updates.some((update) => update._tag === tag));
	const runStates = ["running", "idle"].filter((state) => infos.includes(state));
	expect(updates.some((update) => update._tag === "Message" && (update.message as Row).id === messageId)).toBe(true);
	expect(runStates).toContain("running");
	expect(infos.at(-1)).toBe("idle");

	// A follow waiting for a thread the app has not seen ends as soon as its session is removed.
	const startedAt = Date.now();
	const waiting = request("codework/session.follow", { sessionId: ref.sessionId, threadId: "thr_not_synced" });
	await new Promise((resolve) => setTimeout(resolve, 500));
	await server.run((rpc) => rpc["session.delete"]({ sessionId: ref.sessionId }));
	const gone = await waiting;
	expect(gone).toEqual({ _tag: "Failed", message: "This session no longer exists." });
	expect(Date.now() - startedAt).toBeLessThan(10_000);

	const { storeId } = await synced(appHome, machineId, server);
	await snapshot(
		"topics",
		normalizer(
			[cwHome, appHome],
			[
				[storeId, "<store>"],
				[messageId, "<message>"],
			],
		)(
			elide({
				sidebar: { added: added.topic, colored: colored.payload, listed },
				line: { detail: detail.topic, reply: { id: reply.id, parts: reply.parts } },
				backend: {
					tags,
					runStates,
					answered: answered.message,
					removedWhileWaiting: gone,
				},
			}),
		),
	);
}, 120_000);
