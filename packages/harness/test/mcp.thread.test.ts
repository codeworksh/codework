import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Deferred, Effect, Fiber } from "effect";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Document } from "../src/document/document.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { McpOAuth } from "../src/mcp/oauth.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { TOOL_SEARCH_NAME, toolSearchPlugin } from "../src/plugin/builtin/tool/toolsearch.ts";
import { define } from "../src/plugin/plugin.ts";
import type { LLM } from "../src/runner/llm.ts";
import { assistant } from "./fixtures/llm.ts";
import { listen, raw } from "./fixtures/mcp/http.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp/session.mjs", import.meta.url));
const stdio = (extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => ({
	command: process.execPath,
	args: [fixture],
	env: { E2E_GREETING: "hello", ...env },
	...extra,
});

const git = (cwd: string, ...args: string[]) =>
	promisify(execFile)("git", ["-c", "commit.gpgsign=false", ...args], { cwd }).then(() => undefined);

const write = async (file: string, value: unknown) => {
	await fs.mkdir(join(file, ".."), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, 2));
};

/** `toolsearch` turns on by itself only with deferred tools; the entry after it keeps it on regardless. */
const toolSearch = [toolSearchPlugin, { plugin: toolSearchPlugin.id, enabled: true }] as const;

/** A scripted model: per thread, one reply per request, in order; an empty one ends the turn. */
const scripted = () => {
	const script = new Map<string, Array<ReadonlyArray<Message.ToolCallPendingPart>>>();
	const requests: Array<LLM.Input> = [];
	let responses = 0;
	const open: LLM.Open = (input) =>
		Effect.sync(() => {
			requests.push(input);
			const calls = script.get(input.threadId)?.shift() ?? [];
			responses += 1;
			const message = assistant(
				input,
				responses,
				calls.length > 0 ? { stopReason: "toolUse", parts: [...calls] } : {},
			);
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: calls.length > 0 ? "toolUse" : "stop", message });
			return stream;
		});
	/** Queue a turn on a thread: tool calls for each request, then a closing reply. */
	const turn = (threadId: string, ...requests: ReadonlyArray<ReadonlyArray<Message.ToolCallPendingPart>>) => {
		const queue = script.get(threadId) ?? [];
		queue.push(...requests, []);
		script.set(threadId, queue);
	};
	/** Drop what is left of a thread's script, as an interrupted turn leaves it. */
	const clear = (threadId: string) => script.delete(threadId);
	return { open, turn, clear, requests };
};

/** Threads and servers connect concurrently; their keys are sorted so the artifact does not depend on it. */
const byName = <A>(record: Record<string, A>) =>
	Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));

/** Every `mcp.server.status` event, by thread label and server, in order; `read` takes a copy. */
const statusEvents = (label: (threadId: string) => string) =>
	Effect.gen(function* () {
		const seen: Record<string, Record<string, Array<EventList.McpServerState>>> = {};
		const events = yield* Event.Service;
		yield* events.listen((event) =>
			Effect.sync(() => {
				if (event.type !== EventList.McpServerStatus.type) return;
				const { threadId, status } = (event as unknown as EventList.McpServerStatus).data;
				const byServer = (seen[label(threadId)] ??= {});
				(byServer[status.server] ??= []).push(status);
			}),
		);
		return {
			read: () =>
				byName(Object.fromEntries(Object.entries(seen).map(([thread, servers]) => [thread, byName(servers)]))),
		};
	});

/** The text of each settled tool call of a thread, by call id. */
const results = (thread: Session.ThreadHandle) =>
	Effect.gen(function* () {
		const line = yield* thread.history();
		const out: Record<string, string> = {};
		for (const hydrated of line) {
			if (hydrated.entry.type !== "assistant") continue;
			const message = yield* ContextCodec.decodeMessage(hydrated);
			if (message.role !== "assistant") continue;
			for (const part of message.parts)
				if (part.type === "toolCall" && "result" in part)
					out[part.callID] = part.result.content
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("");
		}
		return out;
	});

/** Tool changes the transcript declared, as names. */
const changes = (messages: ReadonlyArray<Message.Message>) =>
	messages.flatMap((message) =>
		message.role === "system"
			? [
					{
						added: (message.toolsAdded ?? []).map((tool) => tool.name),
						removed: (message.toolsRemoved ?? []).map((tool) => tool.name),
					},
				]
			: [],
	);

const waitFor = <A>(read: Effect.Effect<A>, done: (value: A) => boolean) =>
	Effect.gen(function* () {
		for (let tries = 0; tries < 250; tries++) {
			const value = yield* read;
			if (done(value)) return value;
			yield* Effect.sleep("20 millis");
		}
		return yield* read;
	});

it("mcp: state per thread, no retry of a failed server, connect and disconnect, every exposure registered", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	// A worktree of the same project: a thread can move there, and it is another place.
	const elsewhere = join(dir.path, "elsewhere");
	await fs.mkdir(work, { recursive: true });
	await git(work, "init", "-q", "-b", "main");
	await git(
		work,
		"-c",
		"user.email=test@codework.sh",
		"-c",
		"user.name=Test",
		"commit",
		"-q",
		"--allow-empty",
		"-m",
		"init",
	);
	await git(work, "worktree", "add", "-q", "--detach", elsewhere);
	const gate = join(dir.path, "gate");
	const starts = join(dir.path, "starts");
	await fs.writeFile(gate, "closed");

	await write(join(home, "mcp.json"), {
		mcpServers: {
			e2e: stdio({ toolExposure: { args: "deferred", fail: "codemode", secret: "hidden" } }),
			gated: stdio(
				{ exposure: "direct", toolExposure: { "*": "hidden", pid: "direct" } },
				{
					E2E_GATE: gate,
					E2E_STARTS: starts,
				},
			),
			off: stdio({ enabled: false }),
		},
	});

	// Only the forked thread runs `extra`: MCP config may differ per thread.
	let forkId: string | undefined;
	let siblingId: string | undefined;
	const perThread = define({
		id: "test.mcp.per-thread",
		kind: "mcp",
		setup: (ctx) => {
			if (ctx.threadId === forkId) ctx.plugin.mcp.set("extra", stdio({ exposure: "deferred" }));
		},
	});
	const registered: Record<string, Array<{ readonly name: string; readonly exposure: string }>> = {};
	const observer = define({
		id: "test.mcp.registered",
		kind: "tool",
		setup: (ctx) => {
			registered[ctx.threadId] = ctx.plugin.tools
				.list()
				.filter((def) => def.name.startsWith("mcp__"))
				.map((def) => ({ name: def.name, exposure: def.exposure ?? "direct" }));
		},
	});

	const model = scripted();
	const startedPids = () => fs.readFile(starts, "utf8").then((text) => text.split("\n").filter(Boolean).map(Number));
	const startCount = () => startedPids().then((pids) => pids.length);
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	/** The gated server's processes still running, once the closed ones had time to exit. */
	const running = (expected: number) =>
		waitFor(
			Effect.promise(startedPids).pipe(Effect.map((pids) => pids.filter(alive))),
			(pids) => pids.length === expected,
		);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const label = (threadId: string) =>
			threadId === main.id ? "main" : threadId === forkId ? "fork" : threadId === siblingId ? "sibling" : threadId;
		const seen = yield* statusEvents(label);
		const mcp = yield* Mcp.Service;
		const status = (threadId: string) =>
			mcp.status(threadId as typeof main.id).pipe(
				Effect.map((all) =>
					Object.fromEntries(
						all.map((one) => [
							one.server,
							{
								state: one.state,
								...(one.error === undefined ? {} : { error: one.error }),
								tools: one.tools,
							},
						]),
					),
				),
			);
		const stateOf = (threadId: string, server: string) =>
			status(threadId).pipe(Effect.map((all) => all[server]?.state));
		const declared = () => (model.requests.at(-1)?.context.tools ?? []).map((tool) => tool.name);

		// Turn one: codemode, hidden and unloaded deferred tools are registered but not offered.
		model.turn(
			main.id,
			[
				pendingCall("mcp__e2e__pid", {}, "main-pid"),
				pendingCall("mcp__e2e__fail", {}, "codemode"),
				pendingCall("mcp__e2e__secret", {}, "hidden"),
				pendingCall("mcp__e2e__args", { word: "abc" }, "deferred-unloaded"),
			],
			[pendingCall(TOOL_SEARCH_NAME, { query: "arguments as received" }, "search")],
			[pendingCall("mcp__e2e__args", { word: "abc" }, "deferred-loaded")],
		);
		yield* main.run("one");
		const firstDeclared = (model.requests[0]?.context.tools ?? []).map((tool) => tool.name);

		// A second thread at another placement, with its own config: its own servers and processes.
		const line = yield* main.history();
		const forked = yield* main.fork({ entryId: line.at(-1)!.entry.id });
		forkId = forked.thread.id;
		const fork = forked.thread;
		yield* Session.relink({ sessionId: session.id, threadId: fork.id, directory: elsewhere });
		// A sibling stays where main is, so it shares main's instances.
		const sibling = (yield* main.fork({ entryId: line.at(-1)!.entry.id })).thread;
		siblingId = sibling.id;
		model.turn(sibling.id, [pendingCall("mcp__e2e__pid", {}, "sibling-pid")]);
		model.turn(main.id, [pendingCall("mcp__e2e__pid", {}, "main-pid-2")]);
		model.turn(fork.id, [pendingCall("mcp__e2e__pid", {}, "fork-pid")]);
		yield* Effect.all([main.run("two"), fork.run("two, forked"), sibling.run("two, sibling")], {
			concurrency: "unbounded",
		});
		const mainStatus = yield* status(main.id);
		const forkStatus = yield* status(fork.id);
		const forkRegistered = registered[fork.id];

		// The failed server stays failed across turns, even once it could start: nothing retries it.
		yield* main.run("three");
		yield* Effect.promise(() => fs.rm(gate));
		yield* main.run("four");
		const failedAfterTurns = yield* stateOf(main.id, "gated");
		const startsWhileFailed = yield* Effect.promise(startCount);

		// An explicit connect recovers it, and its tools are offered from the next turn.
		const connected = yield* mcp.connect(main.id, "gated");
		model.turn(main.id, [pendingCall("mcp__gated__pid", {}, "gated-pid")]);
		yield* main.run("five");
		const declaredAfterConnect = declared();

		// Disconnect closes it and keeps it closed: no tools, no restart by later turns.
		const disconnected = yield* mcp.disconnect(main.id, "gated");
		yield* main.run("six");
		const declaredAfterDisconnect = declared();
		const stillDisconnected = yield* stateOf(main.id, "gated");
		const startsAfterDisconnect = yield* Effect.promise(startCount);

		// A connection that drops is reported as disconnected, and the next call reconnects.
		model.turn(main.id, [pendingCall("mcp__e2e__bye", {}, "bye")]);
		yield* main.run("seven");
		yield* waitFor(stateOf(main.id, "e2e"), (state) => state === "disconnected");
		model.turn(main.id, [
			pendingCall("mcp__e2e__echo", { text: "back" }, "echo-after-drop"),
			pendingCall("mcp__e2e__pid", {}, "pid-before-restart"),
		]);
		yield* main.run("eight");

		// Connect on a connected server restarts it.
		const restarted = yield* mcp.connect(main.id, "e2e");
		model.turn(main.id, [pendingCall("mcp__e2e__pid", {}, "pid-after-restart")]);
		yield* main.run("nine");

		// Concurrent connect and disconnect run one after the other: the last one wins, and no
		// process outlives a disconnect.
		const race = Effect.fnUntraced(function* (first: "connect" | "disconnect", second: "connect" | "disconnect") {
			const finished: string[] = [];
			const run = (operation: "connect" | "disconnect") =>
				mcp[operation](main.id, "gated").pipe(Effect.tap(() => Effect.sync(() => finished.push(operation))));
			yield* Effect.all([run(first), run(second)], { concurrency: "unbounded" });
			const state = yield* stateOf(main.id, "gated");
			return { finished, state, running: (yield* running(state === "connected" ? 1 : 0)).length };
		});
		const connectThenDisconnect = yield* race("connect", "disconnect");
		const disconnectThenConnect = yield* race("disconnect", "connect");
		const startsAfterRaces = yield* Effect.promise(startCount);

		const unknown = yield* Effect.flip(mcp.connect(main.id, "nope"));
		return {
			firstDeclared,
			registeredMain: registered[main.id],
			forkRegistered,
			mainStatus,
			forkStatus,
			failedAfterTurns,
			startsWhileFailed,
			connected,
			declaredAfterConnect,
			disconnected,
			declaredAfterDisconnect,
			stillDisconnected,
			startsAfterDisconnect,
			calls: { main: yield* results(main), fork: yield* results(fork), sibling: yield* results(sibling) },
			changes: changes(model.requests.at(-1)?.context.messages ?? []),
			loaded: (yield* Document.Service.use((documents) => documents.agent(main.id))).modelTools,
			restarted,
			connectThenDisconnect,
			disconnectThenConnect,
			startsAfterRaces,
			unknown: { tag: unknown._tag, message: unknown.message },
			events: seen.read(),
		};
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [perThread, observer, defaultPromptPlugin, ...toolSearch],
				llm: model.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.firstDeclared).toContain("mcp__e2e__pid");
	for (const name of ["mcp__e2e__args", "mcp__e2e__fail", "mcp__e2e__secret"])
		expect(result.firstDeclared).not.toContain(name);
	expect(result.calls.main["main-pid"]).toMatch(/^\d+$/);
	expect(result.calls.fork["fork-pid"]).toMatch(/^\d+$/);
	// A thread placed elsewhere runs its own process.
	expect(result.calls.fork["fork-pid"]).not.toBe(result.calls.main["main-pid-2"]);
	expect(result.calls.sibling["sibling-pid"]).toBe(result.calls.main["main-pid-2"]);
	expect(result.calls.main["main-pid-2"]).toBe(result.calls.main["main-pid"]);
	expect(result.mainStatus.extra).toBeUndefined();
	expect(result.forkStatus.extra?.state).toBe("connected");
	expect(result.failedAfterTurns).toBe("failed");
	// One start for each thread's first turn; turns three and four never retried.
	expect(result.startsWhileFailed).toBe(2);
	expect(result.connected.state).toBe("connected");
	expect(result.declaredAfterConnect).toContain("mcp__gated__pid");
	expect(result.declaredAfterDisconnect).not.toContain("mcp__gated__pid");
	expect(result.stillDisconnected).toBe("disconnected");
	expect(result.startsAfterDisconnect).toBe(3);
	expect(result.calls.main["pid-after-restart"]).not.toBe(result.calls.main["pid-before-restart"]);
	expect(result.connectThenDisconnect).toEqual({
		finished: ["connect", "disconnect"],
		state: "disconnected",
		running: 0,
	});
	expect(result.disconnectThenConnect).toEqual({
		finished: ["disconnect", "connect"],
		state: "connected",
		running: 1,
	});

	const pids = [
		...new Set([
			result.calls.main["main-pid"],
			result.calls.fork["fork-pid"],
			result.calls.main["gated-pid"],
			result.calls.main["pid-before-restart"],
			result.calls.main["pid-after-restart"],
		]),
	];
	let serialized = JSON.stringify(result).replaceAll(dir.path, "<tmp>").replaceAll(process.execPath, "<node>");
	pids.forEach((pid, index) => {
		serialized = serialized.replaceAll(`"${pid}"`, `"<process-${index + 1}>"`);
	});
	const artifact = JSON.parse(
		serialized.replaceAll(forkId ?? "\0", "<fork>").replaceAll(siblingId ?? "\0", "<sibling>"),
	);
	await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.thread.json");
}, 60_000);

it("mcp: a loaded deferred tool's server is awaited up front, and its name stays loaded while the server is away", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	// The first start waits while `hold` exists, so the first turn finds it still connecting.
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	const configure = (delay: string) =>
		write(join(home, "mcp.json"), {
			mcpServers: { slow: stdio({ exposure: "deferred" }, { E2E_HOLD: hold, E2E_DELAY: delay }) },
		});
	await configure("0");

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "slow")?.state));

		// Nothing loaded: the turn does not wait for a server with only deferred tools.
		yield* main.run("one");
		const notAwaited = yield* stateOf;
		yield* Effect.promise(() => fs.rm(hold));
		yield* waitFor(stateOf, (state) => state === "connected");

		model.turn(main.id, [pendingCall(TOOL_SEARCH_NAME, { query: "echo text greeting" }, "search")]);
		yield* main.run("two");

		// A config change restarts the server; the loaded tool makes the turn wait for it.
		yield* Effect.promise(() => configure("500"));
		model.turn(main.id, [pendingCall("mcp__slow__echo", { text: "awaited" }, "awaited")]);
		yield* main.run("three");
		const awaitedChanges = changes(model.requests.at(-1)?.context.messages ?? []);

		// While the server is away its loaded tool is withdrawn, and declared again once it is back.
		yield* mcp.disconnect(main.id, "slow");
		yield* main.run("four");
		const whileAway = changes(model.requests.at(-1)?.context.messages ?? []);
		const loadedWhileAway = (yield* Document.Service.use((documents) => documents.agent(main.id))).modelTools;
		yield* mcp.connect(main.id, "slow");
		yield* main.run("five");
		const back = changes(model.requests.at(-1)?.context.messages ?? []);
		return { notAwaited, awaitedChanges, whileAway, loadedWhileAway, back, calls: yield* results(main) };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin, ...toolSearch],
				llm: model.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.notAwaited).toBe("connecting");
	expect(result.calls.awaited).toBe("hello: awaited");
	expect(result.loadedWhileAway?.add).toContain("mcp__slow__echo");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.thread.loaded.json",
	);
}, 60_000);

it("mcp: a server refusing the connection needs sign-in, and a new credential reconnects it once", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const remote = raw({ unauthorized: true });

	const model = scripted();
	const result = await Effect.gen(function* () {
		const url = yield* listen(remote.handler);
		yield* Effect.promise(() => write(join(home, "mcp.json"), { mcpServers: { remote: { url: url.href } } }));
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const attempts = () => remote.seen.filter((request) => request === "POST /mcp").length;

		yield* main.run("one");
		const first = { status: yield* mcp.status(main.id), attempts: attempts() };
		// Nothing changed: the turn does not try again.
		yield* main.run("two");
		const unchanged = attempts();
		// A sign-in, in this process or another, stores a credential: the next turn reconnects once.
		yield* McpOAuth.store(home).update("remote", McpOAuth.key({ name: "remote", url: url.href }), (state) => ({
			...state,
			tokens: { access_token: "e2e-token", token_type: "Bearer" },
		}));
		yield* main.run("three");
		const afterSignIn = attempts();
		yield* main.run("four");
		return { first, unchanged, afterSignIn, settled: attempts(), events: seen.read() };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm: model.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.first.status[0]?.state).toBe("authenticate");
	expect(result.unchanged).toBe(result.first.attempts);
	expect(result.afterSignIn).toBeGreaterThan(result.unchanged);
	expect(result.settled).toBe(result.afterSignIn);
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.thread.authenticate.json",
	);
}, 60_000);

it("mcp: an instance that idles out tells the threads still using it", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	await write(join(home, "mcp.json"), { mcpServers: { idle: stdio() } });

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all[0]?.state));
		// The turn's drain ends with it; nothing holds the instance after that.
		yield* main.run("one");
		const afterTurn = yield* stateOf;
		const idled = yield* waitFor(stateOf, (state) => state === "disconnected");
		const events = yield* waitFor(
			Effect.sync(() => seen.read()),
			(read) => read.main?.idle?.at(-1)?.state === "disconnected",
		);
		return { afterTurn, idled, events };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm: model.open,
				mcpIdleTimeout: "500 millis",
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.afterTurn).toBe("connected");
	expect(result.idled).toBe("disconnected");
	expect(result.events.main?.idle?.at(-1)?.state).toBe("disconnected");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.thread.idle.json");
}, 60_000);

/** The tools the model was declared in its latest request. */
const declaredIn = (model: ReturnType<typeof scripted>) =>
	(model.requests.at(-1)?.context.tools ?? []).map((tool) => tool.name);

it("mcp: toolsearch turns itself on while deferred tools exist, unless settings turn it off", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	const settings = (entry?: { readonly enabled: boolean }) =>
		write(join(home, "settings.jsonc"), {
			plugins: entry === undefined ? [] : [{ plugin: toolSearchPlugin.id, ...entry }],
		});
	const servers = (mcpServers: Record<string, unknown>) => write(join(home, "mcp.json"), { mcpServers });
	await settings();
	await servers({});

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "lazy")?.state));
		const offered = (prompt: string) =>
			main.run(prompt).pipe(Effect.map(() => declaredIn(model).includes(TOOL_SEARCH_NAME)));

		const nothingDeferred = yield* offered("one");
		// A server configured with deferred tools turns toolsearch on before it connects.
		yield* Effect.promise(() => servers({ lazy: stdio({ exposure: "deferred" }, { E2E_HOLD: hold }) }));
		const whileConnecting = yield* offered("two");
		yield* Effect.promise(() => settings({ enabled: false }));
		const disabledWhileConnecting = yield* offered("three");
		const connectingState = yield* stateOf;
		yield* Effect.promise(() => settings());
		yield* Effect.promise(() => fs.rm(hold));
		yield* waitFor(stateOf, (state) => state === "connected");
		const deferredRegistered = yield* offered("four");
		yield* Effect.promise(() => settings({ enabled: false }));
		const disabled = yield* offered("five");
		yield* Effect.promise(() => Promise.all([settings({ enabled: true }), servers({})]));
		const enabledWithNothingDeferred = yield* offered("six");
		yield* Effect.promise(() => settings());
		const entryRemoved = yield* offered("seven");
		return {
			nothingDeferred,
			whileConnecting,
			disabledWhileConnecting,
			connectingState,
			deferredRegistered,
			disabled,
			enabledWithNothingDeferred,
			entryRemoved,
		};
	}).pipe(
		Effect.provide(Harness.layer({ home, hostCwd: dir.path, database: ":memory:", llm: model.open })),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result).toEqual({
		nothingDeferred: false,
		whileConnecting: true,
		disabledWhileConnecting: false,
		connectingState: "connecting",
		deferredRegistered: true,
		disabled: false,
		enabledWithNothingDeferred: true,
		entryRemoved: false,
	});
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.toolsearch.activation.json",
	);
}, 60_000);

it("mcp: toolsearch stays declared, with the same tools, while a deferred-only server fails and disconnects", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	// Held at first, then the gate makes it exit: connecting, then failed.
	const hold = join(dir.path, "hold");
	const gate = join(dir.path, "gate");
	await fs.writeFile(hold, "held");
	await fs.writeFile(gate, "closed");
	await write(join(home, "mcp.json"), {
		mcpServers: { flaky: stdio({ exposure: "deferred" }, { E2E_HOLD: hold, E2E_GATE: gate }) },
	});

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "flaky")?.state));
		const states: Array<string | undefined> = [];

		yield* main.run("one");
		states.push(yield* stateOf);
		yield* Effect.promise(() => fs.rm(hold));
		yield* waitFor(stateOf, (state) => state === "failed");
		// A search finds nothing to wait for on a failed server, and the request after it keeps the tools.
		model.turn(main.id, [pendingCall(TOOL_SEARCH_NAME, { query: "echo text greeting" }, "search")]);
		yield* main.run("two");
		states.push(yield* stateOf);
		yield* mcp.disconnect(main.id, "flaky");
		yield* main.run("three");
		states.push(yield* stateOf);
		return {
			states,
			requests: model.requests.map((request) => (request.context.tools ?? []).map((tool) => tool.name)),
			calls: yield* results(main),
		};
	}).pipe(
		Effect.provide(Harness.layer({ home, hostCwd: dir.path, database: ":memory:", llm: model.open })),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.states).toEqual(["connecting", "failed", "disconnected"]);
	expect(result.requests).toHaveLength(4);
	for (const tools of result.requests) expect(tools).toEqual(result.requests[0]);
	expect(result.requests[0]).toContain(TOOL_SEARCH_NAME);
	expect(result.calls.search).toBe("No matching tools found.");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.toolsearch.stable.json",
	);
}, 60_000);

it("mcp: toolsearch waits for a connecting server and finds its deferred tools, which the next request offers", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	await write(join(home, "mcp.json"), {
		mcpServers: { slow: stdio({ exposure: "deferred" }, { E2E_HOLD: hold }) },
	});

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const events = yield* Event.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "slow")?.state));
		const searching = yield* Deferred.make<void>();
		yield* events.listen((event) =>
			event.type === EventList.ToolStarted.type &&
			(event as unknown as EventList.ToolStarted).data.name === TOOL_SEARCH_NAME
				? Deferred.succeed(searching, undefined)
				: Effect.void,
		);
		// The hold is released only once the search is running, so it is waiting on the server.
		const released = yield* Deferred.await(searching).pipe(
			Effect.andThen(Effect.sleep("200 millis")),
			Effect.andThen(stateOf),
			Effect.tap(() => Effect.promise(() => fs.rm(hold))),
			Effect.forkChild,
		);

		model.turn(
			main.id,
			[pendingCall(TOOL_SEARCH_NAME, { query: "echo text greeting" }, "search")],
			[pendingCall("mcp__slow__echo", { text: "found" }, "echo")],
		);
		yield* main.run("one");
		const [first, second] = model.requests;
		return {
			stateWhenReleased: yield* Fiber.join(released),
			firstDeclared: (first?.context.tools ?? []).map((tool) => tool.name),
			secondChanges: changes(second?.context.messages ?? []),
			calls: yield* results(main),
			loaded: (yield* Document.Service.use((documents) => documents.agent(main.id))).modelTools,
		};
	}).pipe(
		Effect.provide(Harness.layer({ home, hostCwd: dir.path, database: ":memory:", llm: model.open })),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.stateWhenReleased).toBe("connecting");
	expect(result.firstDeclared).toContain(TOOL_SEARCH_NAME);
	expect(result.firstDeclared).not.toContain("mcp__slow__echo");
	expect(result.calls.search).toContain("mcp__slow__echo");
	expect(result.secondChanges.at(-1)?.added).toContain("mcp__slow__echo");
	expect(result.calls.echo).toBe("hello: found");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.toolsearch.connecting.json",
	);
}, 60_000);

it("mcp: toolsearch stops waiting for a server that never answers, at the startup wait or an interrupt", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	// Never released: the server stays connecting for the whole test.
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	await write(join(home, "mcp.json"), {
		mcpServers: { stuck: stdio({ exposure: "deferred" }, { E2E_HOLD: hold }) },
	});

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const events = yield* Event.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "stuck")?.state));
		const searching = yield* Deferred.make<void>();
		yield* events.listen((event) =>
			event.type === EventList.ToolStarted.type &&
			(event as unknown as EventList.ToolStarted).data.name === TOOL_SEARCH_NAME
				? Deferred.succeed(searching, undefined)
				: Effect.void,
		);
		const elapsed = <A, E, R>(self: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const start = Date.now();
				yield* self;
				return Date.now() - start;
			});

		// Interrupted while it waits: the call ends with the turn, long before the startup wait.
		model.turn(main.id, [pendingCall(TOOL_SEARCH_NAME, { query: "echo text greeting" }, "interrupted")]);
		const interrupter = yield* Deferred.await(searching).pipe(
			Effect.andThen(Effect.sleep("200 millis")),
			Effect.andThen(main.interrupt()),
			Effect.forkChild,
		);
		const interruptedAfter = yield* elapsed(main.run("one").pipe(Effect.exit));
		const interrupted = yield* Fiber.join(interrupter);

		// Left alone, the wait gives up after the startup wait and searches what there is.
		model.clear(main.id);
		model.turn(main.id, [pendingCall(TOOL_SEARCH_NAME, { query: "echo text greeting" }, "bounded")]);
		const boundedAfter = yield* elapsed(main.run("two"));
		return {
			interrupted,
			interruptedQuickly: interruptedAfter < 5_000,
			boundedWaited: boundedAfter >= 9_000 && boundedAfter < 20_000,
			calls: yield* results(main),
			stillConnecting: yield* stateOf,
		};
	}).pipe(
		Effect.provide(Harness.layer({ home, hostCwd: dir.path, database: ":memory:", llm: model.open })),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.interrupted).toBe(true);
	expect(result.interruptedQuickly).toBe(true);
	expect(result.boundedWaited).toBe(true);
	expect(result.calls.bounded).toBe("No matching tools found.");
	expect(result.stillConnecting).toBe("connecting");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.toolsearch.bounded.json",
	);
}, 60_000);
