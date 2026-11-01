/* @effect-diagnostics nodeBuiltinImport:off -- this suite writes its home and settings with node:fs. */
/* @effect-diagnostics globalTimers:off -- polling for a dying server runs outside any Effect. */
/* @effect-diagnostics globalDate:off -- so does its deadline. */
import { Control } from "@codeworksh/harness/effect";
import { Effect, Fiber, Layer, Stream } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Client } from "../src/server/client.ts";
import type { EventEnvelope } from "../src/server/envelope.ts";
import { type ChatRequest, models, type Reply, serveCli, streaming, toolCalls, writeSettings } from "./fixtures/cli.ts";

/*
 * A host that dies mid-run (SIGKILL, no shutdown) and a new server on the same home: what the
 * reopened server makes of the run the dead one left, observed only over RPC and at the provider.
 */

const mcpEcho = fileURLToPath(new URL("./fixtures/mcp-echo.mjs", import.meta.url));

/** A throwaway home whose settings choose the fake provider; the server runs in its `project`. */
const setup = (url: string, settings: object = {}) => {
	const home = realpathSync(mkdtempSync(join(tmpdir(), "codework-recovery-")));
	onTestFinished(() => rmSync(home, { recursive: true, force: true }));
	const project = join(home, "project");
	mkdirSync(project);
	writeSettings(home, url, settings);
	const start = () =>
		serveCli(["--home", home, "--user-config-dir", home], {
			cwd: project,
			env: { ...process.env, HOME: home, CODEWORK_MODELS_FILE: models },
		});
	return { home, project, start };
};

/** One RPC exchange over its own connection. */
const call = <A, E>(url: string, use: (rpc: Client.Client) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const context = yield* Layer.build(Client.layer(url));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));
			return yield* use(rpc);
		}).pipe(Effect.scoped),
	);

type Ids = { readonly sessionId: Parameters<Client.Client["thread.wait"]>[0]["sessionId"] };

/** The session's durable log, oldest first. */
const log = (url: string, ids: Ids) =>
	call(url, (rpc) =>
		rpc["session.log"]({ sessionId: ids.sessionId }).pipe(
			Stream.runCollect,
			Effect.map((items) => Array.from(items).filter((item): item is EventEnvelope => item.type !== "log.synced")),
		),
	);

const count = (events: ReadonlyArray<EventEnvelope>, type: string) =>
	events.filter((event) => event.type === type).length;

/** Polls `check` until it holds; fails naming `what` after `ms`. */
const until = async <A>(what: string, check: () => Promise<A | undefined> | A | undefined, ms = 30_000) => {
	const deadline = Date.now() + ms;
	while (true) {
		const value = await check();
		if (value !== undefined && value !== false) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
};

/** Waits for the log to hold `n` events of `type`, and returns it. */
const logged = (url: string, ids: Ids, type: string, n = 1) =>
	until(`${n} × ${type}`, async () => {
		const events = await log(url, ids);
		return count(events, type) >= n ? events : undefined;
	});

/** Live events of one thread, collected from the moment `ready` resolves. */
const subscribe = (url: string, threadId: Parameters<Client.Client["event.subscribe"]>[0]["threadId"]) => {
	const events: EventEnvelope[] = [];
	let connected: () => void = () => {};
	const ready = new Promise<void>((resolve) => (connected = resolve));
	const fiber = Effect.runFork(
		Effect.gen(function* () {
			const context = yield* Layer.build(Client.layer(url));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));
			yield* rpc["event.subscribe"]({ threadId }).pipe(
				Stream.runForEach((event) =>
					Effect.sync(() => (event.type === "server.connected" ? connected() : events.push(event))),
				),
			);
		}).pipe(Effect.scoped, Effect.ignore),
	);
	onTestFinished(() => Effect.runPromise(Fiber.interrupt(fiber)));
	return { events, ready };
};

/** A gate a test opens: what waits on it holds until then. */
const gate = () => {
	let open: () => void = () => {};
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
};

type Json = Record<string, unknown>;

const part = (value: unknown) => {
	const p = value as Json;
	if (p["type"] === "text") return { text: p["text"] };
	if (p["type"] === "thinking") return { thinking: p["thinking"] };
	if (p["type"] === "toolCall") {
		const result = p["result"] as { content?: ReadonlyArray<{ text?: string }> } | undefined;
		return {
			tool: p["name"],
			status: p["status"],
			...(result === undefined ? {} : { result: result.content?.map((one) => one.text).join("") }),
		};
	}
	return { type: p["type"] };
};

/** What an event says, without ids, times or paths. */
const summary = (event: EventEnvelope) => {
	const data = event.data as Json;
	const message = data["message"] as Json;
	switch (event.type) {
		case "session.prompt.admitted":
		case "session.prompt.promoted": {
			const prompt = data["prompt"] as { parts: ReadonlyArray<{ text?: string }> };
			return { type: event.type, delivery: data["delivery"], text: prompt.parts.map((one) => one.text).join("") };
		}
		case "session.llm.progress":
			return {
				type: event.type,
				changes: (data["changes"] as ReadonlyArray<Json>).map((change) =>
					change["_tag"] === "append" ? change : { ...change, part: part(change["part"]) },
				),
			};
		case "session.llm.ended":
		case "session.llm.failed":
			return {
				type: event.type,
				reason: data["reason"],
				...(message["errorMessage"] === undefined ? {} : { errorMessage: message["errorMessage"] }),
				parts: (message["parts"] as ReadonlyArray<unknown>).map(part),
			};
		case "session.tool.settled":
			return { type: event.type, part: part(data["part"]) };
		case "session.run.failed":
			return { type: event.type, reason: data["reason"], message: data["message"] };
		case "session.retry.scheduled":
		case "session.retry.finished": {
			const { sessionId: _s, threadId: _t, timestamp: _ts, ...rest } = data;
			return { type: event.type, ...rest };
		}
		default:
			return { type: event.type };
	}
};

/** The conversation a request carries, system prompt left out. */
const sent = (request: ChatRequest) =>
	request.messages
		.filter((message) => message.role !== "system" && message.role !== "developer")
		.map((message) => {
			const content = message.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((one: { text?: string }) => one.text ?? "").join("")
						: undefined;
			const calls = (message as { tool_calls?: ReadonlyArray<{ function: { name: string } }> }).tool_calls;
			return {
				role: message.role,
				...(text === undefined || text === "" ? {} : { text }),
				...(calls === undefined ? {} : { calls: calls.map((one) => one.function.name) }),
			};
		});

const history = async (url: string, ids: Ids) =>
	(await call(url, (rpc) => rpc["thread.history"](ids))).entries.map((entry) => ({
		role: entry.role,
		state: entry.state,
		parts: entry.parts.map(part),
	}));

const artifact = (value: unknown) => `${JSON.stringify(value, null, "\t")}\n`;

const answer = (response: Reply, text: string) => {
	response.send({ role: "assistant", content: text });
	response.finish("stop");
};

/** Opens the response and then never finishes it: the request stays in flight until the host dies. */
const hang = (response: Reply) => response.send({ role: "assistant" });

const retry = { retry: { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 1_000 } };

describe("recovery after the host is killed", () => {
	it("a reply killed mid-stream keeps its partial text, and the request is resent without it", async () => {
		const resend = gate();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) {
				response.send({ role: "assistant", content: "Partial answer, " });
				response.send({ content: "streamed before " });
				response.send({ content: "the host died." });
				return;
			}
			void resend.opened.then(() => answer(response, "The full answer."));
		});
		const { start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Answer at length." }));
		// The checkpoint lands a second into the stream: what a crash after it must not lose.
		await logged(first.url, ids, "session.llm.progress");
		await first.kill();

		const second = await start();
		const live = subscribe(second.url, ids.threadId);
		await live.ready;
		await until("the resend", () => fake.requests.length === 2);
		resend.open();
		const events = await logged(second.url, ids, "session.turn.ended");
		await until("retry.finished", () => live.events.find((event) => event.type === "session.retry.finished"));
		await call(second.url, (rpc) => rpc["thread.wait"](ids));

		const failed = events.find((event) => event.type === "session.llm.failed");
		expect(summary(failed!)).toMatchObject({
			reason: "error",
			errorMessage: "The host stopped while the model was answering, on attempt 1",
			parts: [{ text: "Partial answer, streamed before the host died." }],
		});
		// The aborted partial stays out of the model's context.
		expect(sent(fake.requests[1]!)).toEqual(sent(fake.requests[0]!));

		await expect(
			artifact({
				log: events.map(summary),
				// `session.retry.scheduled` is live only and may go out before a client can attach to the
				// new server; `retry.finished` follows the resend this test holds until it has.
				live: live.events.filter((event) => event.type === "session.retry.finished").map(summary),
				history: await history(second.url, ids),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.mid-stream.json");
	}, 90_000);

	it("a tool killed while it ran settles aborted, and the next request carries that without running it again", async () => {
		const marker = join(realpathSync(mkdtempSync(join(tmpdir(), "codework-recovery-marker-"))), "ran");
		onTestFinished(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
		const fake = await streaming((body, response, index) => {
			if (index === 0) {
				response.send(toolCalls([{ name: "bash", arguments: { command: `echo ran >> ${marker} && sleep 20` } }]));
				response.finish("tool_calls");
				return;
			}
			answer(response, `Recovered after ${body.messages.filter((one) => one.role === "tool").length} result.`);
		});
		const { start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run the slow command." }));
		await until("the tool to run", () => existsSync(marker));
		await first.kill();

		const second = await start();
		const events = await logged(second.url, ids, "session.turn.ended", 2);
		await call(second.url, (rpc) => rpc["thread.wait"](ids));

		expect(readFileSync(marker, "utf8")).toBe("ran\n");
		expect(fake.requests).toHaveLength(2);
		const tool = fake.requests[1]!.messages.find((one) => one.role === "tool");
		expect(tool?.content).toContain("Tool Execution Interrupted");

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(second.url, ids),
				requests: fake.requests.map(sent),
				ran: readFileSync(marker, "utf8"),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.tool.json");
	}, 90_000);

	it("a request killed with no retry left ends the run as interrupted, its follow-up still queued", async () => {
		const fake = await streaming((_body, response) => hang(response));
		const { start } = setup(fake.url, { retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 1_000 } });

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "First." }));
		await logged(first.url, ids, "session.llm.started");
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Then this.", delivery: "followUp" }));
		await logged(first.url, ids, "session.prompt.admitted", 2);
		await first.kill();

		// The one retry: the request is resent, and the host dies with it in flight again.
		const second = await start();
		await logged(second.url, ids, "session.llm.started", 2);
		await second.kill();

		const third = await start();
		const events = await logged(third.url, ids, "session.run.failed");
		await call(third.url, (rpc) => rpc["thread.wait"](ids));
		const queue = await call(third.url, (rpc) => rpc["thread.queue"](ids));

		expect(fake.requests).toHaveLength(2);
		expect(summary(events.find((event) => event.type === "session.run.failed")!)).toEqual({
			type: "session.run.failed",
			reason: "interrupted",
			message: "The host stopped while the model was answering, on attempt 2",
		});
		expect(queue.entries.map((entry) => entry.text)).toEqual(["Then this."]);

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(third.url, ids),
				queue: queue.entries.map(({ delivery, text }) => ({ delivery, text })),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.interrupted.json");
	}, 90_000);

	it("a run the host keeps dying in ends as a crashloop, and the next prompt runs normally", async () => {
		let answering = false;
		const fake = await streaming((_body, response) =>
			answering ? answer(response, "Back to normal.") : hang(response),
		);
		const { start } = setup(fake.url, { retry: { maxRetries: 10, baseDelayMs: 10, maxDelayMs: 1_000 } });

		let server = await start();
		const created = await call(server.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Keep crashing." }));
		// The first run, then a resume each until the limit: each dies with its request in flight.
		for (let started = 1; started <= Control.RESTART_LIMIT; started++) {
			await logged(server.url, ids, "session.llm.started", started);
			await server.kill();
			server = await start();
		}
		// The resume past the limit is one too many: the run ends instead.
		const ended = await logged(server.url, ids, "session.run.failed");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));
		expect(fake.requests).toHaveLength(Control.RESTART_LIMIT);
		expect(summary(ended.find((event) => event.type === "session.run.failed")!)).toMatchObject({
			reason: "crashloop",
		});

		answering = true;
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Try again." }));
		const events = await logged(server.url, ids, "session.turn.ended");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));
		expect(fake.requests).toHaveLength(Control.RESTART_LIMIT + 1);

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(server.url, ids),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.crashloop.json");
	}, 120_000);

	it("a tool the host keeps dying in ends as a crashloop, each run of it the model's own", async () => {
		const marker = join(realpathSync(mkdtempSync(join(tmpdir(), "codework-recovery-marker-"))), "ran");
		onTestFinished(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
		const runs = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").length - 1 : 0);
		const fake = await streaming((_body, response) => {
			response.send(toolCalls([{ name: "bash", arguments: { command: `echo ran >> ${marker} && sleep 20` } }]));
			response.finish("tool_calls");
		});
		const { start } = setup(fake.url, retry);

		let server = await start();
		const created = await call(server.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run the slow command." }));
		// The first run, then a resume each until the limit: each dies with the re-issued tool running.
		for (let ran = 1; ran <= Control.RESTART_LIMIT; ran++) {
			await until(`run ${ran} of the tool`, () => runs() >= ran);
			await server.kill();
			server = await start();
		}
		const events = await logged(server.url, ids, "session.run.failed");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));

		expect(runs()).toBe(Control.RESTART_LIMIT);
		expect(fake.requests).toHaveLength(Control.RESTART_LIMIT);
		expect(summary(events.find((event) => event.type === "session.run.failed")!)).toMatchObject({
			reason: "crashloop",
		});

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(server.url, ids),
				requests: fake.requests.map(sent),
				ran: readFileSync(marker, "utf8"),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.toolcrash.json");
	}, 180_000);

	it("replies cut off at the output limit with tool calls twice in a row end the run as truncated", async () => {
		const fake = await streaming((_body, response) => {
			response.send(toolCalls([{ name: "bash", arguments: { command: "echo cut" } }]));
			response.finish("length");
		});
		const { start } = setup(fake.url, retry);

		const server = await start();
		const created = await call(server.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run a long command." }));
		const events = await logged(server.url, ids, "session.run.failed");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));

		expect(fake.requests).toHaveLength(2);
		const settled = events.filter((event) => event.type === "session.tool.settled").map(summary);
		expect(settled).toHaveLength(2);
		for (const one of settled) expect(JSON.stringify(one)).toContain("Re-issue the tool call");
		expect(summary(events.find((event) => event.type === "session.run.failed")!)).toEqual({
			type: "session.run.failed",
			reason: "truncated",
			message: "The response hit the output token limit with tool calls 2 times in a row; the run is ended",
		});

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(server.url, ids),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.truncated.json");
	}, 90_000);

	it("a deferred tool loaded before the host died is still offered to the resent request", async () => {
		const tools = (request: ChatRequest) => (request.tools ?? []).map((tool) => tool.function.name).sort();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) {
				response.send(toolCalls([{ name: "toolsearch", arguments: { query: "echo" } }]));
				response.finish("tool_calls");
				return;
			}
			if (index === 1) return hang(response);
			answer(response, "Resumed with the loaded tool.");
		});
		const { home, start } = setup(fake.url, retry);
		writeFileSync(
			join(home, "mcp.json"),
			JSON.stringify({
				mcpServers: { fixture: { command: process.execPath, args: [mcpEcho], exposure: "deferred" } },
			}),
		);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Find the echo tool." }));
		await logged(first.url, ids, "session.llm.started", 2);
		await first.kill();

		const second = await start();
		const events = await logged(second.url, ids, "session.turn.ended", 2);
		await call(second.url, (rpc) => rpc["thread.wait"](ids));

		expect(fake.requests).toHaveLength(3);
		expect(tools(fake.requests[0]!)).not.toContain("mcp__fixture__echo");
		expect(tools(fake.requests[1]!)).toContain("mcp__fixture__echo");
		expect(tools(fake.requests[2]!)).toContain("mcp__fixture__echo");

		await expect(
			artifact({
				log: events.map(summary),
				tools: fake.requests.map(tools),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.tools.json");
	}, 90_000);
});
