import "./utils/env.ts";
import { Effect, Exit, Fiber } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import {
	alive,
	elapsed,
	results,
	scripted,
	startedPids,
	statusEvents,
	stdio,
	waitFor,
	write,
} from "./fixtures/mcp/turns.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const model = { provider: "openai", id: "gpt-5.6-luna" } as const;

const artifact = (result: unknown, dir: string) =>
	`${JSON.stringify(JSON.parse(JSON.stringify(result).replaceAll(dir, "<tmp>")), null, "\t")}\n`;

it("mcp: disconnecting, or deleting the session, while the first connect runs stops it for good", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	// Each start waits while `hold` exists, so the first turn finds the server connecting.
	const hold = join(dir.path, "hold");
	const starts = join(dir.path, "starts");
	await write(join(home, "mcp.json"), { mcpServers: { held: stdio({}, { E2E_HOLD: hold, E2E_STARTS: starts }) } });

	const scriptedModel = scripted();
	const result = await Effect.gen(function* () {
		const mcp = yield* Mcp.Service;
		const labels = new Map<string, string>();
		const seen = yield* statusEvents((threadId) => labels.get(threadId) ?? threadId);
		const pids = Effect.promise(() => startedPids(starts));
		/** Starts a session's first turn, and waits until its server process is up and holding. */
		const holding = Effect.fnUntraced(function* (label: string, count: number) {
			yield* Effect.promise(() => fs.writeFile(hold, "held"));
			const session = yield* Session.create({ directory: work, model });
			labels.set(session.main.id, label);
			const turn = yield* elapsed(session.main.run("one")).pipe(Effect.exit, Effect.forkChild);
			const pid = (yield* waitFor(pids, (all) => all.length === count))[count - 1]!;
			const state = (yield* mcp.status(session.main.id))[0]?.state;
			return { session, turn, pid, state };
		});
		/** The process is gone, and releasing the hold starts nothing. */
		const halted = Effect.fnUntraced(function* (pid: number) {
			const exited = !(yield* waitFor(
				Effect.sync(() => alive(pid)),
				(running) => !running,
			));
			yield* Effect.promise(() => fs.rm(hold));
			yield* Effect.sleep("300 millis");
			return { exited, starts: (yield* pids).length };
		});

		const first = yield* holding("disconnected", 1);
		const disconnected = yield* mcp.disconnect(first.session.main.id, "held");
		const afterDisconnect = yield* halted(first.pid);
		const firstTurn = yield* Fiber.join(first.turn);
		// A later turn neither restarts it nor offers its tools.
		yield* first.session.main.run("two");
		const later = {
			status: yield* mcp.status(first.session.main.id),
			starts: (yield* pids).length,
			declared: scriptedModel.declared().filter((name) => name.startsWith("mcp__")),
		};

		const second = yield* holding("removed", 2);
		yield* Session.remove(second.session.id);
		const afterRemove = yield* halted(second.pid);
		const secondTurn = yield* Fiber.join(second.turn);
		return {
			disconnect: {
				stateWhileHeld: first.state,
				disconnected,
				...afterDisconnect,
				// The turn stopped waiting as soon as the attempt was stopped, long before the startup wait.
				turnEndedEarly: Exit.isSuccess(firstTurn) && firstTurn.value < 5_000,
				later,
			},
			remove: {
				stateWhileHeld: second.state,
				...afterRemove,
				// Deleting the session stops its turn, long before the startup wait.
				turnEndedEarly: Exit.isSuccess(secondTurn) && secondTurn.value < 5_000,
				status: yield* mcp.status(second.session.main.id),
			},
			events: seen.read(),
		};
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm: scriptedModel.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.disconnect).toMatchObject({
		stateWhileHeld: "connecting",
		exited: true,
		starts: 1,
		turnEndedEarly: true,
		later: { starts: 1, declared: [] },
	});
	expect(result.disconnect.disconnected.state).toBe("disconnected");
	expect(result.disconnect.later.status[0]?.state).toBe("disconnected");
	expect(result.remove).toMatchObject({
		stateWhileHeld: "connecting",
		exited: true,
		starts: 2,
		turnEndedEarly: true,
		status: [],
	});
	await expect(artifact(result, dir.path)).toMatchFileSnapshot("./__artifacts__/mcp.startup.halted.json");
}, 60_000);

it("mcp: a changed or removed server stops its process, also while its first connect runs", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const hold = join(dir.path, "hold");
	const starts = join(dir.path, "starts");
	const configure = (servers: Record<string, unknown>) => write(join(home, "mcp.json"), { mcpServers: servers });
	const server = (greeting: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => ({
		srv: stdio(extra, { E2E_STARTS: starts, E2E_GREETING: greeting, ...env }),
	});
	await configure(server("one"));

	const scriptedModel = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model });
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const pids = Effect.promise(() => startedPids(starts));
		const exited = (pid: number) =>
			waitFor(
				Effect.sync(() => alive(pid)),
				(running) => !running,
			).pipe(Effect.map((running) => !running));
		const status = mcp.status(main.id).pipe(Effect.map((all) => all.map(({ server, state }) => ({ server, state }))));

		scriptedModel.turn(main.id, [pendingCall("mcp__srv__echo", { text: "x" }, "one")]);
		yield* main.run("one");
		// Its environment changed: a new instance, and the old process stops.
		yield* Effect.promise(() => configure(server("two")));
		scriptedModel.turn(main.id, [pendingCall("mcp__srv__echo", { text: "x" }, "two")]);
		yield* main.run("two");
		const [one, two] = yield* pids;
		const changed = { oldExited: yield* exited(one!), status: yield* status };

		// Removed from `mcp.json`: its process stops.
		yield* Effect.promise(() => configure({}));
		yield* main.run("three");
		const removed = { exited: yield* exited(two!), status: yield* status };

		// Back, held while it starts; deferred, so the turn does not wait for it.
		yield* Effect.promise(() => fs.writeFile(hold, "held"));
		yield* Effect.promise(() => configure(server("three", { exposure: "deferred" }, { E2E_HOLD: hold })));
		yield* main.run("four");
		const three = (yield* waitFor(pids, (all) => all.length === 3))[2]!;
		const stateWhileHeld = (yield* status)[0]?.state;
		// Changed while its first connect runs: the held attempt stops, and the new instance answers.
		yield* Effect.promise(() => configure(server("four")));
		scriptedModel.turn(main.id, [pendingCall("mcp__srv__echo", { text: "x" }, "four")]);
		yield* main.run("five");
		const supersededExited = yield* exited(three);
		yield* Effect.promise(() => fs.rm(hold));
		yield* Effect.sleep("300 millis");
		scriptedModel.turn(main.id, [pendingCall("mcp__srv__echo", { text: "x" }, "after-release")]);
		yield* main.run("six");
		const all = yield* pids;
		return {
			changed,
			removed,
			superseded: {
				stateWhileHeld,
				exited: supersededExited,
				starts: all.length,
				newAlive: alive(all[3]!),
				status: yield* status,
			},
			calls: yield* results(main),
			events: seen.read(),
		};
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm: scriptedModel.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.changed.oldExited).toBe(true);
	expect(result.removed).toEqual({ exited: true, status: [] });
	expect(result.superseded).toMatchObject({ stateWhileHeld: "connecting", exited: true, starts: 4, newAlive: true });
	expect(result.superseded.status).toEqual([{ server: "srv", state: "connected" }]);
	expect(result.calls).toEqual({ one: "one: x", two: "two: x", four: "four: x", "after-release": "four: x" });
	await expect(artifact(result, dir.path)).toMatchFileSnapshot("./__artifacts__/mcp.startup.replaced.json");
}, 60_000);

it("mcp: a turn waits for a server with direct tools only up to the startup wait, and the next one offers them", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	await write(join(home, "mcp.json"), { mcpServers: { stuck: stdio({}, { E2E_HOLD: hold }) } });

	const scriptedModel = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model });
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all[0]?.state));
		const declared = () => scriptedModel.declared().filter((name) => name.startsWith("mcp__"));

		const waited = yield* elapsed(main.run("one"));
		const first = { declared: declared(), state: yield* stateOf };
		yield* Effect.promise(() => fs.rm(hold));
		yield* waitFor(stateOf, (state) => state === "connected");
		scriptedModel.turn(main.id, [pendingCall("mcp__stuck__echo", { text: "late" }, "late")]);
		const nextWaited = yield* elapsed(main.run("two"));
		return {
			boundedWait: waited >= 9_000 && waited < 20_000,
			first,
			nextDidNotWait: nextWaited < 5_000,
			next: { declared: scriptedModel.requests[1]?.context.tools?.some((tool) => tool.name === "mcp__stuck__echo") },
			calls: yield* results(main),
			events: seen.read(),
		};
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm: scriptedModel.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.boundedWait).toBe(true);
	expect(result.first).toEqual({ declared: [], state: "connecting" });
	expect(result.nextDidNotWait).toBe(true);
	expect(result.next.declared).toBe(true);
	expect(result.calls.late).toBe("hello: late");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.startup.bounded.json",
	);
}, 60_000);
