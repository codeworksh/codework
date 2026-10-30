import "./utils/env.ts";
import { Deferred, Effect, Fiber } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Event } from "../src/event/event.ts";
import { EventList } from "../src/event/list.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { define } from "../src/plugin/plugin.ts";
import { type Answer, listen, raw } from "./fixtures/mcp/http.ts";
import { results, scripted, statusEvents, stdio, waitFor, write } from "./fixtures/mcp/turns.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const model = { provider: "openai", id: "gpt-5.6-luna" } as const;

/** A harness whose threads run the MCP servers the test sets for each of them between turns. */
const harness = async (dir: string) => {
	const home = join(dir, "home");
	const work = join(dir, "work");
	await fs.mkdir(work, { recursive: true });
	await write(join(home, "mcp.json"), { mcpServers: {} });
	const servers = new Map<string, Record<string, unknown>>();
	const plugin = define({
		id: "test.mcp.race",
		kind: "mcp",
		setup: (ctx) => {
			for (const [name, config] of Object.entries(servers.get(ctx.threadId) ?? {}))
				ctx.plugin.mcp.set(name, config as Parameters<typeof ctx.plugin.mcp.set>[1]);
		},
	});
	const model = scripted();
	const layer = Harness.layer({
		home,
		hostCwd: dir,
		database: ":memory:",
		plugins: [plugin, defaultPromptPlugin],
		llm: model.open,
	});
	return { work, servers, model, layer };
};

/**
 * Holds the first `mcp.server.status` of `server` published to the thread `threadId()` names: `held`
 * settles once it is held, and the publish goes on once `release` does, unless it was interrupted.
 */
const holdStatus = (threadId: () => string | undefined, server: string) =>
	Effect.gen(function* () {
		const held = yield* Deferred.make<void>();
		const release = yield* Deferred.make<void>();
		let done = false;
		const events = yield* Event.Service;
		yield* events.listen((event) => {
			if (done || event.type !== EventList.McpServerStatus.type) return Effect.void;
			const data = (event as unknown as EventList.McpServerStatus).data;
			if (data.threadId !== threadId() || data.status.server !== server) return Effect.void;
			done = true;
			return Effect.andThen(Deferred.succeed(held, undefined), Deferred.await(release));
		});
		return { held, release };
	});

it("mcp: a turn interrupted while it tells a thread about an instance it joined still starts the ones it created", async () => {
	await using dir = await tmpdir();
	const { work, servers, layer } = await harness(dir.path);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		let siblingId: string | undefined;
		const seen = yield* statusEvents((threadId) =>
			threadId === main.id ? "main" : threadId === siblingId ? "sibling" : threadId,
		);
		const stateOf = mcp.status(main.id).pipe(Effect.map((all) => all.find((one) => one.server === "fresh")?.state));

		servers.set(main.id, { shared: stdio() });
		yield* main.run("one");
		const line = yield* main.history();
		const sibling = (yield* main.fork({ entryId: line.at(-1)!.entry.id })).thread;
		siblingId = sibling.id;
		// The sibling joins `shared`, which main started, and creates `fresh`; its turn is interrupted
		// while it is told where `shared` stands.
		servers.set(sibling.id, { shared: stdio(), fresh: stdio() });
		const { held } = yield* holdStatus(() => siblingId, "shared");
		const turn = yield* sibling.run("one").pipe(Effect.exit, Effect.forkChild);
		yield* Deferred.await(held);
		yield* sibling.interrupt();
		yield* Fiber.join(turn);

		// Main reuses the instance of `fresh` the interrupted turn created, which must have started.
		servers.set(main.id, { shared: stdio(), fresh: stdio() });
		yield* main.run("two");
		const fresh = yield* waitFor(stateOf, (state) => state === "connected");
		return { fresh, events: seen.read() };
	}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

	expect(result.fresh).toBe("connected");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.race.started.json");
}, 60_000);

it("mcp: an instance its last thread left closes at once, so a thread joining it then gets a new one", async () => {
	await using dir = await tmpdir();
	const { work, servers, layer } = await harness(dir.path);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		let siblingId: string | undefined;
		const seen = yield* statusEvents((threadId) =>
			threadId === main.id ? "main" : threadId === siblingId ? "sibling" : threadId,
		);

		servers.set(main.id, { x: stdio() });
		yield* main.run("one");
		const line = yield* main.history();
		const sibling = (yield* main.fork({ entryId: line.at(-1)!.entry.id })).thread;
		siblingId = sibling.id;
		servers.set(sibling.id, { y: stdio() });
		yield* sibling.run("one");

		// Main leaves `x`, its only user, and joins `y`; its turn is held while it is told where `y` stands.
		servers.set(main.id, { y: stdio() });
		const { held, release } = yield* holdStatus(() => main.id, "y");
		const turn = yield* main.run("two").pipe(Effect.forkChild);
		yield* Deferred.await(held);
		// Meanwhile the sibling starts using `x`, with the same settings.
		servers.set(sibling.id, { y: stdio(), x: stdio() });
		yield* sibling.run("two");
		yield* Deferred.succeed(release, undefined);
		yield* Fiber.join(turn);
		// A close left pending by main's turn would land about now.
		yield* Effect.sleep("300 millis");
		const status = yield* mcp.status(sibling.id);
		return { sibling: status.map(({ server, state }) => ({ server, state })), events: seen.read() };
	}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

	expect(result.sibling).toEqual([
		{ server: "y", state: "connected" },
		{ server: "x", state: "connected" },
	]);
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.race.closed.json");
}, 60_000);

it("mcp: a call that fails needing sign-in after a disconnect leaves the server disconnected", async () => {
	await using dir = await tmpdir();
	const { work, servers, model: llm, layer } = await harness(dir.path);
	let answer: (value: Answer | undefined) => void = () => undefined;
	const answered = new Promise<Answer | undefined>((resolve) => (answer = resolve));
	let arrived = () => {};
	const arrival = new Promise<void>((resolve) => (arrived = resolve));
	const remote = raw({
		script: (request) => {
			if (request !== "POST tools/call") return undefined;
			arrived();
			return { after: answered };
		},
	});

	const result = await Effect.gen(function* () {
		const url = yield* listen(remote.handler);
		const session = yield* Session.create({ directory: work, model });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		// A credential the harness supplies: a 401 means it needs sign-in.
		servers.set(main.id, { remote: { url: url.href, auth: { provider: "openai" } } });
		llm.turn(main.id, [pendingCall("mcp__remote__echo", {}, "held")]);
		const turn = yield* main.run("one").pipe(Effect.forkChild);
		yield* Effect.promise(() => arrival);
		const disconnected = yield* mcp.disconnect(main.id, "remote");
		answer({ status: 401, body: "unauthorized" });
		yield* Fiber.join(turn);
		const status = (yield* mcp.status(main.id))[0];
		return {
			disconnected: disconnected.state,
			after: status?.state,
			calls: yield* results(main),
			events: seen.read(),
		};
	}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise);

	expect(result.disconnected).toBe("disconnected");
	expect(result.after).toBe("disconnected");
	await expect(
		`${JSON.stringify(result, null, "\t").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")}\n`,
	).toMatchFileSnapshot("./__artifacts__/mcp.race.signin.json");
}, 60_000);
