import "./utils/env.ts";
import { Effect, Logger } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { listen, raw } from "./fixtures/mcp/http.ts";
import { results, scripted, statusEvents, stdio, write } from "./fixtures/mcp/turns.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

it("mcp: a blank cursor ends every list, and a header fetch rejects is reported without its name or value", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });

	const remote = raw();
	const warnings: string[] = [];
	const collector = Logger.make(({ logLevel, message }) => {
		if (logLevel === "Warn") warnings.push(JSON.stringify(message));
	});
	const model = scripted();
	const result = await Effect.gen(function* () {
		const url = yield* listen(remote.handler);
		yield* Effect.promise(() =>
			write(join(home, "mcp.json"), {
				mcpServers: {
					paged: stdio({}, { MCP_FIXTURE: "blank" }, "server.mjs"),
					// fetch rejects the name with a TypeError that carries no system code.
					bad: { url: url.href, headers: { "bad name": "s3cret-value" } },
				},
			}),
		);
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const main = session.main;
		const seen = yield* statusEvents((threadId) => (threadId === main.id ? "main" : threadId));
		model.turn(main.id, [
			pendingCall("list_mcp_resources", { server: "paged" }, "resources-page"),
			pendingCall("list_mcp_resources", { server: "paged", cursor: "page-2" }, "resources-next"),
			pendingCall("list_mcp_resources", {}, "resources-all"),
			pendingCall("list_mcp_resource_templates", { server: "paged" }, "templates-page"),
			pendingCall("list_mcp_resource_templates", { server: "paged", cursor: "page-2" }, "templates-next"),
			pendingCall("list_mcp_resource_templates", {}, "templates-all"),
			pendingCall("list_mcp_resources", { server: "bad" }, "bad-resources"),
		]);
		yield* main.run("List.");
		const status = yield* Mcp.Service.use((mcp) => mcp.status(main.id));
		const log = yield* Effect.promise(() => fs.readFile(join(home, "mcp.log"), "utf8").catch(() => ""));
		return {
			declared: model.declared(),
			calls: yield* results(main),
			status,
			events: seen.read(),
			// Timestamps vary; the rest of each line is fixed.
			log: log
				.split("\n")
				.filter(Boolean)
				.map((line) => line.replace(/^\S+ /, "")),
			requests: JSON.stringify(model.requests),
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
		Effect.provide(Logger.layer([collector])),
		Effect.runPromise,
	);

	const json = (id: string) => JSON.parse(result.calls[id] ?? "null") as Record<string, unknown>;
	expect(result.declared.filter((name) => name.startsWith("mcp__paged__"))).toEqual([
		"mcp__paged__first",
		"mcp__paged__second",
	]);
	expect(json("resources-page").nextCursor).toBe("page-2");
	expect(json("resources-next")).not.toHaveProperty("nextCursor");
	expect(json("resources-all")).not.toHaveProperty("errors");
	expect(json("templates-next")).not.toHaveProperty("nextCursor");
	expect(json("templates-all")).not.toHaveProperty("errors");

	const bad = result.status.find((one) => one.server === "bad");
	expect(bad).toMatchObject({ state: "failed", error: "invalid request (TypeError)" });
	// The request never left the client.
	expect(remote.seen).toEqual([]);
	const { requests, ...rest } = result;
	for (const text of [JSON.stringify(rest), requests, ...warnings]) {
		expect(text).not.toContain("s3cret");
		expect(text).not.toContain("bad name");
	}
	const badWarnings = warnings.filter((line) => line.includes('"bad"'));
	await expect(`${JSON.stringify({ ...rest, warnings: badWarnings }, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp-review-followups.json",
	);
}, 60_000);
