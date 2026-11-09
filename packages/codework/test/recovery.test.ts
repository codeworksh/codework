/* @effect-diagnostics nodeBuiltinImport:off -- this suite writes its home and settings with node:fs. */
/* @effect-diagnostics globalTimers:off -- polling for a dying server runs outside any Effect. */
/* @effect-diagnostics globalDate:off -- so does its deadline. */
import { Control, Session } from "@codeworksh/harness/effect";
import { Effect, Fiber, Layer, Predicate, Stream } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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

/** A connection that never opened sent nothing, so opening another is safe; a loaded host can be slow to accept. */
const unopened = (error: unknown) =>
	Predicate.isTagged(error, "RpcClientError") &&
	Predicate.hasProperty(error, "reason") &&
	Predicate.isTagged(error.reason, "SocketOpenError");

/** One RPC exchange over its own connection. */
const call = <A, E>(url: string, use: (rpc: Client.Client) => Effect.Effect<A, E>) =>
	Effect.runPromise(
		Effect.gen(function* () {
			const context = yield* Layer.build(Client.layer(url));
			const rpc = yield* Client.make.pipe(Effect.provideContext(context));
			return yield* use(rpc);
		}).pipe(Effect.scoped, Effect.retry({ times: 2, while: unopened })),
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
		case "session.execution.started":
			return { type: event.type, resumed: data["resumed"] };
		case "session.execution.interrupted":
			return { type: event.type, reason: data["reason"] };
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

/** The thread's stored run, read from the database file; times named by the log event they came from. */
const runRow = (home: string, threadId: string, events: ReadonlyArray<EventEnvelope>) => {
	const db = new DatabaseSync(join(home, "data", "codework.db"));
	const row = db
		.prepare(
			"SELECT run_state, run_state_at, run_started_at, run_ended_at, run_outcome, run_error, head FROM thread WHERE id = ?",
		)
		.get(threadId)!;
	db.close();
	const at = (column: string, types: ReadonlyArray<string>) => {
		const time = row[column];
		if (time === null) return null;
		const from = events.findLast((event) => types.includes(event.type) && (event.data as Json)["timestamp"] === time);
		return from === undefined ? `unmatched ${String(time)}` : `${from.durable?.seq} ${from.type}`;
	};
	const ends = [
		"session.execution.succeeded",
		"session.execution.failed",
		"session.execution.interrupted",
		"session.run.failed",
	];
	const state = String(row["run_state"]);
	return {
		state,
		stateAt: at(
			"run_state_at",
			state === "starting" ? ["session.execution.started"] : state === "running" ? ["session.llm.started"] : ends,
		),
		startedAt: at("run_started_at", ["session.execution.started"]),
		endedAt: at("run_ended_at", ends),
		outcome: row["run_outcome"],
		error: row["run_error"] === null ? null : JSON.parse(String(row["run_error"])),
		head: row["head"],
	};
};

/** The stored run of a thread a run ended on its own: idle, failed, with the reason it ended for. */
const endedRow = async (url: string, home: string, ids: Ids & { readonly threadId: string }, reason: string) => {
	const row = runRow(home, ids.threadId, await log(url, ids));
	expect(row).toMatchObject({ state: "idle", outcome: "failed", error: { _tag: "runFailed", reason } });
	return row;
};

/** Cuts the reply off at the output limit with a tool call, as a run that gets truncated sees it. */
const truncate = (response: Reply) => {
	response.send(toolCalls([{ name: "bash", arguments: { command: "echo cut" } }]));
	response.finish("length");
};

/** The thread's provider request in flight, or the last one failed while a retry waits, read from the database file. */
const attemptOf = (home: string, threadId: string) => {
	const db = new DatabaseSync(join(home, "data", "codework.db"));
	const row = db.prepare("SELECT attempt FROM thread WHERE id = ?").get(threadId)!;
	db.close();
	return row["attempt"];
};

/** A provider address nothing listens on: every request fails to connect, a transient failure. */
const refused = async () => {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return `http://127.0.0.1:${port}`;
};

/** The thread's head and restart count, and each prompt's tail, read from the database file. */
const positions = (home: string, threadId: string) => {
	const db = new DatabaseSync(join(home, "data", "codework.db"));
	const thread = db.prepare("SELECT head, restarts FROM thread WHERE id = ?").get(threadId)!;
	const prompts = db
		.prepare(
			"SELECT data, delivery, admitted_seq, tail, promoted_seq FROM inbox WHERE thread_id = ? ORDER BY admitted_seq",
		)
		.all(threadId)
		.map((row) => ({
			text: (JSON.parse(String(row["data"])) as { parts: ReadonlyArray<{ text?: string }> }).parts
				.map((one) => one.text)
				.join(""),
			delivery: row["delivery"],
			admittedSeq: row["admitted_seq"],
			tail: row["tail"],
			promotedSeq: row["promoted_seq"],
		}));
	db.close();
	return { head: Number(thread["head"]), restarts: Number(thread["restarts"]), prompts };
};

describe("recovery after the host is killed", () => {
	it("the stored run of a killed host is swept as a crash before clients connect, then resumed", async () => {
		const resend = gate();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) return answer(response, "First answer.");
			hang(response);
			if (index === 2) void resend.opened.then(() => answer(response, "Resumed answer."));
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		const rows: Array<{ step: string } & ReturnType<typeof runRow>> = [];
		const record = (step: string, events: ReadonlyArray<EventEnvelope>) =>
			rows.push({ step, ...runRow(home, ids.threadId, events) });

		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "First." }));
		await logged(first.url, ids, "session.execution.succeeded");
		record("succeeded", await log(first.url, ids));
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Second." }));
		const inFlight = await logged(first.url, ids, "session.llm.started", 2);
		// `llm.started` goes out before the request: killed sooner, the resend would take the hanging slot.
		await until("the second request", () => fake.requests.length === 2);
		record("in flight", inFlight);
		await first.kill();
		// What the dead host left: the run still open.
		record("killed", inFlight);

		const second = await start();
		// The sweep committed before the listener opened, so the first read already holds it.
		const reopened = await log(second.url, ids);
		const swept = reopened.findIndex(
			(event) => event.type === "session.execution.interrupted" && (event.data as Json)["reason"] === "crash",
		);
		expect(swept).toBeGreaterThan(0);
		record("resumed", await logged(second.url, ids, "session.llm.started", 3));
		resend.open();
		await logged(second.url, ids, "session.turn.ended", 2);
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		const events = await log(second.url, ids);
		record("finished", events);

		const resumed = events.findIndex(
			(event) => event.type === "session.execution.started" && (event.data as Json)["resumed"] === true,
		);
		// Swept first, resumed after, with nothing of the run in between.
		expect(resumed).toBe(swept + 1);
		expect(rows.find((row) => row.step === "resumed")).toMatchObject({ state: "running" });

		const lifecycle = new Set([
			"session.execution.started",
			"session.execution.succeeded",
			"session.execution.failed",
			"session.execution.interrupted",
			"session.run.failed",
			"session.llm.started",
		]);
		await expect(
			artifact({
				log: events
					.filter((event) => lifecycle.has(event.type))
					.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				// Read from the database file: after the first run, mid-run, with the resumed request in
				// flight, and once it answered.
				rows,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.lifecycle.json");
	}, 90_000);

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
			reason: "aborted",
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
		const { home, start } = setup(fake.url, { retry: { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 1_000 } });

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "First." }));
		await logged(first.url, ids, "session.llm.started");
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Then this.", delivery: "followUp" }));
		await logged(first.url, ids, "session.prompt.admitted", 2);
		await until("the request", () => fake.requests.length === 1);
		await first.kill();

		// The one retry: the request is resent, and the host dies with it in flight again.
		const second = await start();
		await logged(second.url, ids, "session.llm.started", 2);
		// `llm.started` goes out before the request: wait for it, or the kill can beat the resend.
		await until("the resend", () => fake.requests.length === 2);
		await second.kill();

		const third = await start();
		const events = await logged(third.url, ids, "session.run.failed");
		await call(third.url, (rpc) => rpc["thread.wait"](ids));
		const queue = await call(third.url, (rpc) => rpc["thread.queue"](ids));
		const run = await endedRow(third.url, home, ids, "interrupted");

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
				run,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.interrupted.json");
	}, 90_000);

	it("a run the host keeps dying in ends as a crashloop, and the next prompt runs normally", async () => {
		let answering = false;
		const fake = await streaming((_body, response) =>
			answering ? answer(response, "Back to normal.") : hang(response),
		);
		const { home, start } = setup(fake.url, { retry: { maxRetries: 10, baseDelayMs: 10, maxDelayMs: 1_000 } });

		let server = await start();
		const created = await call(server.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Keep crashing." }));
		// The first run, then a resume each until the limit: each dies with its request in flight.
		for (let started = 1; started <= Control.RESTART_LIMIT; started++) {
			await logged(server.url, ids, "session.llm.started", started);
			await until(`request ${started}`, () => fake.requests.length === started);
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
		const run = await endedRow(server.url, home, ids, "crashloop");

		answering = true;
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Try again." }));
		const events = await logged(server.url, ids, "session.turn.ended");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));
		expect(fake.requests).toHaveLength(Control.RESTART_LIMIT + 1);

		await expect(
			artifact({
				log: events.map(summary),
				history: await history(server.url, ids),
				// Before the next prompt.
				run,
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
		const { home, start } = setup(fake.url, retry);

		const server = await start();
		const created = await call(server.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(server.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run a long command." }));
		const events = await logged(server.url, ids, "session.run.failed");
		await call(server.url, (rpc) => rpc["thread.wait"](ids));

		const run = await endedRow(server.url, home, ids, "truncated");
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
				run,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.truncated.json");
	}, 90_000);

	it("prompts sent while a run fails are parked: a kill runs none of them, the next prompt runs them all", async () => {
		const cut = gate();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) return truncate(response);
			// The second cut-off ends the run: held until the prompts are in.
			if (index === 1) return void cut.opened.then(() => truncate(response));
			answer(response, "Answered with the queue.");
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		const steps: Array<{ step: string } & ReturnType<typeof positions>> = [];
		const record = (step: string) => steps.push({ step, ...positions(home, ids.threadId) });

		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run a long command." }));
		await logged(first.url, ids, "session.llm.started", 2);
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Then answer this." }));
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "And this.", delivery: "followUp" }));
		const queued = await call(first.url, (rpc) => rpc["thread.queue"](ids));
		const moved = queued.entries.find((entry) => entry.text === "And this.")!;
		// Moved to steer while the run is still failing: that wake is before the end too.
		await call(first.url, (rpc) =>
			rpc["thread.update"]({ ...ids, messageId: Session.SessionMessageSchema.ID.make(moved.id), delivery: "steer" }),
		);
		cut.open();
		await logged(first.url, ids, "session.run.failed");
		await call(first.url, (rpc) => rpc["thread.wait"](ids));
		record("parked");
		expect(fake.requests).toHaveLength(2);
		await first.kill();

		const second = await start();
		const reopened = await call(second.url, (rpc) => rpc["thread.queue"](ids));
		record("reopened");
		expect(reopened.entries.map((entry) => [entry.delivery, entry.text])).toEqual([
			["steer", "Then answer this."],
			["steer", "And this."],
		]);
		await call(second.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Next." }));
		await logged(second.url, ids, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		record("next prompt");

		// Nothing ran between the failure and the next prompt, which took the parked queue with it.
		expect(fake.requests).toHaveLength(3);
		const events = await log(second.url, ids);
		await expect(
			artifact({
				log: events.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				// Read from the database file: head, and each prompt's tail, across the kill.
				steps,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.parked.json");
	}, 90_000);

	it("a prompt sent after a run failed runs, and is resumed after a kill", async () => {
		const resend = gate();
		const fake = await streaming((_body, response, index) => {
			if (index <= 1) return truncate(response);
			// The prompt's run, killed with its request in flight; then its resend.
			if (index === 2) return hang(response);
			void resend.opened.then(() => answer(response, "Answered after the kill."));
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		const steps: Array<{ step: string } & ReturnType<typeof positions>> = [];
		const record = (step: string) => steps.push({ step, ...positions(home, ids.threadId) });

		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run a long command." }));
		await logged(first.url, ids, "session.run.failed");
		await call(first.url, (rpc) => rpc["thread.wait"](ids));
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Now this." }));
		await logged(first.url, ids, "session.llm.started", 3);
		// `llm.started` goes out before the request: killed sooner, the resend would take the hanging slot.
		await until("the prompt's request", () => fake.requests.length === 3);
		record("in flight");
		await first.kill();

		const second = await start();
		await logged(second.url, ids, "session.llm.started", 4);
		record("resumed");
		resend.open();
		await logged(second.url, ids, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		record("finished");

		expect(fake.requests).toHaveLength(4);
		expect(sent(fake.requests[3]!)).toEqual(sent(fake.requests[2]!));
		const events = await log(second.url, ids);
		await expect(
			artifact({
				log: events.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				steps,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.after-failure.json");
	}, 90_000);

	it("a stop parks what was queued and what was sent while it wound down: a kill runs none, the next prompt runs all", async () => {
		const marker = join(realpathSync(mkdtempSync(join(tmpdir(), "codework-recovery-marker-"))), "ran");
		onTestFinished(() => rmSync(join(marker, ".."), { recursive: true, force: true }));
		const fake = await streaming((_body, response, index) => {
			if (index > 0) return answer(response, `Answer ${index}.`);
			// Ignores SIGTERM, so the stop winds down for the whole force-kill grace.
			response.send(
				toolCalls([{ name: "bash", arguments: { command: `trap '' TERM; echo ran > ${marker}; sleep 20` } }]),
			);
			response.finish("tool_calls");
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		const steps: Array<{ step: string } & ReturnType<typeof positions>> = [];
		const record = (step: string) => steps.push({ step, ...positions(home, ids.threadId) });

		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run the stubborn command." }));
		await until("the tool to run", () => existsSync(marker));
		await call(first.url, (rpc) =>
			rpc["thread.prompt"]({ ...ids, text: "Queued before the stop.", delivery: "followUp" }),
		);
		// Sent together on one connection: the prompt waits for no reply, so it lands inside the kill grace.
		await call(first.url, (rpc) =>
			Effect.all([rpc["thread.interrupt"](ids), rpc["thread.prompt"]({ ...ids, text: "Sent while stopping." })], {
				concurrency: "unbounded",
			}),
		);
		await logged(first.url, ids, "session.execution.interrupted");
		await call(first.url, (rpc) => rpc["thread.wait"](ids));
		record("stopped");
		const stopped = await log(first.url, ids);
		const seqOf = (type: string, text?: string) =>
			stopped.find(
				(event) =>
					event.type === type && (text === undefined || (summary(event) as { text?: string }).text === text),
			)!.durable!.seq;
		// The prompt really landed while the stop wound down: after the stop was asked, before it ended.
		expect(seqOf("session.prompt.admitted", "Sent while stopping.")).toBeLessThan(
			seqOf("session.execution.interrupted"),
		);
		expect(fake.requests).toHaveLength(1);
		await first.kill();

		const second = await start();
		const reopened = await call(second.url, (rpc) => rpc["thread.queue"](ids));
		record("reopened");
		expect(reopened.entries.map((entry) => entry.text)).toEqual(["Queued before the stop.", "Sent while stopping."]);
		await call(second.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Next." }));
		await logged(second.url, ids, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		record("next prompt");

		// One request: the steers and the oldest follow-up go in with the next prompt, in the order they were
		// sent, so the follow-up queued before the stop comes first.
		expect(fake.requests.map((request) => sent(request).at(-1)?.text)).toEqual([
			"Run the stubborn command.",
			"Next.",
		]);
		expect(
			sent(fake.requests[1]!)
				.filter((message) => message.role === "user")
				.map((message) => message.text),
		).toEqual(["Run the stubborn command.", "Queued before the stop.", "Sent while stopping.", "Next."]);
		const events = await log(second.url, ids);
		await expect(
			artifact({
				log: events.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				steps,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.stop.json");
	}, 90_000);

	it("a parked prompt moved to steer runs now and is resumed after a kill; resending it changes nothing", async () => {
		const cut = gate();
		const resend = gate();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) return truncate(response);
			if (index === 1) return void cut.opened.then(() => truncate(response));
			// The run the move started, killed with its request in flight; then its resend.
			if (index === 2) return hang(response);
			void resend.opened.then(() => answer(response, "Answered after the kill."));
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		const steps: Array<{ step: string } & ReturnType<typeof positions>> = [];
		const record = (step: string) => steps.push({ step, ...positions(home, ids.threadId) });

		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Run a long command." }));
		await logged(first.url, ids, "session.llm.started", 2);
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Then this.", delivery: "followUp" }));
		cut.open();
		await logged(first.url, ids, "session.run.failed");
		await call(first.url, (rpc) => rpc["thread.wait"](ids));
		const [parked] = (await call(first.url, (rpc) => rpc["thread.queue"](ids))).entries;
		const messageId = Session.SessionMessageSchema.ID.make(parked!.id);

		// A retry of the same request is the same prompt: it stays parked.
		await call(first.url, (rpc) =>
			rpc["thread.prompt"]({ ...ids, id: messageId, text: "Then this.", delivery: "followUp" }),
		);
		await call(first.url, (rpc) => rpc["thread.wait"](ids));
		record("resent");
		expect(fake.requests).toHaveLength(2);

		await call(first.url, (rpc) => rpc["thread.update"]({ ...ids, messageId, delivery: "steer" }));
		await logged(first.url, ids, "session.llm.started", 3);
		await until("the moved prompt's request", () => fake.requests.length === 3);
		record("moved");
		await first.kill();

		const second = await start();
		await logged(second.url, ids, "session.llm.started", 4);
		resend.open();
		await logged(second.url, ids, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		record("finished");

		expect(fake.requests).toHaveLength(4);
		expect(sent(fake.requests[3]!)).toEqual(sent(fake.requests[2]!));
		const events = await log(second.url, ids);
		await expect(
			artifact({
				log: events.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				steps,
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.moved.json");
	}, 90_000);

	it("a run a clean shutdown stopped resumes without counting a restart", async () => {
		const resend = gate();
		const fake = await streaming((_body, response, index) => {
			if (index === 0) return hang(response);
			void resend.opened.then(() => answer(response, "Answered after the restart."));
		});
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "First." }));
		await logged(first.url, ids, "session.llm.started");
		await until("the request", () => fake.requests.length === 1);
		await first.stop();
		const stopped = { ...positions(home, ids.threadId), attempt: attemptOf(home, ids.threadId) };
		// The request the shutdown ended keeps its attempt: the resume goes on counting from it.
		expect(stopped.attempt).toBe(1);

		const second = await start();
		await logged(second.url, ids, "session.llm.started", 2);
		await until("the resend", () => fake.requests.length === 2);
		// Read while the resumed run is in flight: a run that completes resets the count either way.
		const resumed = positions(home, ids.threadId);
		resend.open();
		await logged(second.url, ids, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](ids));
		const events = await log(second.url, ids);

		expect(stopped.restarts).toBe(0);
		expect(resumed.restarts).toBe(0);
		expect(summary(events.find((event) => event.type === "session.execution.interrupted")!)).toEqual({
			type: "session.execution.interrupted",
			reason: "shutdown",
		});
		await expect(
			artifact({
				log: events
					.filter((event) => event.type.startsWith("session.execution.") || event.type === "session.llm.started")
					.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				stopped,
				resumed,
				finished: positions(home, ids.threadId),
				requests: fake.requests.map(sent),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.shutdown.json");
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
		await until("the second request", () => fake.requests.length === 2);
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

	it("a thread that cannot be resumed fails alone: the other thread cut off with it still resumes", async () => {
		let answering = false;
		const fake = await streaming((_body, response) => (answering ? answer(response, "Resumed.") : hang(response)));
		const { home, start } = setup(fake.url, retry);

		const first = await start();
		const broken = await call(first.url, (rpc) => rpc["session.create"]({}));
		const healthy = await call(first.url, (rpc) => rpc["session.create"]({}));
		const brokenIds = { sessionId: broken.session.id, threadId: broken.id };
		const healthyIds = { sessionId: healthy.session.id, threadId: healthy.id };
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...brokenIds, text: "Broken." }));
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...healthyIds, text: "Healthy." }));
		await logged(first.url, brokenIds, "session.llm.started");
		await logged(first.url, healthyIds, "session.llm.started");
		await until("both requests", () => fake.requests.length === 2);
		await first.kill();
		// A draft no resume can read: healing it dies.
		const db = new DatabaseSync(join(home, "data", "codework.db"));
		db.prepare(
			"UPDATE entry SET data = 'not json', rev = (SELECT rev FROM store) WHERE thread_id = ? AND state = 'draft'",
		).run(brokenIds.threadId);
		db.close();

		answering = true;
		const second = await start();
		await logged(second.url, brokenIds, "session.execution.failed");
		const events = await logged(second.url, healthyIds, "session.execution.succeeded");
		await call(second.url, (rpc) => rpc["thread.wait"](healthyIds));
		await call(second.url, (rpc) => rpc["thread.wait"](brokenIds));

		expect(fake.requests).toHaveLength(3);
		const lifecycle = (log: ReadonlyArray<EventEnvelope>) =>
			log
				.filter((event) => event.type.startsWith("session.execution.") || event.type === "session.run.failed")
				.map(summary);
		await expect(
			artifact({
				broken: lifecycle(await log(second.url, brokenIds)),
				healthy: lifecycle(events),
				resent: sent(fake.requests[2]!),
			}),
		).toMatchFileSnapshot("./__artifacts__/recovery.isolation.json");
	}, 90_000);

	it("a run killed, then shut down, while it waits out a retry is resumed uncounted, its attempt carried", async () => {
		const resend = gate();
		const fake = await streaming((_body, response) => void resend.opened.then(() => answer(response, "Answered.")));
		const dead = await refused();
		// The backoff outlasts the test: the host is killed and stopped while it sleeps.
		const asleep = { retry: { maxRetries: 3, baseDelayMs: 60_000, maxDelayMs: 60_000 } };
		const { home, start } = setup(dead, asleep);
		const steps: Array<{ step: string; restarts: number; attempt: unknown }> = [];
		let threadId = "";
		const record = (step: string) =>
			steps.push({ step, restarts: positions(home, threadId).restarts, attempt: attemptOf(home, threadId) });

		const first = await start();
		const created = await call(first.url, (rpc) => rpc["session.create"]({}));
		const ids = { sessionId: created.session.id, threadId: created.id };
		threadId = ids.threadId;
		const live = subscribe(first.url, ids.threadId);
		await live.ready;
		await call(first.url, (rpc) => rpc["thread.prompt"]({ ...ids, text: "Wait it out." }));
		await until("the retry", () => live.events.find((event) => event.type === "session.retry.scheduled"));
		record("backoff");
		await first.kill();

		// The resume counts the attempt it slept for as failed and waits out the next: a kill in backoff
		// counted no restart, the retry budget bounds it instead.
		const second = await start();
		await until("the resumed run", async () =>
			(await log(second.url, ids)).find(
				(event) => event.type === "session.execution.started" && (event.data as Json)["resumed"] === true,
			),
		);
		record("resumed");
		await second.stop();
		record("stopped");

		writeSettings(home, fake.url, retry);
		const third = await start();
		const resumed = subscribe(third.url, ids.threadId);
		await resumed.ready;
		await until("the resend", () => fake.requests.length === 1);
		resend.open();
		await until("retry.finished", () => resumed.events.find((event) => event.type === "session.retry.finished"));
		const events = await logged(third.url, ids, "session.execution.succeeded");
		await call(third.url, (rpc) => rpc["thread.wait"](ids));
		record("finished");

		expect(steps.map((step) => step.restarts)).toEqual([0, 0, 0, 0]);
		// The attempt the backoff waits for, past the two that failed: the shutdown keeps it, and it is sent next.
		expect(steps.find((step) => step.step === "stopped")?.attempt).toBe(3);
		await expect(
			artifact({
				log: events
					.filter((event) =>
						["session.execution.", "session.llm.", "session.retry."].some((prefix) =>
							event.type.startsWith(prefix),
						),
					)
					.map((event) => ({ seq: event.durable?.seq, ...summary(event) })),
				// The resend goes on from the attempt the host stopped in.
				live: resumed.events.filter((event) => event.type === "session.retry.finished").map(summary),
				steps,
				requests: fake.requests.map(sent),
				// The refused address is a fresh port each run.
			}).replaceAll(new URL(dead).host, "<refused>"),
		).toMatchFileSnapshot("./__artifacts__/recovery.backoff.json");
	}, 120_000);
});
