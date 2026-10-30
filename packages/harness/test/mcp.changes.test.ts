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
	await write(join(home, "mcp.json"), { mcpServers: { live: stdio({}, {}, "changes.mjs") } });

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
		// The slow first listing of the burst answers 500 ms after it was asked, well after the fresh one.
		const afterBurst = yield* waitFor(tools, (names) => names.includes("fresh"));
		yield* Effect.sleep("800 millis");
		const settled = yield* tools;

		yield* main.run("three");
		return {
			declared: { first: declaredAt(0), second: declaredAt(1), last: model.declared() },
			afterSwap,
			afterBurst,
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
	expect(result.settled).toEqual(["swap", "burst", "new", "fresh"]);
	expect(result.declared.last).toContain("mcp__live__fresh");
	const published = (result.events.main?.live ?? []).flatMap((status) => ("tools" in status ? status.tools : []));
	expect(published).not.toContain("stale");
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.changes.json");
}, 60_000);
