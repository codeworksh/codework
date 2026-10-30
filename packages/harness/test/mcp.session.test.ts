import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { Effect } from "effect";
import fs from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vite-plus/test";
import { ContextCodec } from "../src/context/codec.ts";
import { Harness } from "../src/effect/harness.ts";
import { Session } from "../src/effect/session.ts";
import { Mcp } from "../src/mcp/mcp.ts";
import { defaultPromptPlugin } from "../src/plugin/builtin/prompt/default.ts";
import { define } from "../src/plugin/plugin.ts";
import type { LLM } from "../src/runner/llm.ts";
import { Settings } from "../src/settings/settings.ts";
import { assistant } from "./fixtures/llm.ts";
import { listen, raw } from "./fixtures/mcp/http.ts";
import { tmpdir } from "./fixtures/tempdir.ts";
import { pendingCall } from "./tools.fixture.ts";

const fixture = fileURLToPath(new URL("./fixtures/mcp/session.mjs", import.meta.url));
const stdio = (extra: Record<string, unknown> = {}) => ({
	command: process.execPath,
	args: [fixture],
	env: { E2E_GREETING: "${MCP_E2E_GREETING}" },
	...extra,
});

/** One reply per model request, in order; an empty one ends the turn. */
const scripted =
	(replies: ReadonlyArray<ReadonlyArray<Message.ToolCallPendingPart>>, requests: LLM.Input[]): LLM.Open =>
	(input) =>
		Effect.sync(() => {
			const index = requests.push(input);
			const calls = replies[index - 1] ?? [];
			const message = assistant(input, index, calls.length > 0 ? { stopReason: "toolUse", parts: [...calls] } : {});
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: calls.length > 0 ? "toolUse" : "stop", message });
			return stream;
		});

/** The user and assistant entries of a thread's line, the ones the model reads back. */
const messageEntries = (thread: Session.ThreadHandle) =>
	thread
		.history()
		.pipe(Effect.map((line) => line.filter(({ entry }) => entry.type === "user" || entry.type === "assistant")));

const write = async (file: string, value: unknown) => {
	await fs.mkdir(join(file, ".."), { recursive: true });
	await fs.writeFile(file, JSON.stringify(value, null, 2));
};

it("mcp: config layers, plugin bucket, direct tools, a crash mid-turn and the next call reconnecting", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const project = join(dir.path, "project");
	const work = join(dir.path, "work");
	// A server's own relative `cwd` resolves against the session's directory on a host sandbox.
	await fs.mkdir(join(work, "srv"), { recursive: true });
	process.env.MCP_E2E_GREETING = "hello";
	// A `!command` printing a notice after the token, say: never sent, and never shown.
	process.env.MCP_E2E_BAD_HEADER = "Bearer sk-e2e-secret\nnotice";
	// Unlike a header, a variable may span lines.
	process.env.MCP_E2E_PEM = "-----BEGIN KEY-----\nabc\n-----END KEY-----";

	await write(join(home, "mcp.json"), {
		mcpServers: {
			e2e: stdio({
				cwd: "srv",
				toolExposure: { secret: "hidden" },
				env: { E2E_GREETING: "${MCP_E2E_GREETING}", E2E_PEM: "${MCP_E2E_PEM}" },
			}),
			off: stdio(),
			"my-srv": stdio({ enabled: false }),
			my_srv: stdio(),
			broken: { url: "ftp://example.com/mcp" },
			// The callback must be served on this machine.
			signin: { url: "https://example.com/mcp", oauth: { callbackUrl: "https://example.com/callback" } },
			badheader: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "${MCP_E2E_BAD_HEADER}" } },
			// Codemode and deferred exposures are valid; until codemode exists these tools are simply not declared.
			later: stdio({ exposure: "codemode-deferred" }),
		},
	});
	// The project turns a user server off without restating it, and cannot add an override with no base.
	await write(join(project, ".codework", "mcp.json"), {
		mcpServers: {
			off: { enabled: false },
			ghost: { enabled: false },
			// A repository cannot choose where a user's provider credential goes.
			keyed: { url: "https://example.com/mcp", auth: { provider: "openai" } },
		},
	});

	const observed: { readonly mcpDomain: unknown[]; readonly toolDomain: string[] } = { mcpDomain: [], toolDomain: [] };
	const observer = define({
		id: "test.mcp.observer",
		kind: "mcp",
		setup: (ctx) => {
			observed.mcpDomain.push(ctx.plugin.mcp.list().map(([name, config]) => [name, config.enabled ?? true]));
			ctx.plugin.mcp.update("e2e", { description: "The E2E fixture." });
		},
	});
	const latecomer = define({
		id: "test.mcp.latecomer",
		kind: "tool",
		setup: (ctx) => {
			try {
				ctx.plugin.mcp.remove("e2e");
			} catch (error) {
				observed.toolDomain.push((error as Error).message);
			}
		},
	});

	const requests: LLM.Input[] = [];
	const llm = scripted(
		[
			[
				pendingCall("mcp__e2e__echo", { text: "hi" }, "echo"),
				pendingCall("mcp__e2e__fail", {}, "fail"),
				pendingCall("mcp__e2e__my_tool_v2", {}, "structured"),
				// Strict sampling writes `null` for an omitted optional argument; the server never sees it.
				pendingCall("mcp__e2e__args", { word: "abc", limit: null }, "nulls"),
			],
			[pendingCall("mcp__e2e__pid", {}, "pid-before"), pendingCall("mcp__e2e__crash", {}, "crash")],
			// Same turn: the server is gone, so this call reconnects first.
			[pendingCall("mcp__e2e__pid", {}, "pid-after")],
			[],
			// Next turn: arguments the server's schema rejects never reach it.
			[
				pendingCall("mcp__e2e__echo", {}, "invalid"),
				pendingCall("mcp__e2e__args", { word: "ABC" }, "pattern"),
				pendingCall("mcp__e2e__args", { word: "abc", extra: true }, "excess"),
			],
			[],
			// Third turn: where the server runs, what the model is not shown in full, and resources.
			[
				pendingCall("mcp__e2e__cwd", {}, "cwd"),
				pendingCall("mcp__e2e__link", {}, "link"),
				pendingCall("mcp__e2e__big", {}, "big"),
				pendingCall("list_mcp_resources", {}, "resources-all"),
				pendingCall("list_mcp_resources", { server: "e2e" }, "resources-page"),
				// The server's cursor goes back exactly as it was given, spaces and all.
				pendingCall("list_mcp_resources", { server: "e2e", cursor: " page-2 " }, "resources-next"),
				// Models fill optional strings with "": a blank cursor is no cursor.
				pendingCall("list_mcp_resources", { server: "e2e", cursor: "" }, "resources-blank"),
				pendingCall("list_mcp_resource_templates", {}, "templates"),
				pendingCall("read_mcp_resource", { server: "e2e", uri: "fixture://notes.txt" }, "read-text"),
				pendingCall("read_mcp_resource", { server: "e2e", uri: "fixture://data.bin" }, "read-binary"),
				pendingCall("read_mcp_resource", { server: "nope", uri: "fixture://x" }, "read-unknown"),
			],
			[],
		],
		requests,
	);

	const result = await Effect.gen(function* () {
		const session = yield* Session.create({
			directory: work,
			hostDir: project,
			model: { provider: "openai", id: "gpt-5.6-luna" },
		});
		yield* session.main.run("Use the fixture.");
		yield* session.main.run("Once more.");
		yield* session.main.run("Resources.");
		const messages = yield* Effect.forEach(yield* messageEntries(session.main), ContextCodec.decodeMessage);
		const status = yield* Mcp.Service.use((mcp) => mcp.status(session.main.id));
		const settings = yield* Settings.Service.use((loader) => loader.load(project));
		return { messages, status, errors: settings.mcp.errors };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [observer, latecomer, defaultPromptPlugin],
				llm,
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	const calls = new Map(
		result.messages
			.flatMap((message) => (message.role === "system" ? [] : message.parts))
			.flatMap((part) => (part.type === "toolCall" && "result" in part ? [[part.callID, part] as const] : [])),
	);
	const outcome = (id: string) => {
		const part = calls.get(id);
		if (part === undefined) return undefined;
		return {
			status: part.status,
			isError: part.result.isError,
			content: part.result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)),
		};
	};

	const pidBefore = outcome("pid-before")?.content[0];
	const pidAfter = outcome("pid-after")?.content[0];
	expect(pidBefore).toMatch(/^\d+$/);
	expect(pidAfter).toMatch(/^\d+$/);
	expect(pidAfter).not.toBe(pidBefore);

	const firstTools = requests[0]?.context.tools ?? [];
	expect(firstTools.map((tool) => tool.name)).not.toContain("mcp__e2e__secret");
	expect(firstTools.some((tool) => tool.name.startsWith("mcp__later__"))).toBe(false);
	expect(result.errors.some((error) => error.includes("later"))).toBe(false);
	// The tool set is frozen per turn and stable across them, so every request declares the same tools.
	for (const request of requests) expect(request.context.tools).toEqual(firstTools);
	// The server's JSON Schema reaches the provider as written.
	expect(firstTools.find((tool) => tool.name === "mcp__e2e__echo")?.parameters).toEqual({
		type: "object",
		properties: { text: { type: "string", description: "What to echo." } },
		required: ["text"],
	});

	// The server reports its directory as the OS resolves it, through any symlink in the temp path.
	expect(outcome("cwd")?.content).toEqual([await fs.realpath(join(work, "srv"))]);

	// What the model is not shown in full is kept on the host, in files only the user can read.
	// Paths are read between the message's own delimiters, so a temp directory with spaces still parses.
	const bigFile = /\[Full output: (.+) \(read it with offset\/limit\)\]/.exec(outcome("big")?.content[0] ?? "")?.[1];
	const binaryFile = /saved to (.+)\]$/.exec(outcome("read-binary")?.content[0] ?? "")?.[1];
	onTestFinished(async () => {
		for (const file of [bigFile, binaryFile]) if (file) await fs.rm(file, { force: true });
	});
	expect(await fs.readFile(bigFile!, "utf8")).toBe(`start ${"x".repeat(30 * 1024)} end`);
	expect([...(await fs.readFile(binaryFile!))]).toEqual([0, 1, 2, 3]);
	expect((await fs.stat(binaryFile!)).mode & 0o777).toBe(0o600);
	const big = outcome("big")!.content[0]!;
	expect(Buffer.byteLength(big)).toBeLessThan(21 * 1024);
	expect(big).toMatch(/^start x+…\d+ chars truncated…x+ end$/m);

	const real = await fs.realpath(dir.path);
	const normalise = (value: unknown) =>
		JSON.parse(
			JSON.stringify(value)
				.replaceAll(bigFile!, "<output>.txt")
				.replaceAll(binaryFile!, "<output>.bin")
				.replaceAll(real, "<tmp>")
				.replaceAll(dir.path, "<tmp>")
				.replaceAll(process.execPath, "<node>")
				.replaceAll(`"${pidBefore}"`, '"<pid-before>"')
				.replaceAll(`"${pidAfter}"`, '"<pid-after>"'),
		);
	const artifact = normalise({
		requests: requests.length,
		tools: firstTools.map((tool) => tool.name),
		echoTool: firstTools.find((tool) => tool.name === "mcp__e2e__echo"),
		plugins: observed,
		calls: Object.fromEntries(
			[
				"echo",
				"fail",
				"structured",
				"nulls",
				"pid-before",
				"crash",
				"pid-after",
				"invalid",
				"pattern",
				"excess",
				"cwd",
				"link",
				"resources-all",
				"resources-page",
				"resources-next",
				"resources-blank",
				"templates",
				"read-text",
				"read-binary",
				"read-unknown",
			].map((id) => [id, outcome(id)]),
		),
		// The cut text itself is checked above; its frame is what the model reads around it.
		big: outcome("big")
			?.content[0]?.split("\n")
			.filter((line) => !line.startsWith("start ")),
		status: result.status,
		configErrors: result.errors,
	});
	expect(JSON.stringify(result)).not.toContain("sk-e2e-secret");
	await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot("./__artifacts__/mcp.session.json");
}, 60_000);

it("mcp: a server exiting while idle, reconfiguration, and an expired HTTP session", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const work = join(dir.path, "work");
	await fs.mkdir(work, { recursive: true });
	process.env.MCP_E2E_GREETING = "hello";

	// Expires the HTTP session on the next `expire` tool calls: the server answers 404 to the session.
	let expire = 0;
	const remote = raw({
		script: (request) => {
			if (request !== "POST tools/call" || expire === 0) return undefined;
			expire -= 1;
			return { status: 404, body: "session not found" };
		},
	});
	const configure = (url: URL, e2e: Record<string, unknown>) =>
		write(join(home, "mcp.json"), { mcpServers: { e2e: stdio(e2e), remote: { url: url.href } } });

	const runs: ReadonlyArray<ReadonlyArray<Message.ToolCallPendingPart>> = [
		[pendingCall("mcp__e2e__pid", {}, "pid-1"), pendingCall("mcp__remote__echo", {}, "remote-1")],
		[pendingCall("mcp__remote__echo", {}, "remote-retried"), pendingCall("mcp__e2e__bye", {}, "bye")],
		// The server exited while idle; the next call starts it again.
		[pendingCall("mcp__e2e__pid", {}, "pid-2")],
		// Only exposure changed: the same process, with `bye` no longer declared.
		[pendingCall("mcp__e2e__pid", {}, "pid-3"), pendingCall("mcp__remote__echo", {}, "remote-expired-twice")],
		// The environment changed: a new process.
		[pendingCall("mcp__e2e__pid", {}, "pid-4"), pendingCall("mcp__e2e__echo", { text: "x" }, "echo-changed")],
	];
	const requests: LLM.Input[] = [];
	const llm = scripted(
		runs.flatMap((calls) => [calls, []]),
		requests,
	);

	const result = await Effect.gen(function* () {
		const url = yield* listen(remote.handler);
		yield* Effect.promise(() => configure(url, {}));
		const session = yield* Session.create({ directory: work, model: { provider: "openai", id: "gpt-5.6-luna" } });
		const status = Mcp.Service.use((mcp) => mcp.status(session.main.id));
		const state = (server: string) =>
			status.pipe(Effect.map((all) => all.find((one) => one.server === server)?.state));

		yield* session.main.run("one");
		expire = 1;
		yield* session.main.run("two");
		// Wait for the idle exit to be noticed, so the next call meets a dropped connection.
		for (let tries = 0; tries < 250 && (yield* state("e2e")) !== "disconnected"; tries++)
			yield* Effect.sleep("20 millis");
		const afterBye = yield* state("e2e");
		yield* session.main.run("three");
		yield* Effect.promise(() => configure(url, { toolExposure: { bye: "hidden" } }));
		expire = 2;
		yield* session.main.run("four");
		yield* Effect.promise(() =>
			configure(url, { toolExposure: { bye: "hidden" }, env: { E2E_GREETING: "changed" } }),
		);
		yield* session.main.run("five");

		const messages = yield* Effect.forEach(yield* messageEntries(session.main), ContextCodec.decodeMessage);
		return { messages, afterBye, status: yield* status };
	}).pipe(
		Effect.provide(
			Harness.layer({ home, hostCwd: dir.path, database: ":memory:", plugins: [defaultPromptPlugin], llm }),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	const texts = new Map(
		result.messages
			.flatMap((message) => (message.role === "system" ? [] : message.parts))
			.flatMap((part) =>
				part.type === "toolCall" && "result" in part
					? [
							[
								part.callID,
								{
									isError: part.result.isError,
									content: part.result.content.map((block) => (block.type === "text" ? block.text : "")),
								},
							] as const,
						]
					: [],
			),
	);
	const pid = (id: string) => texts.get(id)?.content[0];
	expect(result.afterBye).toBe("disconnected");
	expect(pid("pid-2")).not.toBe(pid("pid-1"));
	expect(pid("pid-3")).toBe(pid("pid-2"));
	expect(pid("pid-4")).not.toBe(pid("pid-3"));

	// The first request of each turn: exposure changes apply at the next turn.
	const declared = runs.map((_, index) => requests[index * 2]?.context.tools?.map((tool) => tool.name) ?? []);
	expect(declared[2]).toContain("mcp__e2e__bye");
	expect(declared[3]).not.toContain("mcp__e2e__bye");

	const pids = [...new Set(["pid-1", "pid-2", "pid-3", "pid-4"].map(pid))];
	let serialized = JSON.stringify({
		calls: Object.fromEntries(texts),
		declared,
		// One expiry: a second initialize and the call once more. Two in a row: the call fails.
		// The standalone SSE stream (`GET`) opens in the background, at no fixed point among the requests.
		remote: remote.seen.filter((request) => request !== "POST notifications/initialized" && request !== "GET"),
		status: result.status,
	});
	pids.forEach((value, index) => {
		serialized = serialized.replaceAll(`"${value}"`, `"<process-${index + 1}>"`);
	});
	const artifact = JSON.parse(
		serialized.replaceAll(dir.path, "<tmp>").replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>"),
	);
	await expect(`${JSON.stringify(artifact, null, "\t")}\n`).toMatchFileSnapshot(
		"./__artifacts__/mcp.session.lifecycle.json",
	);
}, 60_000);

it("mcp: scopes decide who shares a server, and idle servers close", async () => {
	await using dir = await tmpdir();
	const home = join(dir.path, "home");
	const shared = join(dir.path, "shared");
	const other = join(dir.path, "other");
	await Promise.all([fs.mkdir(shared, { recursive: true }), fs.mkdir(other, { recursive: true })]);
	process.env.MCP_E2E_GREETING = "hello";
	await write(join(home, "mcp.json"), {
		// `twin` has exactly `mine`'s settings: still its own server, with its own instance.
		mcpServers: { mine: stdio(), twin: stdio(), ours: stdio({ scope: "space" }), all: stdio({ scope: "app" }) },
	});

	const calls = (prefix: string) =>
		["mine", "twin", "ours", "all"].map((server) => pendingCall(`mcp__${server}__pid`, {}, `${prefix}-${server}`));
	const requests: LLM.Input[] = [];
	const llm = scripted([calls("a"), [], calls("b"), [], calls("c"), [], calls("again"), []], requests);

	const result = await Effect.gen(function* () {
		const model = { provider: "openai", id: "gpt-5.6-luna" };
		// A and B work in one space, C in another.
		const a = yield* Session.create({ directory: shared, model });
		const b = yield* Session.create({ directory: shared, model });
		const c = yield* Session.create({ directory: other, model });
		// A lease on A's servers spans the three runs, so a slow runner cannot idle out the shared
		// instances between them; the short timeout only matters once it is released.
		yield* Effect.gen(function* () {
			yield* Mcp.Service.use((mcp) => mcp.lease({ sessionId: a.id, threadId: a.main.id }));
			yield* a.main.run("a");
			yield* b.main.run("b");
			yield* c.main.run("c");
		}).pipe(Effect.scoped);
		// No drain holds any server now, so every instance closes once the idle timeout passes.
		const status = Mcp.Service.use((mcp) =>
			Effect.forEach([a, b, c], (session) => mcp.status(session.main.id)).pipe(Effect.map((all) => all.flat())),
		);
		for (let tries = 0; tries < 250 && (yield* status).some((one) => one.state !== "disconnected"); tries++)
			yield* Effect.sleep("40 millis");
		const idle = yield* status;
		// A closed instance is started again by the next turn that needs it.
		yield* a.main.run("again");
		const messages = yield* Effect.forEach([a, b, c], (session) =>
			messageEntries(session.main).pipe(Effect.flatMap((line) => Effect.forEach(line, ContextCodec.decodeMessage))),
		);
		return { messages: messages.flat(), idle };
	}).pipe(
		Effect.provide(
			Harness.layer({
				home,
				hostCwd: dir.path,
				database: ":memory:",
				plugins: [defaultPromptPlugin],
				llm,
				// Short, to watch idle instances close.
				mcpIdleTimeout: "1500 millis",
			}),
		),
		Effect.scoped,
		Effect.runPromise,
	);

	const pids = new Map(
		result.messages
			.flatMap((message) => (message.role === "system" ? [] : message.parts))
			.flatMap((part) =>
				part.type === "toolCall" && "result" in part
					? [[part.callID, (part.result.content[0] as { readonly text: string }).text] as const]
					: [],
			),
	);
	const pid = (session: string, server: string) => pids.get(`${session}-${server}`);
	for (const id of pids.values()) expect(id).toMatch(/^\d+$/);
	// `session`: each its own. `space`: A and B share, C has its own. `app`: one for all.
	expect(new Set([pid("a", "mine"), pid("b", "mine"), pid("c", "mine")]).size).toBe(3);
	expect(pid("a", "twin")).not.toBe(pid("a", "mine"));
	expect(pid("a", "ours")).toBe(pid("b", "ours"));
	expect(pid("c", "ours")).not.toBe(pid("a", "ours"));
	expect(new Set([pid("a", "all"), pid("b", "all"), pid("c", "all")]).size).toBe(1);

	// Every instance closed, and its process with it.
	expect(result.idle.every((one) => one.state === "disconnected")).toBe(true);
	const alive = (value: string) => {
		try {
			process.kill(Number(value), 0);
			return true;
		} catch {
			return false;
		}
	};
	const before = ["a", "b", "c"].flatMap((session) =>
		["mine", "twin", "ours", "all"].map((server) => pid(session, server)),
	);
	expect(before.filter((value) => value !== undefined && alive(value))).toEqual([]);
	for (const server of ["mine", "twin", "ours", "all"]) expect(before).not.toContain(pid("again", server));

	// Distinct processes per scope, in the order the sessions first saw them.
	const order = [
		...new Set(
			["a", "b", "c", "again"].flatMap((session) =>
				["mine", "twin", "ours", "all"].map((server) => pid(session, server)),
			),
		),
	];
	const label = (value: string | undefined) => `<process-${order.indexOf(value ?? "") + 1}>`;
	await expect(
		`${JSON.stringify(
			{
				processes: Object.fromEntries(
					["a", "b", "c", "again"].map((session) => [
						session,
						Object.fromEntries(
							["mine", "twin", "ours", "all"].map((server) => [server, label(pid(session, server))]),
						),
					]),
				),
				idle: result.idle,
			},
			null,
			"\t",
		)}\n`,
	).toMatchFileSnapshot("./__artifacts__/mcp.session.scopes.json");
}, 60_000);
