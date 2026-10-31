import "./utils/env.ts";
import { Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import type { LLM } from "../src/runner/llm.ts";
import { changes, scripted, stdio, toolSearch, waitFor, write } from "./fixtures/mcp/turns.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

it("mcp: a server that connects mid-run gets its summary in the mcpservers section at the next prompt, and leaves it once disconnected", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	// The server answers its handshake only once `hold` is gone, so the first request finds it connecting.
	const hold = join(dir.path, "hold");
	await fs.writeFile(hold, "held");
	await write(join(home, "mcp.json"), {
		mcpServers: {
			atlas: stdio(
				{ exposure: "deferred" },
				{ E2E_HOLD: hold, E2E_INSTRUCTIONS: "Tide tables for coastal towns.\nCall the echo tool to test." },
			),
		},
	});

	const model = scripted();
	let connected: Effect.Effect<unknown> = Effect.void;
	// The first request lets the server connect, and goes out once it has.
	const open: LLM.Open = (input, signal) =>
		Effect.andThen(
			model.requests.length === 0
				? Effect.andThen(
						Effect.promise(() => fs.rm(hold)),
						connected,
					)
				: Effect.void,
			model.open(input, signal),
		);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const mcp = yield* Mcp.Service;
		connected = waitFor(mcp.status(main.id), (all) => all.some((one) => one.state === "connected"));
		// The run's second request follows a search, with the server connected by then.
		model.turn(main.id, [pendingCall("toolsearch", { query: "echo" }, "search")]);
		yield* main.run("one");
		yield* main.wait();
		model.turn(main.id);
		yield* main.run("two");
		yield* main.wait();
		// Disconnected on request, it has nothing to search: the next prompt removes the section.
		yield* mcp.disconnect(main.id, "atlas");
		model.turn(main.id);
		yield* main.run("three");
		yield* main.wait();
		const last = model.requests.at(-1)!.context.messages;
		return {
			// Per request: how many system messages it carries.
			systems: model.requests.map(
				(request) => request.context.messages.filter((message) => message.role === "system").length,
			),
			changes: changes(last),
			mcpservers: last.flatMap((message) =>
				message.role === "system" && message.sections?.mcpservers !== undefined
					? [message.sections.mcpservers]
					: [],
			),
		};
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin, ...toolSearch],
				llm: open,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	expect(result.systems).toEqual([1, 2, 3, 4]);
	expect(result.changes.map((change) => change.sections)).toEqual([
		["tools", "rules", "cwd", "mcpservers"],
		[],
		["mcpservers"],
		["mcpservers"],
	]);
	expect(result.mcpservers.at(-1)).toBeNull();
	await expect(`${JSON.stringify(result, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.section.json");
});
