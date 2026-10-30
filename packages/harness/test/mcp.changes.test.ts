import "./utils/env.ts";
import { Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { results, scripted, statusEvents, stdio, waitFor, write } from "./fixtures/mcp/turns.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

it("mcp: a changed tool list applies from the next request, a withdrawn tool says so, and only the latest listing counts", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	const release = join(dir.path, "release");
	await write(join(home, "mcp.json"), { mcpServers: { live: stdio({}, { E2E_RELEASE: release }, "changes.mjs") } });

	const model = scripted();
	const result = await Effect.gen(function* () {
		// Calls of one reply run in order, so the second call of a reply runs after the first changed the list.
		const session = yield* Session.create({
			directory: work,
			model: { provider: "openai", id: "gpt-5.6-luna" },
			tools: { execution: "sequential" },
		});
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const tools = mcp
			.status(main.id)
			.pipe(Effect.map((all) => (all.find((one) => one.server === "live")?.tools ?? []).map((tool) => tool.name)));
		const declaredAt = (request: number) => model.requests[request]?.context.tools?.map((tool) => tool.name) ?? [];

		// `old` was declared with the request that calls it, and is gone by the time it runs. The next
		// request declares the new list, and no longer knows `old`.
		model.turn(
			main.id,
			[pendingCall("mcp__live__swap", {}, "swap"), pendingCall("mcp__live__old", {}, "withdrawn")],
			[pendingCall("mcp__live__old", {}, "undeclared")],
		);
		yield* main.run("one");
		const afterSwap = yield* tools;

		model.turn(main.id, [pendingCall("mcp__live__new", {}, "new")], [pendingCall("mcp__live__burst", {}, "burst")]);
		yield* main.run("two");
		// The second change arrived while the listing of the first was held. Listings run one at a time,
		// so the one with `fresh` follows; only that latest one is taken in.
		const whileHeld = yield* tools;
		yield* Effect.promise(() => fs.writeFile(release, ""));
		const settled = yield* waitFor(tools, (names) => names.includes("fresh"));
		yield* main.run("three");
		return {
			declared: { first: declaredAt(0), second: declaredAt(1), last: model.declared() },
			afterSwap,
			whileHeld,
			settled,
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
				llm: model.open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.declared.first).toEqual(["mcp__live__old", "mcp__live__swap", "mcp__live__burst"]);
	expect(result.calls.withdrawn).toBe('MCP tool "live/old" is no longer available.');
	expect(result.declared.second).toEqual(["mcp__live__swap", "mcp__live__burst", "mcp__live__new"]);
	expect(result.calls.undeclared).toBe("Unknown Tool: mcp__live__old");
	expect(result.calls.new).toBe("new");
	expect(result.whileHeld).toEqual(["swap", "burst", "new"]);
	expect(result.settled).toEqual(["swap", "burst", "new", "fresh"]);
	expect(result.declared.last).toContain("mcp__live__fresh");
	const published = (result.events.main?.live ?? []).flatMap((status) => ("tools" in status ? status.tools : []));
	expect(published).not.toContain("stale");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.changes.json");
}, 60_000);

it("mcp: tools the SDK rejects are skipped, reported on the status and logged, and a refresh updates them", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	await write(join(home, "mcp.json"), {
		mcpServers: { odd: stdio({}, { MCP_MALFORMED: "skipped" }, "malformed.mjs") },
	});

	const model = scripted();
	const result = await Effect.gen(function* () {
		const session = yield* Session.create({
			directory: work,
			model: { provider: "openai", id: "gpt-5.6-luna" },
			tools: { execution: "sequential" },
		});
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		const mcp = yield* Mcp.Service;
		const status = mcp.status(main.id).pipe(Effect.map((all) => all[0]));

		model.turn(main.id, [
			pendingCall("mcp__odd__good", {}, "good"),
			pendingCall("mcp__odd__scalar", {}, "scalar"),
			pendingCall("mcp__odd__bare", {}, "bare"),
		]);
		yield* main.run("one");
		const first = { declared: model.declared(), status: yield* status };

		// `fix` repairs `bad` and offers `worse`, which the SDK rejects.
		model.turn(main.id, [pendingCall("mcp__odd__fix", {}, "fix")]);
		yield* main.run("two");
		const refreshed = yield* waitFor(status, (one) => one?.skipped?.names.includes("worse") === true);
		yield* main.run("three");
		const log = yield* Effect.promise(() => fs.readFile(join(home, "mcp.log"), "utf8"));
		return {
			first,
			refreshed: { declared: model.declared(), status: refreshed },
			calls: yield* results(main),
			events: seen.read(),
			// Timestamps vary; the rest of each line is fixed.
			log: log
				.split("\n")
				.filter(Boolean)
				.map((line) => line.replace(/^\S+ /, "")),
		};
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

	expect(result.first.status?.state).toBe("connected");
	expect(result.first.status?.skipped).toEqual({ names: ["typed", "bad"], unnamed: 1 });
	expect(result.first.declared).toEqual(["mcp__odd__good", "mcp__odd__scalar", "mcp__odd__bare", "mcp__odd__fix"]);
	expect(result.refreshed.status?.skipped).toEqual({ names: ["typed", "worse"], unnamed: 1 });
	expect(result.refreshed.declared).toContain("mcp__odd__bad");
	expect(result.calls.good).toBe("good");
	expect(result.calls.scalar).toContain("Invalid result for tools/call: structuredContent");
	expect(result.log).toHaveLength(6);
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.changes.skipped.json",
	);
}, 60_000);
