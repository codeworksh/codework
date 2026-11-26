/* @effect-diagnostics nodeBuiltinImport:off -- the suite registers CodeWork servers in temp homes. */
import { Session } from "../../../packages/harness/src/effect.ts";
import { Effect } from "effect";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Contract, type ThreadLine } from "@codeworksh/contract";
import {
	addMachine,
	app,
	type AppRpc,
	cleanup,
	type Codework,
	codework,
	follow,
	freePort,
	lastSeq,
	normalizer,
	notices,
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
						typeof item === "number" && (key === "updated" || key === "created" || /[a-z]At$/.test(key))
							? "<time>"
							: elide(item),
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
		JSON.stringify({ pid: server.proc.pid, version: "0.0.0", url: server.url, port, token: server.token }),
	);
};

const sidebar = (rpc: AppRpc, machines: "default" | "all" = "all") =>
	rpc["sidebar.list"]({ organizationId: Contract.PERSONAL_ORGANIZATION, machines });

it("the sidebar reads app.db alone: a run started before the app shows running at launch, a fork's activity moves its session up, and it stays while CodeWork is stopped", async () => {
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
	expect(project!.machine).toEqual({ id: machineId, name: "Fixture" });
	expect(project!.sessions.map((row) => [row.id, row.threadId, row.runState, row.title])).toEqual([
		[busy.session.id, busy.id, "running", "hold"],
		[idle.session.id, idle.id, "idle", "Idle prompt"],
	]);

	// A prompt on a fork of the idle session's main thread makes that session the newest, though its main thread is older.
	const fork = await server.run((rpc) =>
		Effect.gen(function* () {
			const ref = { sessionId: idle.session.id };
			const reply = (yield* rpc["thread.history"](ref)).entries.at(-1)!;
			const fork = (yield* rpc["thread.fork"]({ ...ref, entryId: reply.id })).thread;
			yield* rpc["thread.prompt"]({ ...ref, threadId: fork.id, text: "Fork prompt" });
			yield* rpc["thread.wait"]({ ...ref, threadId: fork.id });
			return fork;
		}),
	);
	await synced(appHome, machineId, server);
	const forked = await desk.run((rpc) => sidebar(rpc));
	expect(forked[0]!.sessions.map((row) => [row.id, row.threadId, row.title])).toEqual([
		[idle.session.id, idle.id, "Idle prompt"],
		[busy.session.id, busy.id, "hold"],
	]);
	const [main] = query(appHome, "SELECT updated_at FROM thread WHERE id = ?", idle.id);
	const [own] = query(appHome, "SELECT updated_at FROM thread WHERE id = ?", fork.id);
	expect(forked[0]!.sessions[0]!.updated).toBe(own!.updated_at);
	expect(own!.updated_at as number).toBeGreaterThan(main!.updated_at as number);

	await stop(server.proc);
	const stopped = await desk.run((rpc) => sidebar(rpc));
	expect(stopped).toEqual(forked);

	await snapshot(
		"sidebar",
		normalizer([cwHome, appHome], [[storeId, "<store>"]])(elide({ launched, forked, stoppedEqualsForked: true })),
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
	expect(byName.map((project) => [project.machine.id, project.name, project.onHost])).toEqual([
		[Contract.LOCAL_SERVER, "Local", true],
		[remoteId, "Remote", true],
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

// Daytona runs when this computer has its key, as the fixture's server then offers its driver.
describe.each([
	{ driver: "memory", env: undefined },
	{ driver: "daytona", env: "DAYTONA_API_KEY" },
] as const)("a $driver sandbox", ({ driver, env }) => {
	it.skipIf(env !== undefined && !process.env[env]?.trim())(
		"a project only in a sandbox on a paired machine has no folder there, though the CLI anchors its session to one",
		async () => {
			const localHome = tempDir(`sandbox-${driver}-local`);
			const remoteHome = tempDir(`sandbox-${driver}-remote`);
			const appHome = tempDir(`sandbox-${driver}-app`);
			const localPort = await freePort();
			const local = await codework(localHome, localPort);
			const remote = await codework(remoteHome, await freePort());
			try {
				await session(remote, remoteHome, "In a folder", "Folder");
				await remote.run((rpc) =>
					Effect.gen(function* () {
						const created = yield* rpc["session.create"]({
							sandbox: { driver },
							hostDir: Session.AbsolutePath.make(remoteHome),
							project: { name: "Sandboxed" },
						});
						yield* rpc["thread.prompt"]({ sessionId: created.session.id, text: "In a sandbox" });
						yield* rpc["thread.wait"]({ sessionId: created.session.id });
					}),
				);

				registerLocal(appHome, local, localPort);
				const desk = await app(appHome);
				const remoteId = await addMachine(appHome, remote, desk.run);
				const { storeId } = await synced(appHome, remoteId, remote);
				const projects = (await desk.run((rpc) => sidebar(rpc, "all")))
					.filter((project) => project.machine.id === remoteId)
					.toSorted((a, b) => a.name.localeCompare(b.name));
				expect(projects.map((project) => [project.name, project.onHost])).toEqual([
					["Folder", true],
					["Sandboxed", false],
				]);

				await snapshot(
					`sandbox.${driver}`,
					normalizer([localHome, remoteHome, appHome], [[storeId, "<remote store>"]])(elide(projects)),
				);
			} finally {
				// A remote sandbox outlives the server that made it until it is stopped.
				await remote.run((rpc) =>
					rpc["sandbox.list"]({}).pipe(
						Effect.flatMap((sandboxes) =>
							Effect.forEach(
								sandboxes.filter((sandbox) => sandbox.driver === driver),
								(sandbox) => rpc["sandbox.stop"]({ sandboxId: sandbox.id }),
								{ discard: true },
							),
						),
					),
				);
			}
		},
		240_000,
	);
});

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
	expect(queued.thread.parked).toBe(false);

	// A stop leaves the follow-up waiting for the next prompt: the thread reads parked, the prompt still queued.
	await server.run((rpc) => rpc["thread.interrupt"](ref));
	await waitFor(
		() => (query(appHome, "SELECT parked FROM thread WHERE id = ?", fork.id)[0]?.parked === 1 ? true : undefined),
		"the parked thread",
	);
	const parked = await line({ limit: 0 });
	expect(parked.thread).toMatchObject({ runState: "idle", parked: true });
	expect(parked.inbox.map((prompt) => prompt.text)).toEqual(["Queued"]);

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
				stopped: { thread: parked.thread, inbox: parked.inbox },
			}),
		),
	);
}, 120_000);

it("a command on a remote machine's session reaches that machine, and a fork's thread is in app.db once answered", async () => {
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
	const forked = (await request("codework/session.fork", { sessionId: ref.sessionId, entryId: messageId })) as Row;
	// Read at once: the reply waits for the machine's index to bring the fork's row.
	const forkRow = query(
		appHome,
		"SELECT session_id, origin_kind, origin_thread_id, origin_entry_id FROM thread WHERE id = ?",
		forked.threadId as string,
	);
	const onRemote = (await remote.run((rpc) => rpc["thread.list"]({ sessionId: ref.sessionId }))).map(
		(thread) => thread.id,
	);
	const onLocal = await local.run((rpc) => rpc["thread.list"]({}));

	expect(prompted).toEqual({ _tag: "Done" });
	expect(interrupted).toEqual({ _tag: "Done" });
	expect(history[0]).toMatchObject({ id: messageId, role: "user" });
	expect(forked._tag).toBe("Forked");
	expect(onRemote).toContain(forked.threadId);
	expect(forkRow).toEqual([
		{ session_id: ref.sessionId, origin_kind: "fork", origin_thread_id: ref.threadId, origin_entry_id: messageId },
	]);
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
				forked,
				forkRow,
				onLocal,
			}),
		),
	);
}, 90_000);

it("a session created for a paired machine starts there with its first prompt, and host calls go to the machine named", async () => {
	const localHome = tempDir("create-local");
	const remoteHome = tempDir("create-remote");
	const appHome = tempDir("create-app");
	const localPort = await freePort();
	const local = await codework(localHome, localPort);
	// Its own OS home, so a host call that reached the default machine instead would list another `~`.
	const remote = await codework(remoteHome, await freePort(), { osHome: remoteHome });
	const folder = join(remoteHome, "project");
	mkdirSync(folder);

	registerLocal(appHome, local, localPort);
	const desk = await app(appHome);
	const remoteId = await addMachine(appHome, remote, desk.run);
	const { storeId } = await synced(appHome, remoteId, remote);
	const request = (topic: string, payload: Row) =>
		desk.run((rpc) => rpc["event.request"]({ topic, source: "test", payload })).then((reply) => reply.payload as Row);
	const refused = <A, E extends { readonly _tag: string; readonly message: string }>(
		use: (rpc: AppRpc) => Effect.Effect<A, E>,
	) =>
		desk.run((rpc) =>
			use(rpc).pipe(
				Effect.match({ onFailure: ({ _tag, message }) => ({ _tag, message }), onSuccess: () => "answered" }),
			),
		);

	const messageId = crypto.randomUUID();
	const created = await request("codework/session.create", {
		place: { _tag: "Folder", path: folder },
		machineId: remoteId,
		messageId,
		text: "hello",
	});
	const sessionId = Session.SessionSchema.ID.make(created.sessionId as string);
	const onRemote = await remote.run((rpc) => rpc["thread.list"]({ sessionId }));
	const onLocal = await local.run((rpc) => rpc["thread.list"]({}));
	const thread = { sessionId, threadId: onRemote[0]!.id };
	// The first prompt runs on the paired machine's scripted model; its history holds it once taken.
	await remote.run((rpc) => rpc["thread.wait"](thread));
	const history = (await remote.run((rpc) => rpc["thread.history"](thread))).entries;
	const first = history[0];
	// The scripted model answers the prompt's own text, so the reply shows it arrived whole and ran.
	const replied = JSON.stringify(history).includes("reply to hello");
	await synced(appHome, remoteId, remote);
	const row = query(appHome, "SELECT machine_id FROM session WHERE id = ?", sessionId);

	// The project's own files and name live on its machine; without the machine, the default one does not know it.
	const projectId = query(
		appHome,
		"SELECT space.project_id FROM session JOIN space ON space.machine_id = session.machine_id AND space.id = session.space_id WHERE session.id = ?",
		sessionId,
	)[0]!.project_id as string;
	const set = await refused((rpc) =>
		rpc["settings.set"]({ machineId: remoteId, projectId, file: "settings", at: ["retry", "maxRetries"], value: 2 }),
	);
	const written = readFileSync(join(folder, ".codework", "settings.jsonc"), "utf8").includes("maxRetries");
	const elsewhere = await refused((rpc) =>
		rpc["settings.set"]({ projectId, file: "settings", at: ["retry", "maxRetries"], value: 3 }),
	);
	const renamed = await desk.run((rpc) => rpc["projects.rename"]({ machineId: remoteId, projectId, name: "Renamed" }));

	const browsed = await desk.run((rpc) => rpc["host.browse"]({ machineId: remoteId, path: "~" }));
	const unknown = await refused((rpc) => rpc["host.browse"]({ machineId: "nowhere", path: remoteHome }));
	await stop(remote.proc);
	const away = await waitFor(async () => {
		const reply = await refused((rpc) => rpc["host.info"]({ machineId: remoteId }));
		return reply === "answered" ? undefined : reply;
	}, "the stopped machine refused");

	// Removing the machine takes its rows with it, and says so, so every view reads again.
	const beforeRemove = lastSeq(appHome);
	await desk.run((rpc) => rpc["servers.remove"]({ id: remoteId }));
	const announced = notices(appHome, "sync/changed", beforeRemove).filter((notice) => notice.machineId === remoteId);
	const left = query(appHome, "SELECT id FROM session WHERE id = ?", sessionId);

	expect(created._tag).toBe("Created");
	expect(onRemote.map((thread) => thread.id)).toHaveLength(1);
	expect(onLocal).toEqual([]);
	expect(first).toMatchObject({ id: messageId, role: "user" });
	expect(replied).toBe(true);
	expect(row).toEqual([{ machine_id: remoteId }]);
	expect(set).toBe("answered");
	expect(written).toBe(true);
	expect(elsewhere).toMatchObject({ _tag: "Server.ProjectError" });
	expect(renamed.name).toBe("Renamed");
	expect(announced).toHaveLength(1);
	expect(announced[0]!.removed).toEqual([sessionId]);
	expect(left).toEqual([]);
	expect(browsed.path).toBe(remoteHome);
	expect(browsed.entries.map((entry) => entry.name)).toContain("project");

	await snapshot(
		"create",
		normalizer(
			[localHome, remoteHome, appHome],
			[
				[storeId, "<store>"],
				[sessionId, "<session>"],
				[remoteId, "<remote>"],
				[messageId, "<message>"],
			],
		)(
			elide({
				created,
				"threads on the paired machine": onRemote.length,
				"threads on the default machine": onLocal.length,
				"first entry": { id: first?.id, role: first?.role },
				"the model replied to it": replied,
				"its row in app.db": row,
				"settings.set on its machine": { reply: set, written },
				"settings.set without the machine": elsewhere,
				"projects.rename on its machine": renamed.name,
				"host.browse of ~ there": { path: browsed.path, readable: browsed.readable },
				"a machine the app does not know": unknown,
				"the machine stopped": away,
				"servers.remove": {
					notices: announced.map((notice) => ({
						full: notice.full,
						removed: notice.removed,
						projects: (notice.project as Array<string>).length,
					})),
					"its session in app.db": left.length,
				},
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
	// The first chunk comes as its delta, or in the reply's draft row when that row reaches the app first.
	await waitFor(
		() =>
			lineTopics.events.find(
				(event) =>
					event.topic === Contract.syncTopics.delta(ref.threadId) ||
					(event.payload.threadId === ref.threadId &&
						query(
							appHome,
							`SELECT entry.id FROM entry JOIN part ON part.entry_id = entry.id
							 WHERE entry.thread_id = ? AND entry.state = 'draft' AND json_extract(part.data, '$.text') <> ''`,
							ref.threadId,
						).length > 0),
			),
		"the reply's first chunk",
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
	const thread = await follow(desk, [`codework/session/${ref.sessionId}`], window.seq as number);
	const updates = () => thread.events.map((event) => event.payload);
	const messageId = crypto.randomUUID();
	await request("codework/session.prompt", { sessionId: ref.sessionId, messageId, text: "gate" });
	// A step reaches the view as its delta, or in a draft message when a draft row already holding it
	// reaches the app first and the sync drops the delta as held. One step at a time, a step's delta
	// can lose only to the reply's first row or a checkpoint, which comes at most once a second.
	const shown = (length: number) =>
		updates().some((update) => {
			if (update._tag === "Delta") {
				const { offset, delta } = update.delta as { offset: number; delta: string };
				return offset + delta.length >= length;
			}
			const message = update.message as { role: string; state: string; parts: Array<{ text?: string }> };
			return (
				update._tag === "Message" &&
				message.role === "assistant" &&
				message.state === "draft" &&
				message.parts.some((part) => (part.text?.length ?? 0) >= length)
			);
		});
	// The reply's length after each of "Hello " | "wor" | "ld" | "!"; one more release ends it.
	for (const [step, length] of [6, 9, 11, 12].entries()) {
		if (step > 0) server.release();
		await waitFor(() => (shown(length) ? true : undefined), `the reply's first ${length} characters`);
	}
	server.release();
	await server.run((rpc) => rpc["thread.wait"](ref));
	const answered = await waitFor(
		() =>
			updates().find(
				(update) =>
					update._tag === "Message" &&
					(update.message as Row).role === "assistant" &&
					(update.message as Row).state === "committed",
			),
		"the committed reply on the thread's topic",
	);
	await waitFor(
		() => updates().findLast((update) => update._tag === "Info" && (update.info as Row).runState === "idle"),
		"the idle thread",
	);
	thread.stop();
	const forwarded = updates();
	const infos = forwarded.flatMap((update) => (update._tag === "Info" ? [(update.info as Row).runState] : []));
	// Whether a queue or a `starting` row shows depends on how the batches fall, so they are left out.
	const tags = ["Delta", "Info", "Message"].filter((tag) => forwarded.some((update) => update._tag === tag));
	const runStates = ["running", "idle"].filter((state) => infos.includes(state));
	expect(forwarded.some((update) => update._tag === "Message" && (update.message as Row).id === messageId)).toBe(true);
	expect(runStates).toContain("running");
	expect(infos.at(-1)).toBe("idle");

	// Not held once the machine's index is at its head: a missing thread, then a removed session, fail at once.
	const startedAt = Date.now();
	const missing = await request("codework/session.follow", { sessionId: ref.sessionId, threadId: "thr_not_synced" });
	await server.run((rpc) => rpc["session.delete"]({ sessionId: ref.sessionId }));
	await synced(appHome, machineId, server);
	const gone = await request("codework/session.follow", { sessionId: ref.sessionId, threadId: ref.threadId });
	expect(missing).toEqual({ _tag: "Failed", message: "This thread no longer exists." });
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
					missingThread: missing,
					removedSession: gone,
				},
			}),
		),
	);
}, 120_000);
