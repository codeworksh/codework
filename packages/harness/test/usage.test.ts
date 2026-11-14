import "./utils/env.ts";
import { createAssistantMessageEventStream, type Message } from "@codeworksh/aikit";
import { DateTime, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";
import * as Context from "../src/context/context.ts";
import * as Control from "../src/control.ts";
import * as Database from "../src/db/db.ts";
import { migrations } from "../src/db/migrations.ts";
import type { TallyRow, UsageRow } from "../src/db/schema.sql.ts";
import * as Store from "../src/db/store.ts";
import * as Sync from "../src/effect/sync.ts";
import * as Event from "../src/event/event.ts";
import * as EventList from "../src/event/list.ts";
import * as EventRegistry from "../src/event/registry.ts";
import * as Global from "../src/global.ts";
import { builtins } from "../src/plugin/builtin.ts";
import type { Plugin } from "../src/plugin/plugin.ts";
import * as RunnerExecute from "../src/runner/execute.ts";
import * as Hooks from "../src/runner/hooks.ts";
import * as LLM from "../src/runner/llm.ts";
import * as Loop from "../src/runner/loop.ts";
import * as SandboxController from "../src/sandbox/control.ts";
import * as SandboxDriverRegistry from "../src/sandbox/registry.ts";
import * as SessionMessageSchema from "../src/session/message/schema.ts";
import * as PromptSchema from "../src/session/prompt/schema.ts";
import * as SessionProjector from "../src/session/projector.ts";
import * as SessionRuntime from "../src/session/runtime.ts";
import * as SessionSchema from "../src/session/schema.ts";
import * as Session from "../src/session/session.ts";
import * as Settings from "../src/settings/settings.ts";
import * as State from "../src/state/state.ts";
import * as ThreadSchema from "../src/thread/schema.ts";
import * as Thread from "../src/thread/thread.ts";
import * as Tool from "../src/tool/tool.ts";
import * as Usage from "../src/usage/usage.ts";
import * as Mcp from "../src/mcp/mcp.ts";
import * as Process from "../src/sandbox/utils/process.ts";
import { assistant } from "./fixtures/llm.ts";
import { credentials, named } from "./fixtures/model.ts";
import { pooled } from "./fixtures/pool.ts";
import { seedSpace } from "./fixtures/space.ts";
import { testEffect } from "./utils/effect.ts";

/** One model request: its times, usage, what it calls, and whether the provider fails it. */
interface Step {
	readonly created: number;
	readonly completed: number;
	readonly tools?: ReadonlyArray<string>;
	readonly model?: string;
	readonly thinking?: Message.AssistantMessage["thinkingLevel"];
	readonly usage?: Partial<Message.Usage>;
	readonly fail?: boolean;
}

const HOUR = 3_600_000;
// 2026-11-14T10:00:00Z: the scenario straddles it.
const H = Date.UTC(2026, 10, 14, 10);

const script = new Map<string, Array<Step>>();
let responses = 0;
/** The last request's input, which a crashed draft is built from. */
let requested: LLM.Input | undefined;

const open: LLM.Open = (input) =>
	Effect.sync(() => {
		requested = input;
		const step = script.get(input.threadId)?.shift();
		if (step === undefined) throw new Error(`no step scripted for ${input.threadId}`);
		responses += 1;
		const base = assistant(input, responses).usage;
		const message = assistant(input, responses, {
			...(step.model === undefined ? {} : { model: step.model }),
			...(step.thinking === undefined ? {} : { thinkingLevel: step.thinking }),
			usage: { ...base, ...step.usage },
			time: { created: step.created, completed: step.completed },
			...(step.fail === true
				? { stopReason: "error", errorMessage: "provider failed" }
				: step.tools === undefined
					? {}
					: {
							stopReason: "toolUse",
							parts: step.tools.map((name, index) => ({
								type: "toolCall",
								callID: `call_${responses}_${index}`,
								name,
								arguments: { value: name },
								status: "pending",
								time: { start: step.created, end: step.created },
							})),
						}),
		});
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "start", partial: message });
		if (step.fail === true) {
			const failure = { _tag: "Authentication", reason: "missing", message: "provider failed", retryable: false };
			stream.push({ type: "error", reason: "error", error: { ...message, failure } as Message.AssistantMessage });
		} else stream.push({ type: "done", reason: step.tools === undefined ? "stop" : "toolUse", message });
		return stream;
	});

const echoTools: Plugin = {
	id: "test.tool.echo",
	kind: "tool",
	setup: (ctx) => {
		for (const name of ["echo", "shout"]) {
			ctx.plugin.tools.add(
				Tool.register(
					Tool.make({
						name,
						description: `${name}es its value`,
						parameters: Schema.Struct({ value: Schema.String }),
						success: Schema.String,
						encodeContent: (value: string) => [{ type: "text", text: value }],
						handler: ({ value }) => Effect.succeed(value),
					}),
				),
			);
		}
	},
};

const layer = () => {
	const database = Database.layer(":memory:");
	const sandbox = SandboxController.layer({ hostCwd: "/" }).pipe(
		Layer.provideMerge(SandboxDriverRegistry.layer()),
		Layer.provideMerge(database),
	);
	const seeded = pooled([...builtins, echoTools]);
	return Control.layer.pipe(
		Layer.provideMerge(
			RunnerExecute.layer.pipe(
				Layer.provide(Loop.layer({ request: LLM.make(open) }).pipe(Layer.provide(Hooks.layer))),
			),
		),
		Layer.provideMerge(State.layer({}, seeded.ref, seeded.references, seeded.follow, seeded.rebuild)),
		Layer.provideMerge(credentials),
		Layer.provideMerge(Mcp.layer({ hostCwd: "/", home: "/unused/home" }).pipe(Layer.provide(Process.host))),
		Layer.provideMerge(SessionRuntime.layer),
		Layer.provideMerge(
			Layer.succeed(Settings.Service, {
				load: () => Effect.succeed(named),
				locate: () => Effect.die("unused"),
			}),
		),
		Layer.provideMerge(sandbox),
		Layer.provideMerge(Context.layer),
		Layer.provideMerge(SessionProjector.layer),
		Layer.provideMerge(Session.storeLayer),
		Layer.provideMerge(Event.layer),
		Layer.provideMerge(EventRegistry.layer()),
		Layer.provideMerge(database),
		Layer.provideMerge(Layer.succeed(Global.Service, Global.make({ home: "/unused/home" }))),
	);
};

const { effect: it } = testEffect(layer());

const artifact = (name: string, value: unknown) =>
	Effect.promise(() =>
		expect(`${JSON.stringify(value, null, "\t")}\n`).toMatchFileSnapshot(`./__artifacts__/${name}`),
	);

/** Prompts `threadId` at clock time `at` and waits for the run, which may fail. */
const run = (sessionId: SessionSchema.ID, threadId: ThreadSchema.ID, at: number, text: string) =>
	Effect.gen(function* () {
		const control = yield* Control.Service;
		yield* TestClock.setTime(at);
		yield* control
			.run({ sessionId, threadId, prompt: PromptSchema.Prompt.fromText(text), delivery: "followUp" })
			.pipe(Effect.exit);
		yield* control.wait(threadId);
	});

/**
 * What a host that died mid-turn leaves for the next run to heal: the draft it was writing, ended when
 * its response finished, with the calls in `ran` settled as completed, and the run interrupted.
 */
const crashed = Effect.fnUntraced(function* (
	sessionId: SessionSchema.ID,
	threadId: ThreadSchema.ID,
	draft: Message.AssistantMessage,
	ran: ReadonlyArray<string>,
) {
	const events = yield* Event.Service;
	const ids = { sessionId, threadId, messageId: SessionMessageSchema.ID.from(draft.messageId) };
	const at = DateTime.makeUnsafe(draft.time.completed);
	yield* events.publish(EventList.LLMStarted, { timestamp: at, ...ids, message: draft });
	if (draft.stopReason === "toolUse") {
		yield* events.publish(EventList.LLMEnded, { timestamp: at, ...ids, reason: "toolUse", message: draft });
	}
	for (const part of draft.parts) {
		if (part.type !== "toolCall" || part.status !== "pending" || !ran.includes(part.callID)) continue;
		yield* events.publish(EventList.ToolSettled, {
			timestamp: at,
			...ids,
			callID: part.callID,
			part: { ...part, status: "completed", result: { content: [{ type: "text", text: "ran" }], isError: false } },
		});
	}
	yield* events.publish(EventList.ExecutionInterrupted, { timestamp: at, sessionId, threadId, reason: "crash" });
});

/**
 * One session: main runs a tool turn across the 10:00 boundary (two tools, two requests on different
 * models and thinking levels) and a request the provider fails; a fork and a subagent thread run one
 * request each. Two more threads heal what a crash left: `healed` a request in flight at 12:00, aborted
 * when the host is back at 20:00; `recovered` a response that ended at 13:00 with two calls, one of which
 * ran, committed at 21:00 with the other aborted unrun.
 */
const scenario = Effect.gen(function* () {
	script.clear();
	responses = 0;
	const sessions = yield* Session.Service;
	const threads = yield* Thread.Service;
	const { spaceId, location } = yield* seedSpace({ location: process.cwd(), projectId: "p" });
	const created = yield* sessions.create({ spaceId, directory: location });
	const sessionId = SessionSchema.ID.make(created.session.id);
	const main = ThreadSchema.ID.make(created.thread.id);

	const cost = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({
		input,
		output,
		cacheRead,
		cacheWrite,
		total: input + output + cacheRead + cacheWrite,
	});
	script.set(main, [
		{
			created: H - 30_000,
			completed: H - 28_000,
			tools: ["echo", "shout", "echo"],
			usage: {
				input: 100,
				output: 40,
				cacheRead: 20,
				cacheWrite: 5,
				reasoning: 10,
				totalTokens: 165,
				cost: cost(0.25, 0.125, 0.0625, 0.0625),
			},
		},
		// Completed before it was created: billed, but no duration.
		{
			created: H + 1_000,
			completed: H + 400,
			model: "other-model",
			thinking: "high",
			usage: { input: 300, output: 60, totalTokens: 360, cost: cost(0.5, 0.25, 0, 0) },
		},
		{ created: H + 130_000, completed: H + 135_000, fail: true, usage: { input: 7, output: 0, totalTokens: 7 } },
	]);
	yield* run(sessionId, main, H - 60_000, "first");
	yield* run(sessionId, main, H + 120_000, "second");

	const line = yield* threads.line(main);
	const second = line.filter(({ entry }) => entry.type === "assistant" && entry.state === "committed")[1]!;
	const fork = ThreadSchema.ID.make((yield* threads.fork({ threadId: main, entryId: second.entry.id })).thread.id);
	script.set(fork, [
		{
			created: H + HOUR + 100_000,
			completed: H + HOUR + 190_000,
			usage: { input: 50, output: 5, totalTokens: 55, cost: cost(0.125, 0.125, 0, 0) },
		},
	]);
	yield* run(sessionId, fork, H + HOUR + 90_000, "fork");

	const subagent = ThreadSchema.ID.create();
	yield* threads.insert({
		id: subagent,
		sessionId,
		origin: { kind: "subagent", threadId: main, callId: "call_1_0" },
		seq: 1,
	});
	// Exactly on the first edge: the second bucket.
	script.set(subagent, [{ created: H + 5_000, completed: H + 5_250, thinking: "low" }]);
	yield* run(sessionId, subagent, H + 4_000, "subagent");

	const thread = Effect.fnUntraced(function* (callId: string) {
		const id = ThreadSchema.ID.create();
		yield* threads.insert({ id, sessionId, origin: { kind: "subagent", threadId: main, callId }, seq: 1 });
		return id;
	});
	const input = requested!;
	const healed = yield* thread("call_1_1");
	yield* crashed(
		sessionId,
		healed,
		assistant(input, 101, {
			usage: { ...assistant(input, 101).usage, input: 11, output: 3, totalTokens: 14 },
			time: { created: H + 2 * HOUR, completed: H + 2 * HOUR },
		}),
		[],
	);
	script.set(healed, [{ created: H + 10 * HOUR + 1_000, completed: H + 10 * HOUR + 3_000 }]);
	yield* run(sessionId, healed, H + 10 * HOUR, "healed");

	const recovered = yield* thread("call_1_2");
	const call = (callID: string, name: string): Message.ToolCallPendingPart => ({
		type: "toolCall",
		callID,
		name,
		arguments: { value: name },
		status: "pending",
		time: { start: H + 3 * HOUR, end: H + 3 * HOUR },
	});
	yield* crashed(
		sessionId,
		recovered,
		assistant(input, 102, {
			stopReason: "toolUse",
			parts: [call("call_ran", "echo"), call("call_unrun", "shout")],
			time: { created: H + 3 * HOUR, completed: H + 3 * HOUR + 2_000 },
		}),
		["call_ran"],
	);
	script.set(recovered, [{ created: H + 11 * HOUR + 1_000, completed: H + 11 * HOUR + 1_500 }]);
	yield* run(sessionId, recovered, H + 11 * HOUR, "recovered");

	const sql = yield* SqlClient.SqlClient;
	const [owner] = yield* sql<{ projectId: string }>`
		SELECT sp.project_id FROM session s JOIN space sp ON sp.id = s.space_id WHERE s.id = ${sessionId}
	`;
	return { sessionId, projectId: owner!.projectId, threads: { main, fork, subagent, healed, recovered } };
});

type Plain<A> = Omit<A, "rev">;
const plain = <A extends { readonly rev: number }>(rows: ReadonlyArray<A>): Array<Plain<A>> =>
	rows.map(({ rev: _rev, ...rest }) => rest);
const byKey = <A>(rows: ReadonlyArray<A>) =>
	[...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

/** Every row, read the way the sync reads them: one page wide enough for all of them. */
const rollup = Effect.gen(function* () {
	const store = yield* Store.Service;
	const { items, next } = yield* Sync.usage({ rev: 0 }, (yield* store.head).rev, 10_000);
	expect(next).toBeUndefined();
	return {
		usage: items.flatMap((item) => (item._tag === "Usage" ? [item.usage] : [])),
		tally: items.flatMap((item) => (item._tag === "Tally" ? [item.tally] : [])),
	};
});

/** The invariants the rollup holds against the thread rows and entries, per thread. */
const verify = Effect.fnUntraced(function* (
	sessionId: SessionSchema.ID,
	rows: { readonly usage: ReadonlyArray<UsageRow>; readonly tally: ReadonlyArray<TallyRow> },
) {
	const sql = yield* SqlClient.SqlClient;
	const threads = yield* sql<{
		id: string;
		cost: number;
		tokensInput: number;
		tokensOutput: number;
		tokensCacheRead: number;
		tokensCacheWrite: number;
	}>`SELECT * FROM thread WHERE session_id = ${sessionId}`;
	for (const thread of threads) {
		const own = rows.usage.filter((row) => row.threadId === thread.id);
		const sum = (pick: (row: UsageRow) => number) => own.reduce((total, row) => total + pick(row), 0);
		expect({
			cost: sum((row) => row.cost),
			input: sum((row) => row.input),
			output: sum((row) => row.output),
			cacheRead: sum((row) => row.cacheRead),
			cacheWrite: sum((row) => row.cacheWrite),
		}).toEqual({
			cost: thread.cost,
			input: thread.tokensInput,
			output: thread.tokensOutput,
			cacheRead: thread.tokensCacheRead,
			cacheWrite: thread.tokensCacheWrite,
		});
		const [counts] = yield* sql<{ prompts: number; requests: number; timed: number }>`
			SELECT
				count(*) FILTER (WHERE type = 'user' AND state = 'committed') AS prompts,
				count(*) FILTER (WHERE type = 'assistant' AND state IN ('committed', 'aborted')) AS requests,
				count(*) FILTER (
					WHERE type = 'assistant' AND state = 'committed'
						AND data ->> '$.time.completed' >= data ->> '$.time.created'
				) AS timed
			FROM entry WHERE thread_id = ${thread.id}
		`;
		const tallied = (kind: string) => rows.tally.filter((row) => row.threadId === thread.id && row.kind === kind);
		expect(tallied("prompt").reduce((total, row) => total + row.count, 0)).toBe(counts!.prompts);
		expect(sum((row) => row.requests)).toBe(counts!.requests);
		// Only committed requests are timed.
		expect(sum((row) => row.timed)).toBe(counts!.timed);
		const calls = yield* sql<{ toolName: string; calls: number }>`
			SELECT p.tool_name, count(*) AS calls FROM part p JOIN entry e ON e.id = p.entry_id
			WHERE e.thread_id = ${thread.id} AND p.type = 'toolCall' AND e.state IN ('committed', 'aborted')
				AND p.status IN ('completed', 'error')
			GROUP BY p.tool_name
		`;
		const tools = new Map<string, number>();
		for (const row of tallied("tool")) tools.set(row.name, (tools.get(row.name) ?? 0) + row.count);
		expect(Object.fromEntries(tools)).toEqual(Object.fromEntries(calls.map((row) => [row.toolName, row.calls])));
		for (const row of own) {
			expect(row.timed).toBeLessThanOrEqual(row.requests);
			expect(row.durations.reduce((total, count) => total + count, 0)).toBe(row.timed);
		}
	}
});

describe("usage rollup", () => {
	it(
		"rolls finalised entries into hourly rows that match the thread totals",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, projectId, threads } = yield* scenario;
			const rows = yield* rollup;
			yield* verify(sessionId, rows);
			expect(
				yield* sql`SELECT state FROM entry WHERE session_id = ${sessionId} AND type = 'assistant' ORDER BY seq`,
			).toEqual(
				["committed", "committed", "aborted", "committed", "committed"]
					.concat(["aborted", "committed", "committed", "committed"])
					.map((state) => ({ state })),
			);
			const at = (threadId: string, hour: number) =>
				rows.usage.filter((row) => row.threadId === threadId && row.hour === hour);
			const untimed = { timed: 0, duration: 0, durations: Array.from({ length: 24 }, () => 0) };
			// The provider failed it, and the crash healed hours later: billed, never timed.
			expect(at(threads.main, H).find((row) => row.model === "gpt-5.6-luna")).toMatchObject({
				requests: 1,
				input: 7,
				...untimed,
			});
			expect(at(threads.healed, H + 2 * HOUR)).toMatchObject([{ requests: 1, input: 11, output: 3, ...untimed }]);
			// Its response ended before the crash: timed as it streamed.
			expect(at(threads.recovered, H + 3 * HOUR)).toMatchObject([{ requests: 1, timed: 1, duration: 2_000 }]);
			expect(
				rows.tally
					.filter((row) => row.threadId === threads.recovered && row.kind === "tool")
					.map((row) => [row.name, row.count]),
			).toEqual([["echo", 1]]);
			const name = new Map<string, string>([
				[threads.main, "main"],
				[threads.fork, "fork"],
				[threads.subagent, "subagent"],
				[threads.healed, "healed"],
				[threads.recovered, "recovered"],
				[sessionId, "S1"],
				[projectId, "P1"],
			]);
			const normal = <
				A extends { hour: number; threadId: string; sessionId: string; projectId: string; rev: number },
			>(
				row: A,
			) => {
				const { rev: _rev, ...rest } = row;
				return {
					...rest,
					hour: new Date(row.hour).toISOString(),
					threadId: name.get(row.threadId),
					sessionId: name.get(row.sessionId),
					projectId: name.get(row.projectId),
				};
			};
			// Revisions move with unrelated writes; the order they give is checked, not their values.
			expect(rows.usage.map((row) => row.rev)).toEqual(rows.usage.map((row) => row.rev).sort((a, b) => a - b));
			yield* artifact("usage.rollup.json", {
				usage: byKey(rows.usage.map(normal)),
				tally: byKey(rows.tally.map(normal)),
			});
		}),
	);

	it(
		"keeps a deleted session's rows",
		Effect.gen(function* () {
			const control = yield* Control.Service;
			const sql = yield* SqlClient.SqlClient;
			const { sessionId } = yield* scenario;
			const before = yield* rollup;
			expect(yield* control.deleteSession(sessionId)).toBe(true);
			expect(yield* sql`SELECT id FROM thread WHERE session_id = ${sessionId}`).toEqual([]);
			const after = yield* rollup;
			expect(plain(after.usage)).toEqual(plain(before.usage));
			expect(plain(after.tally)).toEqual(plain(before.tally));
			expect(after.usage.every((row) => row.sessionId === sessionId)).toBe(true);
		}),
	);

	it(
		"backfills the same rows from the entries",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const store = yield* Store.Service;
			const { sessionId } = yield* scenario;
			const live = yield* rollup;
			yield* sql`DELETE FROM usage`;
			yield* sql`DELETE FROM tally`;
			const head = (yield* store.head).rev;
			yield* store.write(Usage.backfill(store.rev));
			const filled = yield* rollup;
			expect(byKey(plain(filled.usage))).toEqual(byKey(plain(live.usage)));
			expect(byKey(plain(filled.tally))).toEqual(byKey(plain(live.tally)));
			// One revision for everything it wrote.
			expect(new Set([...filled.usage, ...filled.tally].map((row) => row.rev))).toEqual(new Set([head + 1]));
			yield* verify(sessionId, filled);
		}),
	);

	it(
		"migrates entries written before the rollup, skipping an envelope it cannot read",
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const { sessionId, threads } = yield* scenario;
			const live = yield* rollup;
			yield* sql`DROP TABLE usage`;
			yield* sql`DROP TABLE tally`;
			yield* sql`UPDATE store SET rev = rev + 1`;
			yield* sql`
				INSERT INTO entry (id, session_id, thread_id, seq, committed_seq, type, state, data, created_at, updated_at, rev)
				VALUES ('legacy', ${sessionId}, ${threads.main}, 1000000, 1000000, 'assistant', 'committed', '{}', 0, 0,
					(SELECT rev FROM store))
			`;
			yield* sql.withTransaction(migrations["202611140001_usage"]);
			const migrated = yield* rollup;
			expect(byKey(plain(migrated.usage))).toEqual(byKey(plain(live.usage)));
			expect(byKey(plain(migrated.tally))).toEqual(byKey(plain(live.tally)));
		}),
	);
});
